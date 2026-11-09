/**
 * LogicMonitor hardware health (logicmonitorHardware.js): state mapping, redundancy lost, thermal outliers, switchovers.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const hw = require('../services/logicmonitorHardware');

let SID;
beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });
beforeEach(() => {
  for (const t of ['lm_trend_findings', 'lm_ds_metrics', 'lm_ds_instances', 'lm_devices', 'lm_sites', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
  SID = db.prepare("INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES ('p1', 'acme', 'lmv1', 'x')").run().lastInsertRowid;
});

function dev(id, name, o = {}) {
  db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, model, vendor_key, vendor_kind, site_key, host_status, is_network, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)')
    .run(SID, id, name, name, o.model || 'C9300', o.vendorKey || 'cisco', 'switch', o.site || 'phx', o.host || 'normal');
}
let hds = 1;
function metric(devId, ds, key, name, m, value) {
  db.prepare("INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name) VALUES (?, ?, ?, ?, 'health', ?, ?)").run(SID, devId, hds, ds, key, name);
  db.prepare('INSERT INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, \'health\', ?, ?, ?, ?)')
    .run(SID, devId, hds, ds, key, m, value, Math.floor(Date.now() / 1000));
  hds += 1;
}

describe('state mapping', () => {
  it('maps the Cisco and F5 enums', () => {
    expect(hw.stateOf('psu_state', 1, 'cisco')).toBe('ok');
    expect(hw.stateOf('psu_state', 3, 'cisco')).toBe('failed');
    expect(hw.stateOf('psu_state', 5, 'cisco')).toBe('unknown');
    expect(hw.stateOf('psu_state', 2, 'f5')).toBe('unknown');
    expect(hw.stateOf('psu_state', 0, 'f5')).toBe('failed');
    expect(hw.stateOf('sup_state', 14, 'cisco')).toBe('ok');
    expect(hw.stateOf('stack_member_state', 4, 'cisco')).toBe('ok');
    expect(hw.stateOf('stack_member_state', 11, 'cisco')).toBe('failed');
    expect(hw.stateOf('stack_port_state', 2, 'cisco')).toBe('failed');
    expect(hw.stateOf('sensor_state', 2, 'cisco')).toBe('unknown');
  });
});

describe('components and derived', () => {
  it('lists components worst first and drops healthy entity sensors', () => {
    dev(1, 'a');
    metric(1, 'Cisco_FRU_Power', 'PS1', 'Power Supply 1', 'psu_state', 1);
    metric(1, 'Cisco_FRU_Power', 'PS2', 'Power Supply 2', 'psu_state', 3);
    metric(1, 'Cisco_Entity_Sensors', 's1', 'Sensor 1', 'sensor_state', 1);
    const rows = hw.components(db, { vendorKey: 'cisco' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: 'failed', component: 'psu', instance: 'Power Supply 2' });
  });

  it('flags lost redundancy on a live device only, with the stack ring and missing members', () => {
    dev(1, 'a'); dev(2, 'dead', { host: 'dead' });
    for (const d of [1, 2]) { metric(d, 'Cisco_FRU_Power', 'PS1', 'PS1', 'psu_state', 1); metric(d, 'Cisco_FRU_Power', 'PS2', 'PS2', 'psu_state', 3); }
    metric(1, 'Cisco Switch Stack Ports-', 'p1', 'Stack Port 1', 'stack_port_state', 2);
    metric(1, 'Cisco Switch Stack-', 'm3', 'Switch 3', 'stack_member_state', 11);
    const d = hw.derived(db, { vendorKey: 'cisco' });
    expect(d.redundancyLost).toHaveLength(1);
    expect(d.redundancyLost[0].reason).toMatch(/one of 2 power supplies ok/);
    expect(d.redundancyLost[0].reason).toMatch(/stack ring open/);
    expect(d.redundancyLost[0].reason).toMatch(/stack member Switch 3 failed/);
  });

  it('finds thermal outliers and labels a hot site', () => {
    ['a', 'b', 'c', 'd', 'e', 'f'].forEach((n, i) => {
      dev(10 + i, n, { site: i < 3 ? 'hotsite' : 'ok' });
      metric(10 + i, 'Cisco_TemperatureSensors', 'Inlet', 'Inlet', 'temp_c', i < 3 ? 50 : 28 + i * 0.2);
    });
    // three more cool devices at other sites so the model median is cool
    [20, 21, 22, 23].forEach((id) => { dev(id, `x${id}`, { site: `s${id}` }); metric(id, 'Cisco_TemperatureSensors', 'Inlet', 'Inlet', 'temp_c', 27); });
    const out = hw.derived(db, { vendorKey: 'cisco' }).thermalOutliers;
    expect(out.map((o) => o.device).sort()).toEqual(['a', 'b', 'c']);
    expect(out.every((o) => o.suspectedSiteHvac)).toBe(true);
  });

  it('lists switchovers from state_change findings in the last 30 days', () => {
    dev(1, 'a');
    const day = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    db.prepare("INSERT INTO lm_trend_findings (source_id, lm_device_id, vendor_key, kind, subject, metric, severity, basis_json, detail_json, computed_at) VALUES (?, 1, 'cisco', 'state_change', 'Switch 1', 'stack_role', 'info', '{}', ?, 'now')")
      .run(SID, JSON.stringify({ days: [day, '2020-01-01'], events: [] }));
    const sw = hw.derived(db, { vendorKey: 'cisco' }).switchovers30d;
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatchObject({ metric: 'stack_role', count: 1, lastChangeDay: day });
  });
});
