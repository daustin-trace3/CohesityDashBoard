import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const seed = require('./helpers/opsCorrelationSeed');
const hostIdentity = require('../services/hostIdentity');
const agent = require('../services/opsAgent');
const teams = require('../services/opsAgentTeams');
const { setSetting } = require('../services/settings');

const { db } = seed;
const NOW = '2026-09-25T20:00:00.000Z';
const at = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();
const settings = { minSeverity: 'warning', holdMinutes: 10, consequenceMinutes: 30, onsetMinutes: 10 };

const alert = (platform, sourceKey, o = {}) => ({
  platform, sourceKey, severity: o.severity || 'critical', host: o.host ?? 'esx-01', message: o.message || 'alert text',
  firstSeen: o.firstSeen || NOW, lastSeen: NOW, ...(o.type ? { type: o.type } : {}),
});
const hostDown = (name, firstSeen) => alert('vcenter', `v:down-${name}`, { host: name, type: 'host-down', message: `Host ${name} is not responding`, firstSeen });
const vmAlert = (name, firstSeen, extra = {}) => alert('vcenter', `v:vol-${name}`, { host: name, type: 'guest-volume-full', severity: 'warning', message: `Volume C: on ${name} is 96% full`, firstSeen, ...extra });
const tick = (items, s = settings, now = NOW) => agent.groupTick(now, s, { items, failed: [] });

const incidents = () => db.prepare('SELECT * FROM ops_incidents ORDER BY id').all();
const alertsOf = (id) => db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ? ORDER BY rowid').all(id);

beforeEach(() => {
  seed.reset();
  hostIdentity.invalidateIdentityIndex(db);
  setSetting('ops_agent_enabled', '1');
});

/** esx-01 with four VMs on it. */
function hostWithVms() {
  seed.host('esx-01');
  for (const n of ['vm-a', 'vm-b', 'vm-c', 'vm-d']) seed.vm(n, { onHost: 'esx-01' });
}

describe('consequence folding', () => {
  it('folds the alerts of VMs on a down host into the host incident', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5)), vmAlert('vm-b', at(-4)), vmAlert('vm-c', at(-3)), vmAlert('vm-d', at(-2))]);
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_key).toBe('host:esx-01');
    expect(rows[0].title).toBe('esx-01');
    const a = alertsOf(rows[0].id);
    expect(a).toHaveLength(5);
    const kids = a.filter((r) => r.relation === 'consequence');
    expect(kids).toHaveLength(4);
    expect(kids.every((r) => r.relation_of === 'esx-01')).toBe(true);
    expect(a.find((r) => r.type === 'host-down').relation).toBeNull();
    const ev = agent.gatherIncidentEvidence(rows[0], a);
    expect(ev.blastRadius).toMatchObject({ parent: 'esx-01', kind: 'host', parentCleared: false, childrenTotal: 4 });
    expect(ev.blastRadius.sentence).toContain('4 alerts on VMs that run on it');
    expect(ev.relations[0]).toBe(ev.blastRadius.sentence);
    expect(ev.alerts.filter((x) => x.relation === 'consequence')).toHaveLength(4);
  });

  it('the parent still folds the children when the child alerts arrive in an earlier batch than the parent row', () => {
    hostWithVms();
    // Tick 1 opens the host incident; tick 2 brings a new VM alert.
    tick([hostDown('esx-01', at(-6))]);
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-4))], settings, at(1));
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(alertsOf(rows[0].id).filter((r) => r.relation === 'consequence')).toHaveLength(1);
  });

  it('a child alert outside the consequence window opens its own incident', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-50)), vmAlert('vm-a', at(-5))]);
    const rows = incidents();
    expect(rows.map((r) => r.incident_key).sort()).toEqual(['host:esx-01', 'host:vm-a']);
    expect(db.prepare('SELECT COUNT(*) c FROM ops_incident_alerts WHERE relation IS NOT NULL').get().c).toBe(0);
  });

  it('a child that came before its parent is not a consequence', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-2)), vmAlert('vm-a', at(-20))]);
    expect(incidents()).toHaveLength(2);
  });

  it('consequences stay and the incident stays open after the parent alert clears', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5)), vmAlert('vm-b', at(-4))]);
    tick([vmAlert('vm-a', at(-5)), vmAlert('vm-b', at(-4))], settings, at(2));
    const [inc] = incidents();
    expect(inc.state).not.toBe('resolved');
    const rows = alertsOf(inc.id);
    expect(rows.find((r) => r.type === 'host-down').cleared_at).not.toBeNull();
    const ev = agent.gatherIncidentEvidence(inc, rows);
    expect(ev.blastRadius.parentCleared).toBe(true);
    expect(ev.blastRadius.sentence).toContain('has since cleared');
  });

  it('a child that fires after the parent cleared opens its own incident', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5))]);
    tick([vmAlert('vm-a', at(-5)), vmAlert('vm-b', at(3))], settings, at(4));
    const keys = incidents().map((r) => r.incident_key).sort();
    expect(keys).toEqual(['host:esx-01', 'host:vm-b']);
  });

  it('component mode folds nothing and writes no relation', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5)), vmAlert('vm-b', at(-4))], { ...settings, grouping: 'component' });
    expect(incidents()).toHaveLength(3);
    expect(db.prepare('SELECT COUNT(*) c FROM ops_incident_alerts WHERE relation IS NOT NULL').get().c).toBe(0);
  });

  it('consequenceMinutes 0 turns folding off', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5))], { ...settings, consequenceMinutes: 0 });
    expect(incidents()).toHaveLength(2);
  });

  it('a stored-state inaccessible datastore folds VM alerts without any datastore alert row', () => {
    seed.datastore('DS-BAD', 0);
    seed.host('esx-01'); seed.host('esx-02');
    seed.vm('vm-a', { onHost: 'esx-01', datastores: ['DS-BAD'] });
    seed.vm('vm-b', { onHost: 'esx-02', datastores: ['DS-BAD'] });
    tick([vmAlert('vm-a', at(-3)), vmAlert('vm-b', at(-2))]);
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_key).toBe('shared:datastore:ds-bad');
    expect(rows[0].title).toBe('Datastore DS-BAD inaccessible');
    expect(rows[0].host).toBeNull();
    const a = alertsOf(rows[0].id);
    expect(a).toHaveLength(2);
    expect(a.every((r) => r.relation === 'consequence' && r.relation_of === 'DS-BAD')).toBe(true);
    const ev = agent.gatherIncidentEvidence(rows[0], a);
    expect(ev.blastRadius).toMatchObject({ kind: 'datastore', parentCleared: false, childrenTotal: 2 });
  });

  it('names the watched app services in the title and the evidence', () => {
    seed.host('esx-01');
    seed.watch('aa001', 'AA-001', 'Payroll');
    seed.vm('pay01', { onHost: 'esx-01', tags: ['usage-id: aa001'] });
    tick([hostDown('esx-01', at(-5)), vmAlert('pay01', at(-4))]);
    const [inc] = incidents();
    expect(inc.title).toBe('esx-01 (affects 1 app service: Payroll)');
    const ev = agent.gatherIncidentEvidence(inc, alertsOf(inc.id));
    expect(ev.blastRadius.appsAffected).toEqual([{ usageId: 'aa001', label: 'Payroll', servers: ['pay01'] }]);
  });
});

describe('shared component onset', () => {
  it('three VMs on one datastore without a datastore alert open a shared incident', () => {
    seed.datastore('DS-PROD-01', 1);
    for (const n of ['a', 'b', 'c']) { seed.host(`esx-${n}`); seed.vm(`web-${n}`, { onHost: `esx-${n}`, datastores: ['DS-PROD-01'] }); }
    tick([vmAlert('web-a', at(-4)), vmAlert('web-b', at(-3)), vmAlert('web-c', at(-1))]);
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_key).toBe('shared:datastore:ds-prod-01');
    expect(rows[0].title.startsWith('3 VMs on datastore DS-PROD-01')).toBe(true);
    expect(rows[0].host).toBeNull();
    const a = alertsOf(rows[0].id);
    expect(a).toHaveLength(3);
    expect(a.every((r) => r.relation === 'shared' && r.relation_of === 'datastore:ds-prod-01')).toBe(true);
    const ev = agent.gatherIncidentEvidence(rows[0], a);
    expect(ev.shared).toMatchObject({ kind: 'datastore', parent: 'DS-PROD-01', childrenTotal: 3 });
    expect(ev.shared.sentence).toContain('share datastore DS-PROD-01');
    expect(agent.incidentKeyFor).toBeTypeOf('function');
  });

  it('two hosts are not enough, and a spread-out onset is not one event', () => {
    seed.datastore('DS-PROD-01', 1);
    for (const n of ['a', 'b', 'c']) { seed.host(`esx-${n}`); seed.vm(`web-${n}`, { onHost: `esx-${n}`, datastores: ['DS-PROD-01'] }); }
    tick([vmAlert('web-a', at(-4)), vmAlert('web-b', at(-3))]);
    expect(incidents().every((r) => r.incident_key.startsWith('host:'))).toBe(true);
    seed.reset();
    for (const n of ['a', 'b', 'c']) { seed.host(`esx-${n}`); seed.vm(`web-${n}`, { onHost: `esx-${n}`, datastores: ['DS-PROD-01'] }); }
    tick([vmAlert('web-a', at(-50)), vmAlert('web-b', at(-30)), vmAlert('web-c', at(-1))]);
    expect(incidents().some((r) => r.incident_key.startsWith('shared:'))).toBe(false);
  });

  it('a later child joins the open shared incident', () => {
    seed.datastore('DS-PROD-01', 1);
    for (const n of ['a', 'b', 'c', 'd']) { seed.host(`esx-${n}`); seed.vm(`web-${n}`, { onHost: `esx-${n}`, datastores: ['DS-PROD-01'] }); }
    tick([vmAlert('web-a', at(-4)), vmAlert('web-b', at(-3)), vmAlert('web-c', at(-1))]);
    tick([vmAlert('web-a', at(-4)), vmAlert('web-b', at(-3)), vmAlert('web-c', at(-1)), vmAlert('web-d', at(20))], settings, at(21));
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(alertsOf(rows[0].id)).toHaveLength(4);
    expect(rows[0].title.startsWith('4 VMs on datastore')).toBe(true);
  });

  it('onsetMinutes 0 turns it off', () => {
    seed.datastore('DS-PROD-01', 1);
    for (const n of ['a', 'b', 'c']) { seed.host(`esx-${n}`); seed.vm(`web-${n}`, { onHost: `esx-${n}`, datastores: ['DS-PROD-01'] }); }
    tick([vmAlert('web-a', at(-4)), vmAlert('web-b', at(-3)), vmAlert('web-c', at(-1))], { ...settings, onsetMinutes: 0 });
    expect(incidents()).toHaveLength(3);
  });
});

describe('identity-aware host keys', () => {
  it('an ambiguous short name is not merged through identity', () => {
    seed.vm('web01.a.local', { onHost: 'esx-01' });
    seed.vm('web01.b.local', { onHost: 'esx-01' });
    const idx = hostIdentity.buildIdentityIndex(db, { fresh: true });
    expect(hostIdentity.explainToken(idx, 'web01').reason).toBe('ambiguous');
    expect(agent.canonicalHostKey('web01', idx)).toBe('web01');
    expect(agent.canonicalHostKey('', idx)).toBe('');
    expect(agent.canonicalHostKey('Web Check @ Phoenix', idx)).toBe('web-check');
  });

  function dellAndVcenter() {
    seed.host('esx-01.lab.local', { serial: 'ABC1234', tag: 'ABC1234' });
    seed.dell('R740-07', 'ABC1234');
  }

  it('a Dell "(TAG)" host merges with the vCenter host through its serial', () => {
    dellAndVcenter();
    tick([
      alert('vcenter', 'v:down', { host: 'esx-01.lab.local', type: 'host-down', message: 'Host esx-01 down' }),
      alert('dell', 'd:1', { host: 'R740-07 (ABC1234)', severity: 'warning', message: 'PSU 2 failed' }),
    ]);
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_key).toBe('host:esx-01');
    expect(JSON.parse(rows[0].platforms).sort()).toEqual(['dell', 'vcenter']);
  });

  it('an open legacy host key keeps receiving alerts after identity resolution', () => {
    dellAndVcenter();
    db.prepare("INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count) VALUES ('host:r740-07', 'R740-07', 'R740-07', '[\"dell\"]', 'warning', 'collecting', ?, ?, ?, 1)")
      .run(at(-30), at(-20), at(-30));
    tick([alert('dell', 'd:2', { host: 'R740-07 (ABC1234)', severity: 'warning', message: 'Fan failed' })]);
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_key).toBe('host:r740-07');
    expect(alertsOf(rows[0].id)).toHaveLength(1);
  });
});

describe('presentation', () => {
  it('shapeIncident reports relation, relationOf and the consequence count', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5)), vmAlert('vm-b', at(-4))]);
    const [row] = incidents();
    const inc = agent.getIncident(row.id);
    expect(inc.consequenceCount).toBe(2);
    expect(inc.alerts.filter((a) => a.relation === 'consequence' && a.relationOf === 'esx-01')).toHaveLength(2);
    expect(inc.alerts.find((a) => a.relation == null).relationOf).toBeNull();
    expect(agent.listIncidents()[0].consequenceCount).toBe(2);
  });

  it('the email lists the consequences in their own block and the Teams card carries a fact', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5)), vmAlert('vm-b', at(-4))]);
    const [row] = incidents();
    const alerts = alertsOf(row.id);
    const ev = agent.gatherIncidentEvidence(row, alerts);
    const analysis = agent.fallbackTriage(ev);
    expect(analysis.reviewed.some((l) => l.startsWith('Blast radius: 2 consequences under esx-01'))).toBe(true);
    const mail = agent.renderEmail(row, alerts, { ...analysis, impact: '' }, { blast: ev.blastRadius });
    expect(mail.text).toContain('CONSEQUENCES (2) OF esx-01');
    expect(mail.text).toContain('ALERTS IN THIS INCIDENT (1 open');
    expect(mail.text).toContain(ev.blastRadius.sentence);
    expect(mail.html).toContain('Consequences (2) of esx-01');
    const card = teams.buildCard({ ...row, consequenceCount: 2 }, analysis, {});
    const facts = card.body.find((b) => b.type === 'FactSet').facts;
    expect(facts).toContainEqual({ title: 'Consequences', value: '2 alerts folded in' });
  });

  it('the prompt carries the blast sentence only when the evidence has a blast radius', () => {
    hostWithVms();
    tick([hostDown('esx-01', at(-6)), vmAlert('vm-a', at(-5))]);
    const [row] = incidents();
    const ev = agent.gatherIncidentEvidence(row, alertsOf(row.id));
    expect(agent.systemPromptFor(ev).system).toContain('blastRadius lists alerts');
    const plain = { ...ev };
    delete plain.blastRadius;
    expect(agent.systemPromptFor(plain).system).not.toContain('blastRadius lists alerts');
  });
});
