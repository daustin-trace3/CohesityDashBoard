/**
 * LogicMonitor round 11, WP-R: raw DataSource ingestion. storeRawBody over bodies shaped like
 * the live responses (datapoint names come from tests/fixtures/lm-live-datapoints.json),
 * the candidate rule, pollMetrics with fetchDsData stubbed, and the four read routes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
import fixture from './fixtures/lm-live-datapoints.json';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const lmApi = require('../services/logicmonitorApi');
const metrics = require('../services/logicmonitorMetrics');
const raw = require('../services/logicmonitorRaw');

const TABLES = ['lm_ds_values', 'lm_ds_datapoints', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_device_datasources', 'lm_devices', 'lm_sources'];
const now = () => Math.floor(Date.now() / 1000);
const NOW_ISO = '2026-10-16 12:00:00';

let app;
beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
});
beforeEach(() => { for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run(); });

function insertSource(o = {}) {
  return db.prepare(`
    INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, metrics_poll_minutes, raw_poll_enabled, raw_calls_per_tick, raw_history_json)
    VALUES ('portal1', 'acme', 'lmv1', 'x', 30, ?, ?, ?)
  `).run(o.raw ?? 1, o.cap ?? 600, o.history ? JSON.stringify(o.history) : null).lastInsertRowid;
}
const sourceRow = (id) => db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(id);
function insertDevice(sid, id, name = `dev${id}`) {
  db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, is_network, stale) VALUES (?, ?, ?, ?, 1, 0)').run(sid, id, name, name);
}
function insertDs(sid, dev, hds, name, o = {}) {
  db.prepare(`
    INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_name, instance_count, stop_monitoring, is_interface, is_neighbor, metrics_last_at, raw_last_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(sid, dev, hds, name, o.instances ?? 1, o.isInterface ?? 0, o.isNeighbor ?? 0, o.metricsLast ?? null, o.rawLast ?? null);
}

/** Body shaped like /device/devices/{d}/devicedatasources/{h}/data from a fixture DataSource. */
function bodyFor(ds, instances, valuesFor) {
  const dataPoints = fixture[ds] || ['Alpha', 'Beta', 'Gamma'];
  const t = now();
  const inst = {};
  for (const key of instances) {
    inst[`${ds}-${key} [ID:${Math.abs(key.length * 7)}]`] = {
      time: [(t - 120) * 1000, (t - 60) * 1000],
      values: [dataPoints.map((_, i) => valuesFor(key, i, 0)), dataPoints.map((_, i) => valuesFor(key, i, 1))],
    };
  }
  return { dataSourceName: ds, dataPoints, instances: inst };
}

describe('storeRawBody', () => {
  const cand = (sid, dev, hds, ds) => ({ lm_device_id: dev, hds_id: hds, datasource_name: ds });

  it('stores the last non-null sample as a number or text and skips No Data', () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 11, 'F5_BigIP_Memory');
    const dps = fixture.F5_BigIP_Memory;
    const t = now();
    const body = {
      dataSourceName: 'F5_BigIP_Memory',
      dataPoints: dps,
      instances: {
        'F5_BigIP_Memory-Global [ID:1]': {
          time: [(t - 120) * 1000, (t - 60) * 1000],
          // col 0: newest is null so the older value 10 wins; col 1 text; col 2 No Data on both; rest 5 then 6.
          values: [dps.map((_, i) => (i === 0 ? 10 : i === 1 ? 'degraded' : i === 2 ? 'No Data' : 5)),
            dps.map((_, i) => (i === 0 ? null : i === 1 ? 'healthy' : i === 2 ? 'No Data' : 6))],
        },
      },
    };
    const r = raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 11, 'F5_BigIP_Memory'), body, NOW_ISO, { nowEpoch: t });
    expect(r.instances).toBe(1);
    expect(r.values).toBe(dps.length - 1);
    const rows = Object.fromEntries(db.prepare('SELECT datapoint, value, value_text, instance_key, instance_name FROM lm_ds_values WHERE source_id = ?').all(sid).map((x) => [x.datapoint, x]));
    expect(rows[dps[0]].value).toBe(10);
    expect(rows[dps[1]].value).toBeNull();
    expect(rows[dps[1]].value_text).toBe('healthy');
    expect(rows[dps[2]]).toBeUndefined();
    expect(rows[dps[3]].value).toBe(6);
    expect(rows[dps[0]].instance_key).toBe('Global');
    expect(rows[dps[0]].instance_name).toBe('Global');
    expect(db.prepare('SELECT raw_last_at, raw_last_error FROM lm_device_datasources WHERE hds_id = 11').get()).toEqual({ raw_last_at: NOW_ISO, raw_last_error: null });
  });

  it('deletes instances the body no longer lists and keeps the other devices', () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDevice(sid, 2);
    insertDs(sid, 1, 11, 'Custom_Widget');
    insertDs(sid, 2, 12, 'Custom_Widget');
    const v = (k, i) => 1 + i;
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 11, 'Custom_Widget'), bodyFor('Custom_Widget', ['a', 'b'], v), NOW_ISO);
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 2, 12, 'Custom_Widget'), bodyFor('Custom_Widget', ['z'], v), NOW_ISO);
    expect(db.prepare('SELECT COUNT(DISTINCT instance_key) c FROM lm_ds_values WHERE hds_id = 11').get().c).toBe(2);
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 11, 'Custom_Widget'), bodyFor('Custom_Widget', ['a'], v), NOW_ISO);
    expect(db.prepare('SELECT instance_key FROM lm_ds_values WHERE hds_id = 11 GROUP BY instance_key').all().map((x) => x.instance_key)).toEqual(['a']);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_values WHERE hds_id = 12').get().c).toBe(3);
  });

  it('caps one body at RAW_MAX_INSTANCES (first by name) and says so in raw_last_error', () => {
    expect(raw.RAW_MAX_INSTANCES).toBe(2000);
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 21, 'F5_GTM_VIPs-');
    const keys = Array.from({ length: 2100 }, (_, i) => `vip${String(i).padStart(4, '0')}`);
    const body = bodyFor('F5_GTM_VIPs-', keys, () => 1);
    const r = raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 21, 'F5_GTM_VIPs-'), body, NOW_ISO);
    expect(r.capped).toBe(2100);
    expect(r.instances).toBe(2000);
    expect(db.prepare('SELECT COUNT(DISTINCT instance_key) c FROM lm_ds_values WHERE hds_id = 21').get().c).toBe(2000);
    expect(db.prepare("SELECT COUNT(*) c FROM lm_ds_values WHERE hds_id = 21 AND instance_key = 'vip2050'").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM lm_ds_values WHERE hds_id = 21 AND instance_key = 'vip1999'").get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT raw_last_error e FROM lm_device_datasources WHERE hds_id = 21').get().e).toBe('capped 2100 to 2000');
  });

  it('appends history only for DataSource:datapoint pairs in raw_history_json', () => {
    const dps = fixture.F5_BigIP_Memory;
    const sid = insertSource({ history: [`F5_BigIP_Memory:${dps[0]}`] });
    insertDevice(sid, 1);
    insertDs(sid, 1, 31, 'F5_BigIP_Memory');
    const body = bodyFor('F5_BigIP_Memory', ['Global'], (k, i, s) => 10 + s);
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 31, 'F5_BigIP_Memory'), body, NOW_ISO);
    const h = db.prepare('SELECT metric, value FROM lm_ds_metrics_history WHERE source_id = ? ORDER BY sampled_at_epoch').all(sid);
    expect(h).toEqual([{ metric: `raw:${dps[0]}`, value: 10 }, { metric: `raw:${dps[0]}`, value: 11 }]);
    // Same samples again add nothing.
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 31, 'F5_BigIP_Memory'), body, NOW_ISO);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metrics_history WHERE source_id = ?').get(sid).c).toBe(2);
  });

  it('stores 450 instances in chunks and still deletes a vanished instance', () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 51, 'Custom_Widget');
    const keys = Array.from({ length: 450 }, (_, i) => `inst${i}`);
    const v = (k, i) => 1 + i;
    const r = raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 51, 'Custom_Widget'), bodyFor('Custom_Widget', keys, v), NOW_ISO);
    expect(r.instances).toBe(450);
    expect(db.prepare('SELECT COUNT(DISTINCT instance_key) c FROM lm_ds_values WHERE hds_id = 51').get().c).toBe(450);
    expect(r.values).toBe(db.prepare('SELECT COUNT(*) c FROM lm_ds_values WHERE hds_id = 51').get().c);
    // Second body drops inst449: the delete runs after the chunks.
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 51, 'Custom_Widget'), bodyFor('Custom_Widget', keys.slice(0, 449), v), NOW_ISO);
    expect(db.prepare("SELECT COUNT(*) c FROM lm_ds_values WHERE hds_id = 51 AND instance_key = 'inst449'").get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(DISTINCT instance_key) c FROM lm_ds_values WHERE hds_id = 51').get().c).toBe(449);
  });

  it('honours the prefetched history floor: samples at or below it are not inserted', () => {
    const dps = fixture.F5_BigIP_Memory;
    const sid = insertSource({ history: [`F5_BigIP_Memory:${dps[0]}`] });
    insertDevice(sid, 1);
    insertDs(sid, 1, 52, 'F5_BigIP_Memory');
    const t = now();
    const body = bodyFor('F5_BigIP_Memory', ['Global'], (k, i, s) => 20 + s);
    // Floor is newer than the older sample (t-120) and older than the newer one (t-60).
    db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, 1, 52, ?, ?, 1, ?)')
      .run(sid, 'Global', `raw:${dps[0]}`, t - 90);
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 52, 'F5_BigIP_Memory'), body, NOW_ISO, { nowEpoch: t });
    const h = db.prepare('SELECT value, sampled_at_epoch e FROM lm_ds_metrics_history WHERE source_id = ? ORDER BY e').all(sid);
    expect(h.length).toBe(2);
    expect(h[1].value).toBe(21);
  });

  it('aggregates lm_ds_datapoints per DataSource and flags catalog picks', () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDevice(sid, 2);
    insertDs(sid, 1, 41, 'Custom_Widget');
    insertDs(sid, 2, 42, 'Custom_Widget');
    const v = () => 3;
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 1, 41, 'Custom_Widget'), bodyFor('Custom_Widget', ['a', 'b'], v), NOW_ISO, { learned: { alpha_metric: 'Alpha' } });
    raw.storeRawBody(db, sourceRow(sid), cand(sid, 2, 42, 'Custom_Widget'), bodyFor('Custom_Widget', ['a'], v), NOW_ISO, { learned: { alpha_metric: 'Alpha' } });
    const rows = Object.fromEntries(db.prepare('SELECT * FROM lm_ds_datapoints WHERE source_id = ?').all(sid).map((r) => [r.datapoint, r]));
    expect(Object.keys(rows).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(rows.Alpha).toMatchObject({ devices: 2, instances: 3, numeric: 1, catalog_metric: 'alpha_metric' });
    expect(rows.Beta.catalog_metric).toBeNull();
  });
});

describe('candidate rule', () => {
  it('raw on: every DataSource with instances, minus interface and neighbour tiers, oldest first', () => {
    const sid = insertSource({ raw: 1 });
    insertDevice(sid, 1);
    insertDs(sid, 1, 1, 'Custom_Widget');
    insertDs(sid, 1, 2, 'F5_BigIP_Memory', { metricsLast: '2026-09-01 00:00:00' });
    insertDs(sid, 1, 3, 'Custom_Other', { rawLast: '2026-10-01 00:00:00' });
    insertDs(sid, 1, 4, 'F5_BigIP_System', { metricsLast: '2026-10-10 00:00:00', rawLast: '2026-09-15 00:00:00' });
    insertDs(sid, 1, 5, 'SNMP_Network_Interfaces', { isInterface: 1 });
    insertDs(sid, 1, 6, 'LLDP_Neighbors', { isNeighbor: 1 });
    insertDs(sid, 1, 7, 'Custom_Empty', { instances: 0 });
    const rows = metrics.candidateRows(sourceRow(sid));
    // never polled first, then raw_last_at (else metrics_last_at) ascending.
    expect(rows.map((r) => r.hds_id)).toEqual([1, 2, 4, 3]);
    expect(rows.find((r) => r.hds_id === 1).entry).toBeNull();
    expect(rows.find((r) => r.hds_id === 2).entry.family).toBe('loadbalancer');
  });

  it('raw off: catalog DataSources only, ordered by the catalog poll time', () => {
    const sid = insertSource({ raw: 0 });
    insertDevice(sid, 1);
    insertDs(sid, 1, 1, 'Custom_Widget');
    insertDs(sid, 1, 2, 'F5_BigIP_Memory', { metricsLast: '2026-09-01 00:00:00' });
    insertDs(sid, 1, 3, 'F5_BigIP_System');
    expect(metrics.candidateRows(sourceRow(sid)).map((r) => r.hds_id)).toEqual([3, 2]);
  });

  it('the per-source cap wins; raw off falls back to the catalog cap', () => {
    expect(metrics.callCap({ raw_poll_enabled: 1, raw_calls_per_tick: 123 })).toBe(123);
    expect(metrics.callCap({ raw_poll_enabled: 1, raw_calls_per_tick: null })).toBe(600);
    expect(metrics.callCap({ raw_poll_enabled: 0, raw_calls_per_tick: 123 })).toBe(300);
    expect(metrics.rawEnabled({ raw_poll_enabled: null })).toBe(true);
    expect(metrics.rawEnabled({ raw_poll_enabled: 0 })).toBe(false);
  });
});

describe('pollMetrics in raw mode (stubbed fetch, no network)', () => {
  let spy;
  afterEach(() => { if (spy) spy.mockRestore(); spy = null; });

  it('stores catalog and uncatalogued DataSources from one call each, never narrowed', async () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 51, 'NetSNMPCPUwithCores');
    insertDs(sid, 1, 52, 'Custom_Widget');
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async (s, dev, hds) => (hds === 51
      ? bodyFor('NetSNMPCPUwithCores', ['Total'], (k, i) => (fixture.NetSNMPCPUwithCores[i] === 'CPUBusyPercent' ? 37 : 1))
      : bodyFor('Custom_Widget', ['x', 'y'], (k, i) => (i === 2 ? 'Up' : i + 1))));
    const r1 = await metrics.pollMetrics(sourceRow(sid));
    expect(r1.ok).toBe(2);
    expect(r1.rawDataSources).toBe(2);
    expect(r1.rawValues).toBe(fixture.NetSNMPCPUwithCores.length + 6);
    expect(db.prepare("SELECT value FROM lm_ds_metrics WHERE source_id = ? AND metric = 'cpu_pct'").get(sid).value).toBe(37);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_values WHERE source_id = ? AND hds_id = 52').get(sid).c).toBe(6);
    const mark = db.prepare('SELECT hds_id, metrics_last_at m, raw_last_at r FROM lm_device_datasources ORDER BY hds_id').all();
    expect(mark[0].m).not.toBeNull();
    expect(mark[0].r).not.toBeNull();
    expect(mark[1].m).toBeNull(); // raw-only row: the catalog timestamp stays empty
    expect(mark[1].r).not.toBeNull();
    // The catalog pick is labelled in the datapoint catalog; the widget datapoints are not.
    expect(db.prepare("SELECT catalog_metric c FROM lm_ds_datapoints WHERE datasource_name = 'NetSNMPCPUwithCores' AND datapoint = 'CPUBusyPercent'").get().c).toBe('cpu_pct');
    expect(db.prepare("SELECT catalog_metric c FROM lm_ds_datapoints WHERE datasource_name = 'Custom_Widget' AND datapoint = 'Alpha'").get().c).toBeNull();
    // Second run is still un-narrowed.
    await metrics.pollMetrics(sourceRow(sid));
    for (const c of spy.mock.calls) expect(c[3].datapoints).toBeNull();
  });

  it('a failing DataSource gets raw_last_error and moves to the back of the queue without failing the tick', async () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 61, 'Custom_Widget');
    insertDs(sid, 1, 62, 'Custom_Other');
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async (s, dev, hds) => {
      if (hds === 61) throw new Error('boom 500');
      return bodyFor('Custom_Other', ['k'], () => 2);
    });
    const r = await metrics.pollMetrics(sourceRow(sid));
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(1);
    const bad = db.prepare('SELECT raw_last_at, raw_last_error FROM lm_device_datasources WHERE hds_id = 61').get();
    expect(bad.raw_last_error).toMatch(/boom/);
    expect(bad.raw_last_at).not.toBeNull();
    expect(db.prepare('SELECT raw_last_error e FROM lm_device_datasources WHERE hds_id = 62').get().e).toBeNull();
  });

  it('honours raw_calls_per_tick', async () => {
    const sid = insertSource({ cap: 2 });
    insertDevice(sid, 1);
    for (let i = 1; i <= 5; i += 1) insertDs(sid, 1, 70 + i, `Custom_${i}`);
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async () => bodyFor('Custom_X', ['k'], () => 1));
    const r = await metrics.pollMetrics(sourceRow(sid));
    expect(r.candidates).toBe(5);
    expect(r.polled).toBe(2);
    expect(spy.mock.calls.length).toBe(2);
  });
});

describe('raw routes', () => {
  const API = '/api/logicmonitor';

  function seedStored() {
    const sid = insertSource();
    insertDevice(sid, 101, 'core-sw1');
    insertDs(sid, 101, 91, 'NetSNMPCPUwithCores');
    insertDs(sid, 101, 92, 'Custom_Widget');
    const body1 = bodyFor('NetSNMPCPUwithCores', ['Total'], (k, i) => (fixture.NetSNMPCPUwithCores[i] === 'CPUBusyPercent' ? 41 : 2));
    const learned = { cpu_pct: 'CPUBusyPercent' };
    raw.storeRawBody(db, sourceRow(sid), { lm_device_id: 101, hds_id: 91, datasource_name: 'NetSNMPCPUwithCores' }, body1, NOW_ISO, { learned });
    raw.storeRawBody(db, sourceRow(sid), { lm_device_id: 101, hds_id: 92, datasource_name: 'Custom_Widget' }, bodyFor('Custom_Widget', ['x', 'y'], (k, i) => (i === 1 ? 'Up' : 5)), NOW_ISO);
    return sid;
  }

  it('GET /devices/:id/datasources lists DataSources with family, coverage inputs and last raw', async () => {
    seedStored();
    const res = await request(app).get(`${API}/devices/101/datasources`);
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.map((r) => [r.datasourceName, r]));
    expect(by.NetSNMPCPUwithCores).toMatchObject({ hdsId: 91, family: 'health', datapoints: fixture.NetSNMPCPUwithCores.length, instances: 1 });
    expect(by.Custom_Widget).toMatchObject({ family: null, datapoints: 3, instances: 2, rawLastError: null });
    expect(by.Custom_Widget.rawLastAt).toBe('2026-10-16T12:00:00.000Z');
    expect((await request(app).get(`${API}/devices/999/datasources`)).status).toBe(404);
  });

  it('GET /devices/:id/datasources/:hds/values pages, searches and labels catalog picks', async () => {
    seedStored();
    const all = await request(app).get(`${API}/devices/101/datasources/91/values?limit=5&page=2`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(fixture.NetSNMPCPUwithCores.length);
    expect(all.body.items).toHaveLength(5);
    expect(all.body).toMatchObject({ page: 2, limit: 5 });
    const hit = await request(app).get(`${API}/devices/101/datasources/91/values?q=CPUBusy`);
    expect(hit.body.items).toHaveLength(1);
    expect(hit.body.items[0]).toMatchObject({ instanceKey: 'Total', datapoint: 'CPUBusyPercent', value: 41, valueText: null, catalogMetric: 'cpu_pct' });
    expect(hit.body.items[0].label).toBeTruthy();
    expect(hit.body.items[0].sampledAt).toMatch(/Z$/);
    const txt = await request(app).get(`${API}/devices/101/datasources/92/values?q=Beta`);
    expect(txt.body.items.map((i) => [i.instanceKey, i.valueText, i.label])).toEqual([['x', 'Up', null], ['y', 'Up', null]]);
    expect((await request(app).get(`${API}/devices/101/datasources/91/values?limit=9999`)).status).toBe(400);
  });

  it('GET /datasources rolls up per name with coverage and has a csv twin', async () => {
    seedStored();
    const res = await request(app).get(`${API}/datasources`);
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.map((r) => [r.name, r]));
    expect(by.NetSNMPCPUwithCores).toMatchObject({ devices: 1, family: 'health', picks: 1, datapoints: fixture.NetSNMPCPUwithCores.length });
    expect(by.NetSNMPCPUwithCores.coveragePct).toBe(Math.round((1 / fixture.NetSNMPCPUwithCores.length) * 1000) / 10);
    expect(by.Custom_Widget).toMatchObject({ family: null, picks: 0, coveragePct: 0 });
    const csv = await request(app).get(`${API}/datasources.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('name,displayName,family,devices,instances,datapoints,picks,coveragePct,polledDevices,rawLastAt');
  });

  it('GET /datasources/:name/datapoints returns names, shapes and up to three samples', async () => {
    seedStored();
    const res = await request(app).get(`${API}/datasources/Custom_Widget/datapoints`);
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.datapoint)).toEqual(['Alpha', 'Beta', 'Gamma']);
    const beta = res.body.find((d) => d.datapoint === 'Beta');
    expect(beta).toMatchObject({ numeric: false, instances: 2, catalogMetric: null });
    expect(beta.samples).toEqual(['Up']);
    const alpha = res.body.find((d) => d.datapoint === 'Alpha');
    expect(alpha.numeric).toBe(true);
  });

  it('settings/discovery carries the raw block', async () => {
    seedStored();
    db.prepare("UPDATE lm_device_datasources SET raw_last_at = '2020-01-01 00:00:00' WHERE hds_id = 91").run();
    db.prepare("UPDATE lm_device_datasources SET raw_last_at = ? WHERE hds_id = 92").run(new Date().toISOString().slice(0, 19).replace('T', ' '));
    const res = await request(app).get(`${API}/settings/discovery`);
    expect(res.status).toBe(200);
    expect(res.body.raw).toMatchObject({ enabled: true, callsPerTick: 600, candidates: 2, sweptLast24h: 1, datapoints: fixture.NetSNMPCPUwithCores.length + 3 });
    expect(res.body.raw.values).toBe(fixture.NetSNMPCPUwithCores.length + 6);
    expect(res.body.raw.coveragePct).toBeGreaterThan(0);
    expect(res.body.raw.estSweepHours).toBe(0);
  });

  it('PUT /sources/:id stores the raw switches and the history list', async () => {
    const sid = insertSource();
    const res = await request(app).put(`${API}/sources/${sid}`).send({ rawPollEnabled: false, rawCallsPerTick: 900, rawHistory: ['F5_BigIP_Memory:MemBuffer', 'F5_BigIP_Memory:MemBuffer'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rawPollEnabled: false, rawCallsPerTick: 900, rawHistory: ['F5_BigIP_Memory:MemBuffer'] });
    expect((await request(app).put(`${API}/sources/${sid}`).send({ rawCallsPerTick: 5 })).status).toBe(400);
  });
});
