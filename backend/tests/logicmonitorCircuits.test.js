/**
 * LogicMonitor round 13: site circuits (services/logicmonitorCircuits.js plus the computeCircuits
 * and issue hooks). Pure helpers first (role order, site WAN state, edge state), then the stored
 * pieces against a hand-built estate: computeCircuits roles, lm_sites.wan_*, the circuit issue
 * rules, the interface-flapping skip, the flap pattern and recordCircuitTransitions.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const lmCirc = require('../services/logicmonitorCircuits');
const lmPath = require('../services/logicmonitorPath');
const lmIssues = require('../services/logicmonitorIssues');
const { setSetting } = require('../services/settings');

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

const TABLES = ['lm_circuit_events', 'lm_issue_history', 'lm_topology_links', 'lm_interface_daily', 'lm_interface_history',
  'lm_interfaces', 'lm_sites', 'lm_alerts', 'lm_devices', 'lm_sources'];

function wipe() {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
}

function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid;
}

let devSeq = 100;
let instSeq = 1000;

function source(name = 'Acme') {
  return ins('lm_sources', { name, company: name.toLowerCase(), auth_mode: 'lmv1', encrypted_credentials: 'x' });
}

function site(sid, key, name) {
  ins('lm_sites', { source_id: sid, site_key: key, site_name: name, device_count: 1, network_count: 1 });
}

function device(sid, name, siteKey, siteName, over = {}) {
  devSeq += 1;
  ins('lm_devices', {
    source_id: sid, lm_device_id: devSeq, name: `10.0.0.${devSeq}`, display_name: name, device_type: 0, role: 'router',
    is_network: 1, host_status: 'normal', alert_status: 'none', sdt_status: 'none-none-none', group_ids_json: '[]',
    site_key: siteKey, site_name: siteName, ...over,
  });
  return devSeq;
}

/** One circuit port. role/far are stored the way computeCircuits writes them. */
function port(sid, devId, name, over = {}) {
  instSeq += 1;
  const status = over.status == null ? 1 : over.status;
  ins('lm_interfaces', {
    source_id: sid, lm_device_id: devId, instance_id: instSeq, display_name: name, instance_name: name,
    description: over.description || `WAN circuit ${name}`, status, status_text: status === 1 ? 'up' : 'down',
    speed_bps: 1e9, is_wan: over.isWan == null ? 1 : over.isWan, circuit_role: over.role === undefined ? 'wan' : over.role,
    circuit_far_site_key: over.far || null, props_json: over.props || null, sampled_at_epoch: Math.floor(Date.now() / 1000) - 60,
  });
  return instSeq;
}

/** statuses oldest first, one sample every 5 minutes ending now. */
function history(sid, inst, statuses) {
  const now = Date.now();
  statuses.forEach((st, i) => {
    ins('lm_interface_history', { source_id: sid, instance_id: inst, captured_at: sqlStamp(now - (statuses.length - i) * 5 * MIN), status: st, in_util_pct: 10, out_util_pct: 10 });
  });
}

describe('role classification (pure)', () => {
  const base = { ownSiteKey: 'a', hasCarrierOrCid: true };

  it('override wins over a tag, a topology far end, a label and a carrier', () => {
    const r = lmCirc.classifyCircuitRole({ ...base, overrideRole: 'site-link', tagClass: 'dia', topoSiteKey: 'b', labelFarSiteKey: 'c' });
    expect(r).toEqual({ role: 'site-link', farSiteKey: 'b', reason: 'override' });
    expect(lmCirc.classifyCircuitRole({ ...base, overrideRole: 'wan', tagClass: 'p2p', topoSiteKey: 'b' })).toEqual({ role: 'wan', farSiteKey: null, reason: 'override' });
  });

  it('the CG tag class comes second: dia mpls wan inet isp are wan, p2p ptp b2b dci are site links, upl is an uplink', () => {
    for (const cls of ['dia', 'mpls', 'wan', 'inet', 'isp']) {
      expect(lmCirc.classifyCircuitRole({ ...base, tagClass: cls, topoSiteKey: 'b', labelFarSiteKey: 'c' })).toMatchObject({ role: 'wan', reason: `tag:${cls}` });
    }
    for (const cls of ['p2p', 'ptp', 'b2b', 'dci']) {
      expect(lmCirc.classifyCircuitRole({ ...base, tagClass: cls, labelFarSiteKey: 'c' })).toEqual({ role: 'site-link', farSiteKey: 'c', reason: `tag:${cls}` });
    }
    expect(lmCirc.classifyCircuitRole({ ...base, tagClass: 'UPL' })).toMatchObject({ role: 'uplink' });
  });

  it('topology is third: a far device on another site is a site link, on the same site an uplink', () => {
    expect(lmCirc.classifyCircuitRole({ ...base, topoSiteKey: 'b', labelFarSiteKey: 'c' })).toEqual({ role: 'site-link', farSiteKey: 'b', reason: 'topology' });
    expect(lmCirc.classifyCircuitRole({ ...base, topoSiteKey: 'a', labelFarSiteKey: 'c' })).toMatchObject({ role: 'uplink', reason: 'topology-same-site' });
  });

  it('a label naming another site is fourth, a carrier or circuit id fifth, and the rest is an assumed wan', () => {
    expect(lmCirc.classifyCircuitRole({ ...base, labelFarSiteKey: 'c' })).toEqual({ role: 'site-link', farSiteKey: 'c', reason: 'label' });
    expect(lmCirc.classifyCircuitRole({ ...base })).toEqual({ role: 'wan', farSiteKey: null, reason: 'carrier-or-circuit-id' });
    expect(lmCirc.classifyCircuitRole({ ownSiteKey: 'a', hasCarrierOrCid: false })).toEqual({ role: 'wan', farSiteKey: null, reason: 'assumed-wan' });
  });

  it('farSiteFromLabel never returns the own site and prefers the longest site name', () => {
    const tokens = lmCirc.buildSiteTokens([{ siteKey: 'dallas-dc', siteName: 'Dallas DC' }, { siteKey: 'dallas', siteName: 'Dallas' }, { siteKey: 'phoenix-dc', siteName: 'Phoenix DC' }]);
    expect(lmCirc.farSiteFromLabel('WAN Zayo circuit 1 to Dallas DC', tokens, 'phoenix-dc')).toBe('dallas-dc');
    expect(lmCirc.farSiteFromLabel('WAN Zayo circuit 1 to Dallas DC', tokens, 'dallas-dc')).toBe('dallas');
    expect(lmCirc.farSiteFromLabel('WAN Zayo circuit 1', tokens, 'phoenix-dc')).toBe(null);
  });
});

describe('site WAN state and edge state (pure)', () => {
  it('matrix: all down is down, some down or any flapping is degraded, none down is ok, no WAN is null', () => {
    const s = lmCirc.siteWanState;
    expect(s({ total: 0, down: 0, flapping: 0 })).toBe(null);
    expect(s({ total: 2, down: 2, flapping: 0 })).toBe('down');
    expect(s({ total: 1, down: 1, flapping: 0 })).toBe('down');
    expect(s({ total: 2, down: 1, flapping: 0 })).toBe('degraded');
    expect(s({ total: 2, down: 0, flapping: 1 })).toBe('degraded');
    expect(s({ total: 2, down: 0, flapping: 0 })).toBe('ok');
  });

  it('edge state: every circuit down is down, some down is degraded, flapping needs none down', () => {
    const e = lmCirc.edgeState;
    expect(e([])).toBe('ok');
    expect(e([{ state: 'down' }, { state: 'down' }])).toBe('down');
    expect(e([{ state: 'down' }, { state: 'ok' }])).toBe('degraded');
    expect(e([{ state: 'ok', flaps24h: 3 }, { state: 'ok', flaps24h: 0 }])).toBe('flapping');
    expect(e([{ state: 'ok', flaps24h: 2 }])).toBe('ok');
    expect(e([{ state: 'down', flaps24h: 9 }, { state: 'ok', flaps24h: 9 }])).toBe('degraded');
  });

  it('transitionEvent and countChanges read LM status 1 up and 2 down', () => {
    expect(lmCirc.transitionEvent(1, 2)).toBe('down');
    expect(lmCirc.transitionEvent(2, 1)).toBe('up');
    expect(lmCirc.transitionEvent(1, 1)).toBe(null);
    expect(lmCirc.transitionEvent(null, 2)).toBe(null);
    expect(lmCirc.countChanges([{ status: 1 }, { status: 2 }, { status: null }, { status: 2 }, { status: 1 }])).toBe(2);
  });

  it('parseWanOverrides keeps the exclude marker and reads an optional role suffix', () => {
    expect(lmPath.parseWanOverrides('a:Gi0/0/1=wan, b:Gi0/0/2=site-link, !c:Gi0/0/3, d:Gi0/0/4')).toEqual([
      { device: 'a', port: 'gi0/0/1', exclude: false, role: 'wan' },
      { device: 'b', port: 'gi0/0/2', exclude: false, role: 'site-link' },
      { device: 'c', port: 'gi0/0/3', exclude: true },
      { device: 'd', port: 'gi0/0/4', exclude: false },
    ]);
  });
});

describe('computeCircuits roles against stored rows', () => {
  let sid;
  let ids;
  beforeEach(() => {
    wipe();
    sid = source();
    site(sid, 'phoenix', 'Phoenix');
    site(sid, 'dallas', 'Dallas');
    const r1 = device(sid, 'phx-rtr-01', 'phoenix', 'Phoenix');
    const far = device(sid, 'dal-rtr-01', 'dallas', 'Dallas');
    const mk = (name, over) => {
      instSeq += 1;
      ins('lm_interfaces', { source_id: sid, lm_device_id: r1, instance_id: instSeq, display_name: name, instance_name: name, status: 1, status_text: 'up', ...over });
      return instSeq;
    };
    ids = {
      tag: mk('Gi0/0/0', { description: 'uplink to Dallas circuit 4411 [t=dia m= q= n=]', props_json: JSON.stringify({ iccClass: 'dia' }) }),
      p2p: mk('Gi0/0/1', { description: 'WAN Zayo circuit 1234 to Dallas', props_json: JSON.stringify({ iccClass: 'p2p' }) }),
      label: mk('Gi0/0/2', { description: 'WAN Lumen circuit 5555 to Dallas' }),
      carrier: mk('Gi0/0/3', { description: 'WAN Lumen MPLS circuit 7777' }),
      topo: mk('Gi0/0/4', { description: 'WAN circuit 8888' }),
      forced: mk('Gi0/0/5', { description: 'WAN circuit 9999' }),
    };
    ins('lm_topology_links', { source_id: sid, src_device_id: r1, src_instance_id: ids.topo, src_port: 'Gi0/0/4', dst_device_id: far, dst_port: 'Gi0/0/9', protocol: 'lldp', confidence: 'high', dst_platform: 'logicmonitor' });
  });

  const role = (id) => db.prepare('SELECT is_wan, circuit_role r, circuit_far_site_key far, circuit_role_reason why FROM lm_interfaces WHERE source_id = ? AND instance_id = ?').get(sid, id);

  it('applies the evidence order and records the reason', () => {
    setSetting('lm_wan_overrides', 'phx-rtr-01:Gi0/0/5=site-link');
    lmPath.computeCircuits(db, sid);
    expect(role(ids.tag)).toMatchObject({ is_wan: 1, r: 'wan', far: null, why: 'tag:dia' });
    expect(role(ids.p2p)).toMatchObject({ is_wan: 1, r: 'site-link', far: 'dallas', why: 'tag:p2p' });
    expect(role(ids.label)).toMatchObject({ is_wan: 1, r: 'site-link', far: 'dallas', why: 'label' });
    expect(role(ids.carrier)).toMatchObject({ is_wan: 1, r: 'wan', why: 'carrier-or-circuit-id' });
    expect(role(ids.topo)).toMatchObject({ is_wan: 1, r: 'site-link', far: 'dallas', why: 'topology' });
    expect(role(ids.forced)).toMatchObject({ is_wan: 1, r: 'site-link', why: 'override' });
  });

  it('a site link keeps is_wan = 1 so the Circuits page still lists it', () => {
    lmPath.computeCircuits(db, sid);
    const rows = lmPath.circuitRows(db, { sourceId: sid });
    const linkRow = rows.find((r) => r.instanceId === ids.p2p);
    expect(linkRow).toBeTruthy();
    expect(linkRow).toMatchObject({ role: 'site-link', farSiteKey: 'dallas' });
  });
});

describe('site WAN state written to lm_sites', () => {
  it('writes ok / degraded / down / null and counts flapping, site links excluded', () => {
    wipe();
    const sid = source();
    for (const [k, n] of [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma'], ['delta', 'Delta'], ['eps', 'Epsilon']]) site(sid, k, n);
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const b = device(sid, 'b-rtr', 'beta', 'Beta');
    const g = device(sid, 'g-rtr', 'gamma', 'Gamma');
    const d = device(sid, 'd-rtr', 'delta', 'Delta');
    const e = device(sid, 'e-rtr', 'eps', 'Epsilon');
    port(sid, a, 'Gi0/0/0'); port(sid, a, 'Gi0/0/1');
    port(sid, b, 'Gi0/0/0'); port(sid, b, 'Gi0/0/1', { status: 2 });
    port(sid, g, 'Gi0/0/0', { status: 2 }); port(sid, g, 'Gi0/0/1', { status: 2 });
    const flap = port(sid, d, 'Gi0/0/0');
    history(sid, flap, [1, 2, 1, 2, 1]);
    // Epsilon has only a site link, and it is down: no WAN circuits means no WAN state.
    port(sid, e, 'Gi0/0/0', { role: 'site-link', far: 'alpha', status: 2 });

    const res = lmCirc.computeSiteWanState(db, sid);
    expect(res).toMatchObject({ down: 1, degraded: 2 });
    const get = (k) => db.prepare('SELECT wan_state, wan_total, wan_down, wan_flapping FROM lm_sites WHERE source_id = ? AND site_key = ?').get(sid, k);
    expect(get('alpha')).toEqual({ wan_state: 'ok', wan_total: 2, wan_down: 0, wan_flapping: 0 });
    expect(get('beta')).toEqual({ wan_state: 'degraded', wan_total: 2, wan_down: 1, wan_flapping: 0 });
    expect(get('gamma')).toEqual({ wan_state: 'down', wan_total: 2, wan_down: 2, wan_flapping: 0 });
    expect(get('delta')).toEqual({ wan_state: 'degraded', wan_total: 1, wan_down: 0, wan_flapping: 1 });
    expect(get('eps')).toMatchObject({ wan_state: null, wan_total: 0 });
  });
});

describe('circuit issue rules', () => {
  let sid;
  const srcName = () => new Map([[sid, 'Acme']]);
  const issues = () => lmCirc.computeCircuitIssues(db, {}, srcName());
  const of = (type) => issues().filter((i) => i.type === type);

  beforeEach(() => {
    wipe();
    sid = source();
    for (const [k, n] of [['alpha', 'Alpha'], ['beta', 'Beta'], ['gamma', 'Gamma']]) site(sid, k, n);
  });

  it('one of two WAN circuits down is circuit-down (warning) plus site-wan-degraded, never site-wan-down', () => {
    const b = device(sid, 'b-rtr', 'beta', 'Beta');
    port(sid, b, 'Gi0/0/0'); port(sid, b, 'Gi0/0/1', { status: 2 });
    expect(of('site-wan-down')).toHaveLength(0);
    const deg = of('site-wan-degraded');
    expect(deg).toHaveLength(1);
    expect(deg[0]).toMatchObject({ severity: 'warning', target: 'Beta' });
    expect(deg[0].message).toContain('1 of 2 WAN circuits');
    const down = of('circuit-down');
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ severity: 'warning', target: 'b-rtr Gi0/0/1' });
    expect(down[0].message).toContain('Beta remains reachable on 1 other WAN circuit');
  });

  it('every WAN circuit down is site-wan-down (critical) and the circuit issues stay warnings', () => {
    const g = device(sid, 'g-rtr', 'gamma', 'Gamma');
    port(sid, g, 'Gi0/0/0', { status: 2 }); port(sid, g, 'Gi0/0/1', { status: 2 });
    const siteDown = of('site-wan-down');
    expect(siteDown).toHaveLength(1);
    expect(siteDown[0]).toMatchObject({ severity: 'critical', target: 'Gamma' });
    expect(siteDown[0].message).toContain('2 of 2 down');
    expect(of('site-wan-degraded')).toHaveLength(0);
    const down = of('circuit-down');
    expect(down).toHaveLength(2);
    expect(down.every((i) => i.severity === 'warning' && i.message.includes('Gamma has no WAN circuit up'))).toBe(true);
  });

  it('a flapping WAN circuit with nothing down degrades the site', () => {
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const p = port(sid, a, 'Gi0/0/0'); port(sid, a, 'Gi0/0/1');
    history(sid, p, [1, 2, 1, 2, 1]);
    const deg = of('site-wan-degraded');
    expect(deg).toHaveLength(1);
    expect(deg[0].message).toContain('flapping WAN circuit');
    expect(of('circuit-flapping')).toHaveLength(1);
    expect(of('circuit-down')).toHaveLength(0);
  });

  it('a down site link raises site-link-down naming both ends and never touches the WAN state', () => {
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const b = device(sid, 'b-rtr', 'beta', 'Beta');
    port(sid, a, 'Gi0/0/0'); port(sid, b, 'Gi0/0/0');
    port(sid, a, 'Gi0/0/1', { role: 'site-link', far: 'beta', status: 2 });
    port(sid, b, 'Gi0/0/1', { role: 'site-link', far: 'alpha' });
    expect(of('site-wan-down')).toHaveLength(0);
    expect(of('site-wan-degraded')).toHaveLength(0);
    expect(of('circuit-down')).toHaveLength(0);
    const link = of('site-link-down');
    expect(link).toHaveLength(1);
    expect(link[0]).toMatchObject({ severity: 'warning', target: 'Alpha <-> Beta' });
    expect(link[0].message).toContain('a-rtr Gi0/0/1');
    expect(link[0].message).toContain('1 of 2 circuits');
  });

  it('circuit-flapping fires at lm_circuit_flap_warn changes in 24 h for wan and site-link circuits only', () => {
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const wan = port(sid, a, 'Gi0/0/0');
    const link = port(sid, a, 'Gi0/0/1', { role: 'site-link', far: 'beta' });
    const uplink = port(sid, a, 'Gi0/0/2', { role: 'uplink', isWan: 0 });
    history(sid, wan, [1, 2, 1]); // 2 changes: below the default of 3
    history(sid, link, [1, 2, 1, 2]); // 3 changes
    history(sid, uplink, [1, 2, 1, 2, 1]);
    const flaps = of('circuit-flapping');
    expect(flaps.map((i) => i.target)).toEqual(['a-rtr Gi0/0/1']);
    expect(flaps[0].message).toContain('Site link');
    setSetting('lm_circuit_flap_warn', '2');
    expect(of('circuit-flapping').map((i) => i.target).sort()).toEqual(['a-rtr Gi0/0/0', 'a-rtr Gi0/0/1']);
  });

  it('circuit-flap-pattern needs drops on lm_circuit_flap_days distinct days of the last 7', () => {
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const p = port(sid, a, 'Gi0/0/0');
    port(sid, a, 'Gi0/0/1');
    const ev = (daysAgo, event) => ins('lm_circuit_events', {
      source_id: sid, instance_id: p, device_name: 'a-rtr', port: 'Gi0/0/0', site_key: 'alpha', role: 'wan', event, at: sqlStamp(Date.now() - daysAgo * DAY - HOUR),
    });
    ev(1, 'down'); ev(1, 'up'); ev(2, 'down'); ev(2, 'up');
    expect(of('circuit-flap-pattern')).toHaveLength(0);
    ev(4, 'down'); ev(4, 'up');
    const pat = of('circuit-flap-pattern');
    expect(pat).toHaveLength(1);
    expect(pat[0]).toMatchObject({ severity: 'warning', target: 'a-rtr Gi0/0/0' });
    expect(pat[0].message).toContain('flapped on 3 of the last 7 days (6 changes), expect a failure');
    // A drop eight days ago is outside the window.
    ev(8, 'down'); ev(8, 'up');
    expect(of('circuit-flap-pattern')[0].message).toContain('3 of the last 7 days (6 changes)');
    setSetting('lm_circuit_flap_days', '4');
    expect(of('circuit-flap-pattern')).toHaveLength(0);
  });
});

describe('interface-flapping skips circuit ports', () => {
  it('a flapping wan port raises circuit-flapping only, a flapping access port still raises interface-flapping', () => {
    wipe();
    const sid = source();
    site(sid, 'alpha', 'Alpha');
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const wan = port(sid, a, 'Gi0/0/0');
    const access = port(sid, a, 'Gi0/0/10', { isWan: 0, role: null, description: 'Users VLAN' });
    history(sid, wan, [1, 2, 1, 2, 1]);
    history(sid, access, [1, 2, 1, 2, 1]);

    const set = lmCirc.circuitInstanceSet(db);
    expect(set.has(`${sid}|${wan}`)).toBe(true);
    expect(set.has(`${sid}|${access}`)).toBe(false);

    const all = lmIssues.computeIssues();
    const forPort = (type, name) => all.filter((i) => i.type === type && i.target === `a-rtr ${name}`);
    expect(forPort('interface-flapping', 'Gi0/0/0')).toHaveLength(0);
    expect(forPort('circuit-flapping', 'Gi0/0/0')).toHaveLength(1);
    expect(forPort('interface-flapping', 'Gi0/0/10')).toHaveLength(1);
    expect(forPort('circuit-flapping', 'Gi0/0/10')).toHaveLength(0);
  });

  it('an uplink-role port is not in the circuit set, so the generic rule keeps it', () => {
    wipe();
    const sid = source();
    site(sid, 'alpha', 'Alpha');
    const a = device(sid, 'a-sw', 'alpha', 'Alpha', { role: 'switch' });
    const upl = port(sid, a, 'Te1/0/1', { isWan: 0, role: 'uplink' });
    expect(lmCirc.circuitInstanceSet(db).has(`${sid}|${upl}`)).toBe(false);
  });
});

describe('recordCircuitTransitions', () => {
  it('writes one down and one up per transition and adds nothing on a rerun', () => {
    wipe();
    const sid = source();
    site(sid, 'alpha', 'Alpha');
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const p = port(sid, a, 'Gi0/0/0');
    history(sid, p, [1, 1, 2, 2, 2, 1, 1]);
    const first = lmCirc.recordCircuitTransitions(db, sid);
    expect(first.written).toBe(2);
    const rows = db.prepare('SELECT event, device_name, port, site_key, role FROM lm_circuit_events WHERE source_id = ? ORDER BY at, id').all(sid);
    expect(rows.map((r) => r.event)).toEqual(['down', 'up']);
    expect(rows[0]).toMatchObject({ device_name: 'a-rtr', port: 'Gi0/0/0', site_key: 'alpha', role: 'wan' });
    expect(lmCirc.recordCircuitTransitions(db, sid).written).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM lm_circuit_events').get().n).toBe(2);
  });

  it('opens a flap episode at the flap threshold once and closes it after a quiet day', () => {
    wipe();
    const sid = source();
    site(sid, 'alpha', 'Alpha');
    const a = device(sid, 'a-rtr', 'alpha', 'Alpha');
    const p = port(sid, a, 'Gi0/0/0', { role: 'site-link', far: 'beta' });
    history(sid, p, [1, 2, 1, 2, 1]);
    lmCirc.recordCircuitTransitions(db, sid);
    const count = (event) => db.prepare('SELECT COUNT(*) n FROM lm_circuit_events WHERE event = ?').get(event).n;
    expect(count('down')).toBe(2);
    expect(count('up')).toBe(2);
    expect(count('flap-start')).toBe(1);
    expect(db.prepare("SELECT far_site_key f, role FROM lm_circuit_events WHERE event = 'flap-start'").get()).toEqual({ f: 'beta', role: 'site-link' });
    lmCirc.recordCircuitTransitions(db, sid);
    expect(count('flap-start')).toBe(1);
    // Nothing changed for a day: the episode closes.
    const later = Date.now() + 2 * DAY;
    ins('lm_interface_history', { source_id: sid, instance_id: p, captured_at: sqlStamp(later - 10 * MIN), status: 1, in_util_pct: 1, out_util_pct: 1 });
    ins('lm_interface_history', { source_id: sid, instance_id: p, captured_at: sqlStamp(later - 5 * MIN), status: 1, in_util_pct: 1, out_util_pct: 1 });
    lmCirc.recordCircuitTransitions(db, sid, { nowMs: later });
    expect(count('flap-stop')).toBe(1);
  });

  it('skips uplink-role ports and prunes by lm_circuit_event_days', () => {
    wipe();
    const sid = source();
    site(sid, 'alpha', 'Alpha');
    const a = device(sid, 'a-sw', 'alpha', 'Alpha', { role: 'switch' });
    const upl = port(sid, a, 'Te1/0/1', { isWan: 0, role: 'uplink' });
    history(sid, upl, [1, 2, 1]);
    expect(lmCirc.recordCircuitTransitions(db, sid).written).toBe(0);
    ins('lm_circuit_events', { source_id: sid, instance_id: 1, device_name: 'x', port: 'p', event: 'down', at: sqlStamp(Date.now() - 400 * DAY) });
    ins('lm_circuit_events', { source_id: sid, instance_id: 1, device_name: 'x', port: 'p', event: 'down', at: sqlStamp(Date.now() - 10 * DAY) });
    expect(lmCirc.pruneCircuitEvents(db)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM lm_circuit_events').get().n).toBe(1);
  });
});

describe('round 13b: degraded matcher, suffix classes, far device, reasons', () => {
  const grammar = require('../services/logicmonitorGrammar');
  const lookupOf = (names) => (n) => (names.includes(n) ? { name: n } : null);

  it('deviceForTarget matches exact, name + space, name + colon and name + slash, never a longer name', () => {
    const find = lookupOf(['sjcx-core-1']);
    expect(lmCirc.deviceForTarget('SJCX-Core-1', find)).toBeTruthy();
    expect(lmCirc.deviceForTarget('sjcx-core-1 Slot Module-25 4-slot Fabric Module: X [M46]', find)).toBeTruthy();
    expect(lmCirc.deviceForTarget('sjcx-core-1: BGP peer down', find)).toBeTruthy();
    expect(lmCirc.deviceForTarget('sjcx-core-1/Gi0/1 down', find)).toBeTruthy();
    expect(lmCirc.deviceForTarget('sjcx-core-10 Slot 1', find)).toBe(null);
    expect(lmCirc.deviceForTarget('sjcx-core-10', find)).toBe(null);
  });

  it('suffix classes: @int is inet (wan), @ptp is a site link, -C@uplink- is an uplink, a tag wins over the suffix', () => {
    expect(grammar.suffixClass('VZB CKT ID: U336816 @int')).toEqual({ kind: 'int', cls: 'inet' });
    expect(grammar.suffixClass('SNX1-DCI-1 E1/1 CTL CKT ID:440463607 @ptp')).toEqual({ kind: 'ptp', cls: 'ptp' });
    expect(grammar.suffixClass('ASX1-SPINE-2 E1/2 -C@uplink-')).toEqual({ kind: 'uplink', cls: 'upl' });
    expect(grammar.suffixClass('x @int [t=ptp m= q= n=]')).toBe(null);
    expect(grammar.linkFromDescription('VZB CKT ID: U336816 @int', null, null).cls).toBe('inet');
    expect(lmCirc.classifyCircuitRole({ ownSiteKey: 'a', tagClass: 'inet', tagReason: 'suffix:int' })).toEqual({ role: 'wan', farSiteKey: null, reason: 'suffix:int' });
    expect(lmCirc.classifyCircuitRole({ ownSiteKey: 'a', tagClass: 'upl' })).toMatchObject({ role: 'uplink' });
  });

  it('ibgp and gtw tags are uplinks', () => {
    expect(lmCirc.classifyCircuitRole({ ownSiteKey: 'a', tagClass: 'ibgp' })).toMatchObject({ role: 'uplink', reason: 'tag:ibgp' });
    expect(lmCirc.classifyCircuitRole({ ownSiteKey: 'a', tagClass: 'gtw' })).toMatchObject({ role: 'uplink' });
  });

  it('the far-device rule resolves the first token through lm_devices and computeCircuits records far-device and suffix reasons', () => {
    wipe();
    const sid = source();
    site(sid, 'phoenix', 'Phoenix');
    site(sid, 'zeta', 'Zeta');
    const r1 = device(sid, 'phx-rtr-01', 'phoenix', 'Phoenix');
    device(sid, 'dci-9', 'zeta', 'Zeta');
    const mk = (name, description, props_json = null) => {
      instSeq += 1;
      ins('lm_interfaces', { source_id: sid, lm_device_id: r1, instance_id: instSeq, display_name: name, instance_name: name, status: 1, status_text: 'up', description, props_json });
      return instSeq;
    };
    const far = mk('Gi0/0/0', 'DCI-9.corp.example, Lumen circuit 777');
    const suf = mk('Gi0/0/1', 'VZB CKT ID: U336816 @int');
    const up = mk('Gi0/0/2', 'ATO-WAN-2 Gi0/0/2 IBGP [t=ibgp m= q= n=]', JSON.stringify({ iccClass: 'ibgp' }));
    lmPath.computeCircuits(db, sid);
    const row = (id) => db.prepare('SELECT circuit_role r, circuit_far_site_key far, circuit_role_reason why FROM lm_interfaces WHERE instance_id = ?').get(id);
    expect(row(far)).toMatchObject({ r: 'site-link', far: 'zeta', why: 'far-device' });
    expect(row(suf)).toMatchObject({ r: 'wan', why: 'suffix:int' });
    expect(row(up)).toMatchObject({ r: 'uplink' });
    expect(lmCirc.farDeviceSite('dci-9', (n) => (n === 'dci-9' ? 'phoenix' : null), 'phoenix')).toBe(null);
  });

  it('node reasons for the three states and an issuesTop list critical first', () => {
    expect(lmCirc.siteReasons({ wanState: 'down', wanTotal: 2, wanDown: 2, devicesDead: 0, degradedCount: 0, openIssues: 0 })).toEqual(['WAN down: 0 of 2 circuits up']);
    expect(lmCirc.siteReasons({ wanState: 'degraded', wanTotal: 2, wanDown: 1, devicesDead: 3, degradedCount: 2, openIssues: 4 }, [{ farName: 'Dallas', state: 'down' }]))
      .toEqual(['WAN degraded: 1 of 2 circuits up', '3 dead device(s)', '2 degraded device(s)', '4 open issue(s)', 'site link Dallas down']);
    expect(lmCirc.siteReasons({ wanState: 'ok', wanTotal: 2, wanDown: 0, devicesDead: 0, degradedCount: 0, openIssues: 0 })).toEqual([]);
    const top = lmCirc.topIssues([
      { type: 'a', severity: 'warning', target: 't1', first_seen: '2026-01-02 00:00:00' },
      { type: 'b', severity: 'critical', target: 't2', first_seen: '2026-01-01 00:00:00' },
      { type: 'c', severity: 'warning', target: 't3', first_seen: '2026-01-03 00:00:00' },
    ]);
    expect(top.map((i) => i.target)).toEqual(['t2', 't3', 't1']);
  });

  it('the circuit map counts a device degraded when an issue target carries a suffix and carries issuesTop and reasons', () => {
    wipe();
    const sid = source('Acme');
    site(sid, 'sjcx', 'SJCX');
    device(sid, 'sjcx-core-1', 'sjcx', 'SJCX');
    device(sid, 'sjcx-core-10', 'sjcx', 'SJCX');
    ins('lm_issue_history', { issue_key: 'k1', source: 'Acme', severity: 'warning', type: 'hardware-fault', target: 'sjcx-core-1 Slot Module-25 4-slot Fabric Module: X', message: 'm', status: 'open' });
    ins('lm_issue_history', { issue_key: 'k2', source: 'Acme', severity: 'warning', type: 'fw-tunnel-down', target: 'sjcx-core-1: tunnels', message: 'm', status: 'open' });
    const node = lmCirc.circuitMap(db).nodes.find((n) => n.siteKey === 'sjcx');
    expect(node.degradedDevices).toEqual(['sjcx-core-1']);
    expect(node.openIssues).toBe(2);
    expect(node.issuesTop).toHaveLength(2);
    expect(node.reasons).toContain('2 open issue(s)');
    expect(node.reasons).toContain('1 degraded device(s)');
  });
});
