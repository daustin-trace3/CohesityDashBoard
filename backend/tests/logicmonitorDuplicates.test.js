/**
 * LogicMonitor round 9, WP6: alerts that relay a feed ICC polls directly.
 * markDuplicateAlerts tags open lm_alerts rows with duplicate_of, the owner
 * platform must have a configured source, and the alert list, the Ops Agent
 * collector and the counters leave tagged rows out.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const netappMigrations = require('../db/migrations/netapp');
const { encrypt } = require('../services/encryption');
const dup = require('../services/logicmonitorDuplicates');

let app;
let sid;
let seq = 0;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  runMigrations(db, 'netapp', netappMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
});

beforeEach(() => {
  for (const t of ['lm_alerts', 'lm_devices', 'lm_sources', 'netapp_aiqum_instances']) db.prepare(`DELETE FROM ${t}`).run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
});

function alert(ds, over = {}) {
  seq += 1;
  db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name,
      instance_name, data_point_name, alert_value, start_epoch, cleared, condition_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'i', 'dp', '1', ?, ?, ?)`)
    .run(sid, `A${seq}`, over.sev || 3, over.norm || 'warning', over.deviceId ?? null, over.object || 'obj', ds,
      Math.floor(Date.now() / 1000) - 600, over.cleared ? 1 : 0, `k${seq}`);
  return `A${seq}`;
}
const dupOf = (id) => db.prepare('SELECT duplicate_of d FROM lm_alerts WHERE lm_alert_id = ?').get(id).d;
const addAiqum = () => db.prepare("INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials) VALUES ('aiq', 'h', 'u', 'x')").run();

describe('ownerForDatasource', () => {
  it('maps the relayed DataSource families to a platform', () => {
    expect(dup.ownerForDatasource('ntm_aiqum_alerts').platform).toBe('netapp');
    expect(dup.ownerForDatasource('Cohesity_Cluster_Alerts').platform).toBe('cohesity');
    expect(dup.ownerForDatasource('ntm_cohesity_node').platform).toBe('cohesity');
    expect(dup.ownerForDatasource('VMware_vCenter_Datastore_Usage').platform).toBe('vcenter');
    expect(dup.ownerForDatasource('Zerto_VPG_Status').platform).toBe('zerto');
    expect(dup.ownerForDatasource('Brocade_FC_Ports').platform).toBe('brocade');
    expect(dup.ownerForDatasource('Cisco_CPU_SNMP')).toBeNull();
    expect(dup.ownerForDatasource('')).toBeNull();
  });
});

describe('markDuplicateAlerts', () => {
  it('tags a relayed alert only when the owner platform has a source', () => {
    const a = alert('ntm_aiqum_alerts');
    const plain = alert('Cisco_CPU_SNMP');
    expect(dup.markDuplicateAlerts(db).marked).toBe(0);
    expect(dupOf(a)).toBeNull();
    addAiqum();
    const r = dup.markDuplicateAlerts(db);
    expect(r.marked).toBe(1);
    expect(r.byPlatform).toEqual({ netapp: 1 });
    expect(dupOf(a)).toBe('duplicate:netapp');
    expect(dupOf(plain)).toBeNull();
  });

  it('is idempotent and drops the mark when the owner source goes away', () => {
    addAiqum();
    const a = alert('ntm_aiqum_alerts');
    dup.markDuplicateAlerts(db);
    expect(dup.markDuplicateAlerts(db).marked).toBe(0);
    expect(dupOf(a)).toBe('duplicate:netapp');
    db.prepare('DELETE FROM netapp_aiqum_instances').run();
    const r = dup.markDuplicateAlerts(db);
    expect(r.cleared).toBe(1);
    expect(dupOf(a)).toBeNull();
  });

  it('does not tag cleared alerts and clears the mark when an alert clears', () => {
    addAiqum();
    const a = alert('ntm_aiqum_alerts');
    const c = alert('ntm_aiqum_alerts', { cleared: true });
    dup.markDuplicateAlerts(db);
    expect(dupOf(a)).toBe('duplicate:netapp');
    expect(dupOf(c)).toBeNull();
    db.prepare('UPDATE lm_alerts SET cleared = 1 WHERE lm_alert_id = ?').run(a);
    dup.markDuplicateAlerts(db);
    expect(dupOf(a)).toBeNull();
  });

  it('summarises open duplicates by owner', () => {
    addAiqum();
    alert('ntm_aiqum_alerts');
    alert('ntm_aiqum_alerts');
    dup.markDuplicateAlerts(db);
    const s = dup.duplicateSummary(db);
    expect(s.total).toBe(2);
    expect(s.byPlatform[0]).toMatchObject({ platform: 'netapp', count: 2 });
  });
});

describe('where duplicates are left out', () => {
  it('the alert list hides them by default, shows them with duplicate=1 and counts them in the chip', async () => {
    addAiqum();
    const d = alert('ntm_aiqum_alerts');
    alert('Cisco_CPU_SNMP', { sev: 4, norm: 'critical' });
    dup.markDuplicateAlerts(db);
    const base = await request(app).get('/api/logicmonitor/alerts');
    expect(base.status).toBe(200);
    expect(base.body.items.map((x) => x.datasource)).toEqual(['Cisco_CPU_SNMP']);
    expect(base.body.counts.warning).toBe(0);
    expect(base.body.counts.critical).toBe(1);
    expect(base.body.duplicates.total).toBe(1);
    expect(base.body.duplicates.byPlatform[0].platform).toBe('netapp');
    const only = await request(app).get('/api/logicmonitor/alerts?duplicate=1');
    expect(only.body.items).toHaveLength(1);
    expect(only.body.items[0].id).toBe(d);
    expect(only.body.items[0].duplicateOf).toBe('duplicate:netapp');
    const all = await request(app).get('/api/logicmonitor/alerts?duplicate=all');
    expect(all.body.items).toHaveLength(2);
  });

  it('collectAlerts (Ops Agent, notifier) skips duplicates', () => {
    addAiqum();
    alert('ntm_aiqum_alerts', { sev: 4, norm: 'critical' });
    alert('Cisco_CPU_SNMP', { sev: 4, norm: 'critical' });
    dup.markDuplicateAlerts(db);
    const platform = require('../platforms/logicmonitor');
    const items = platform.collectAlerts({ db });
    const types = items.map((i) => i.type).filter((t) => /aiqum|Cisco/i.test(t));
    expect(types).toEqual(['Cisco_CPU_SNMP']);
  });
});
