/**
 * Service groups on the Ops page: timeline rows on state change, the board
 * folding, per-day events, the LM-off case and the route guards.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const registry = require('../core/registry');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const svc = require('../services/serviceStatus');
const router = require('../routes/serviceStatus');
const { seedServiceGroupsHistory } = require('../demo/scenarios/serviceGroupsStatus');

let app;
beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  app = express();
  app.use('/api/service-status', router);
});

const TABLES = ['lm_issue_history', 'lm_alerts', 'lm_device_groups', 'lm_devices', 'lm_sources', 'service_group_status_timeline'];

function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid;
}

let nextDev = 100;
function dev(sid, groupId) {
  nextDev += 1;
  ins('lm_devices', {
    source_id: sid, lm_device_id: nextDev, name: `10.0.0.${nextDev}`, display_name: `dev${nextDev}`, host_status: 'normal',
    sdt_status: 'none-none-none', group_ids_json: `[${groupId}]`, is_network: 0,
  });
  return nextDev;
}
function critAlert(sid, devId) {
  nextDev += 1;
  return ins('lm_alerts', {
    source_id: sid, lm_alert_id: `A${nextDev}`, type: 'dataSourceAlert', severity: 4, severity_norm: 'critical',
    lm_device_id: devId, resource_template_name: 'Cisco_CPU', cleared: 0, condition_key: `k${nextDev}`,
  });
}

let sid;
let coreDev;
beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  registry._reset();
  registry.init();
  registry.registerPlugin({ id: 'logicmonitor', name: 'LogicMonitor', apiVersion: 1, createRouter: () => (q, s, n) => n() });
  sid = ins('lm_sources', { name: 'Acme', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: encrypt('{}') });
  ins('lm_device_groups', { source_id: sid, lm_group_id: 1, parent_id: 0, name: 'root', full_path: 'root' });
  ins('lm_device_groups', { source_id: sid, lm_group_id: 10, parent_id: 1, name: 'Core', full_path: 'Core' });
  ins('lm_device_groups', { source_id: sid, lm_group_id: 11, parent_id: 1, name: 'Branch', full_path: 'Branch' });
  coreDev = dev(sid, 10);
  dev(sid, 10);
  dev(sid, 11);
  setSetting('lm_service_groups', JSON.stringify([{ sourceId: sid, groupId: 10 }, { sourceId: sid, groupId: 11 }]));
});

const rowsOf = (id) => db.prepare('SELECT state, at FROM service_group_status_timeline WHERE service_id = ? ORDER BY at, id').all(id);

describe('recomputeServiceStates', () => {
  it('writes one row per state change and nothing when the state holds', () => {
    svc.recomputeServiceStates(new Date(Date.now() - 2 * 3600000).toISOString());
    svc.recomputeServiceStates(new Date(Date.now() - 3600000).toISOString());
    expect(rowsOf(`${sid}-10`).map((r) => r.state)).toEqual(['ok']);
    expect(rowsOf(`${sid}-11`).map((r) => r.state)).toEqual(['ok']);

    critAlert(sid, coreDev);
    svc.recomputeServiceStates(new Date().toISOString());
    const core = rowsOf(`${sid}-10`);
    expect(core.length).toBe(2);
    expect(core[1].state).not.toBe('ok');
    expect(rowsOf(`${sid}-11`).length).toBe(1);
  });

  it('writes nothing when LogicMonitor is off', () => {
    registry._reset();
    registry.init();
    svc.recomputeServiceStates(new Date().toISOString());
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_group_status_timeline').get().n).toBe(0);
    const board = svc.getServicesBoard({ days: 30 });
    expect(board).toMatchObject({ services: [], logicmonitorEnabled: false });
  });
});

describe('getServicesBoard and events', () => {
  it('folds days, last state wins, today matches current', () => {
    const now = Date.now();
    const id = `${sid}-10`;
    const ins2 = db.prepare('INSERT INTO service_group_status_timeline (service_id, label, state, at, reason, counts_json) VALUES (?, ?, ?, ?, ?, ?)');
    ins2.run(id, 'Core', 'ok', new Date(now - 5 * 86400000).toISOString(), 'x', '{}');
    ins2.run(id, 'Core', 'degraded', new Date(now - 2 * 86400000).toISOString(), 'x', '{}');
    ins2.run(id, 'Core', 'ok', new Date(now - 3600000).toISOString(), 'x', '{}');
    const board = svc.getServicesBoard({ days: 7 });
    expect(board.logicmonitorEnabled).toBe(true);
    expect(board.picked).toBe(2);
    const core = board.services.find((s) => s.serviceId === id);
    expect(core.route).toBe(`/logicmonitor/services/${id}`);
    expect(core.days).toHaveLength(7);
    expect(core.days[0].state).toBe('unknown');
    const day = (msAgo) => core.days.find((d) => d.date === new Date(now - msAgo).toISOString().slice(0, 10));
    expect(day(5 * 86400000).state).toBe('ok');
    expect(day(2 * 86400000).state).toBe('degraded');
    expect(day(2 * 86400000).changes).toBe(1);
    expect(core.days[core.days.length - 1].state).toBe('ok');
    expect(core.current.state).toBe('ok');
    expect(core.current.counts.total).toBe(2);
    const other = board.services.find((s) => s.serviceId === `${sid}-11`);
    expect(other.days.every((d) => d.state === 'unknown')).toBe(true);
  });

  it('lists the transitions of one day', () => {
    const id = `${sid}-10`;
    db.prepare('INSERT INTO service_group_status_timeline (service_id, label, state, at, reason, counts_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'Core', 'failed', '2026-10-01T10:00:00.000Z', 'down', '{"crit":1}');
    expect(svc.listServiceEvents({ serviceId: id, date: '2026-10-01' })).toEqual([
      expect.objectContaining({ state: 'failed', reason: 'down', counts: { crit: 1 } }),
    ]);
    expect(svc.listServiceEvents({ serviceId: id, date: '2026-10-02' })).toEqual([]);
  });
});

describe('routes', () => {
  it('serves the board and validates the events query', async () => {
    const res = await request(app).get('/api/service-status/services?days=7');
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(2);
    expect((await request(app).get(`/api/service-status/services/${sid}-10/events?date=bad`)).status).toBe(400);
    expect((await request(app).get('/api/service-status/services/nope/events?date=2026-10-01')).status).toBe(404);
    const ok = await request(app).get(`/api/service-status/services/${sid}-10/events?date=2026-10-01`);
    expect(ok.status).toBe(200);
    expect(ok.body.events).toEqual([]);
  });
});

describe('demo seed', () => {
  it('ends on the live state and is idempotent', () => {
    const first = seedServiceGroupsHistory(db, { now: Date.now() });
    expect(first.services).toBe(2);
    const again = seedServiceGroupsHistory(db, { now: Date.now() });
    expect(again.rows).toBe(first.rows);
    const rows = rowsOf(`${sid}-10`);
    expect(rows[rows.length - 1].state).toBe('ok');
    expect(rows.some((r) => r.state === 'failed')).toBe(true);
  });
});
