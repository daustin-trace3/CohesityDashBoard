// Sticky incidents: a repeating condition stays open until a person resolves it.
// Covers the pattern item keying, the pattern incident lifecycle, the clearing
// and resolve passes leaving a sticky incident alone, triage marking it,
// the cooldown after a person resolves one, reminders, and the human actions.
// Nothing here reaches the network: the mail transport is stubbed and no AI
// provider is configured (the rule-based digest is what triage writes).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting, getOpsAgentSettings } = require('../services/settings');
const agent = require('../services/opsAgent');
const engine = require('../services/agentObservations');
const alertNotifier = require('../services/alertNotifier');
const teams = require('../services/opsAgentTeams');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const at = (n) => new Date(T0 + n * 15 * 60000).toISOString();
const NOW = at(12);
const OBS = { enabled: true, sustainSamples: 3, clearSamples: 2, patternMin: 3, patternDays: 7, historyDays: 90, disabledIds: [] };
const KEY = 'vcenter:1:vm:web-01';
const PKEY = `pattern:vcenter:vm-cpu:${KEY}`;
const settings = { ...getOpsAgentSettings(), minSeverity: 'warning', holdMinutes: 10, renotifyMinutes: 60, observations: OBS };

const cpu = () => engine.getObserver('vcenter:vm-cpu');
const sample = (n, v, key = KEY, label = 'web-01') => ({ subjectKey: key, label, host: label, sourceId: 1, sourceName: 'vc-a', value: v, capturedAt: at(n), context: { cpuCount: 4, esxHost: 'esx-01' } });
const burst = (b, key, label) => [sample(b, 95, key, label), sample(b + 1, 96, key, label), sample(b + 2, 50, key, label), sample(b + 3, 50, key, label)];
const feed = (list) => engine.ingest(cpu(), list, at(300), OBS, { warn: 90, crit: 100 });
const bursts = (starts, key, label) => feed(starts.flatMap((b) => burst(b, key, label)));
const itemsAt = (now) => engine.collectItems(now, OBS);
const incidents = () => db.prepare('SELECT * FROM ops_incidents ORDER BY id').all();
const alertsOf = (id) => db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ? ORDER BY rowid').all(id);
const row = (id) => db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);
const tick = (now, items, extra = {}) => agent.groupTick(now, settings, { items, failed: [], ...extra });

function insertIncident(o = {}) {
  return db.prepare(`
    INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count,
      baseline, requires_human, notified_at, notify_count, email_to, teams_notified_at, reminder_at, reminder_count, acknowledged_at,
      snoozed_until, resolved_at, resolved_by, cleared_since, triaged_at, analysis_json)
    VALUES (?, ?, ?, '["vcenter"]', 'warning', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(o.key || 'host:web-01', o.title || 'web-01 CPU bursts', o.host === undefined ? 'web-01' : o.host, o.state || 'notified',
    o.openedAt || NOW, o.openedAt || NOW, o.openedAt || NOW, o.baseline ? 1 : 0, o.sticky === false ? 0 : 1,
    o.notifiedAt === undefined ? NOW : o.notifiedAt, o.notifyCount === undefined ? 1 : o.notifyCount, o.emailTo === undefined ? 'ops@example.com' : o.emailTo,
    o.teamsAt || null, o.reminderAt || null, o.reminderCount || 0, o.ackAt || null, o.snoozedUntil || null,
    o.resolvedAt || null, o.resolvedBy || null, o.clearedSince || null, o.triagedAt || NOW,
    JSON.stringify({ source: 'ai', classification: 'recurring', confidence: 'medium', title: o.title || 'web-01 CPU bursts', summary: 's', human_required: true })).lastInsertRowid;
}

beforeEach(() => {
  db.exec('DELETE FROM ops_observations; DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_agent_runs;');
  setSetting('ops_agent_enabled', '1');
  for (const k of ['ops_agent_sticky_repeats', 'ops_agent_reminder_hours', 'ops_agent_pattern_cooldown_days', 'ops_agent_pattern_min', 'ops_agent_pattern_days', 'llm_custom_endpoint']) setSetting(k, '');
});

describe('pattern items', () => {
  it('carry the pattern group key, a title and the burst list', () => {
    bursts([0, 4, 8]);
    const [it] = itemsAt(NOW).filter((i) => i.kind === 'observation-pattern');
    expect(it.groupKey).toBe(PKEY);
    expect(it.title).toBe('web-01: VM CPU bursts (3 in 7 days)');
    expect(it.pattern).toMatchObject({ observerId: 'vcenter:vm-cpu', subjectKey: KEY, subjectLabel: 'web-01', count: 3 });
    expect(it.pattern.bursts).toHaveLength(3);
    expect(it.pattern.bursts[0]).toMatchObject({ unit: '%' });
    // firstSeen is the NEWEST burst, so a resolved pattern only returns for a newer one.
    expect(it.firstSeen).toBe(it.pattern.bursts[2].closedAt);
  });

  it('key onto pattern: in platform, service, component and site modes', () => {
    bursts([0, 4, 8]);
    const [it] = itemsAt(NOW);
    for (const mode of ['platform', 'service', 'component', 'site']) {
      expect(agent.incidentKeyFor(it, new Set(['vcenter']), { mode, appOf: new Map(), siteOf: () => ({ siteKey: 'phx' }) })).toBe(PKEY);
    }
  });

  it('never join a platform burst and never fold into a wide incident', () => {
    bursts([0, 4, 8]);
    const others = Array.from({ length: 9 }, (_, i) => ({ platform: 'vcenter', sourceKey: `v${i}`, severity: 'critical', host: `esx-${i}.lab`, message: 'down', firstSeen: NOW, lastSeen: NOW }));
    tick(NOW, [...others, ...itemsAt(NOW)]);
    const keys = incidents().map((i) => i.incident_key);
    expect(keys).toContain(PKEY);
    expect(keys.some((k) => k.endsWith(':wide'))).toBe(false);
    expect(keys.filter((k) => k === PKEY)).toHaveLength(1);
  });
});

describe('pattern incident lifecycle', () => {
  it('opens sticky and due for triage at once, with its occurrences', () => {
    bursts([0, 4, 8]);
    const stats = tick(NOW, itemsAt(NOW));
    expect(stats.incidentsOpened).toBe(1);
    const [inc] = incidents();
    expect(inc).toMatchObject({ incident_key: PKEY, host: 'web-01', state: 'collecting', requires_human: 1, occurrences: 3, severity: 'warning' });
    expect(inc.hold_until).toBe(NOW);
    expect(inc.title).toBe('web-01: VM CPU bursts (3 in 7 days)');
    expect(alertsOf(inc.id)[0].source_key).toBe(`obs-pattern:vcenter:vm-cpu:${KEY}`);
  });

  it('a higher count bumps occurrences and queues a re-triage once the cooldown has passed', () => {
    bursts([0, 4, 8]);
    tick(NOW, itemsAt(NOW));
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET state = 'notified', triaged_at = ? WHERE id = ?").run(at(0), inc.id);
    bursts([12]);
    const later = at(60);
    tick(later, itemsAt(later));
    const after = row(inc.id);
    expect(after.occurrences).toBe(4);
    expect(after.state).toBe('collecting');
    expect(after.hold_until).toBe(later);
    expect(after.event_count).toBe(2);
  });

  it('a higher count inside the re-triage cooldown only updates the count', () => {
    bursts([0, 4, 8]);
    tick(NOW, itemsAt(NOW));
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET state = 'notified', triaged_at = ? WHERE id = ?").run(at(13), inc.id);
    bursts([12]);
    tick(at(14), itemsAt(at(14)));
    const after = row(inc.id);
    expect(after.occurrences).toBe(4);
    expect(after.state).toBe('notified');
  });

  it('survives its alerts vanishing: the clearing pass leaves a sticky incident in its state', () => {
    bursts([0, 4, 8]);
    tick(NOW, itemsAt(NOW));
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET state = 'notified', triaged_at = ?, notified_at = ?, notify_count = 1 WHERE id = ?").run(NOW, NOW, inc.id);
    tick(at(20), []);   // the pattern window moved on: the item is gone
    expect(alertsOf(inc.id)[0].cleared_at).not.toBeNull();
    expect(row(inc.id)).toMatchObject({ state: 'notified', resolved_at: null });
    tick(at(200), []);
    expect(row(inc.id).state).toBe('notified');
  });

  it('is not self-cleared even before triage', () => {
    bursts([0, 4, 8]);
    tick(NOW, itemsAt(NOW));
    const [inc] = incidents();
    tick(at(12), []);
    expect(row(inc.id).state).toBe('collecting');
  });

  it('a non-sticky incident is still closed by the clearing pass (control)', () => {
    tick(NOW, [{ platform: 'dell', sourceKey: 'd1', severity: 'critical', host: 'esx-9.lab', message: 'x', firstSeen: NOW }]);
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET state = 'triaged', triaged_at = ? WHERE id = ?").run(NOW, inc.id);
    tick(at(12), [], {});
    expect(['clearing', 'resolved']).toContain(row(inc.id).state);
  });
});

describe('resolvePass leaves sticky incidents alone', () => {
  const CONFIG = { smtpHost: '', smtpFrom: '', smtpRecipients: '' };
  const cfg = { ...settings, autoResolveMinutes: 30, evidenceResolve: true, name: 'Otis', emailEnabled: false };

  afterEach(() => setSetting('llm_custom_endpoint', ''));

  it('quiet close skips a sticky incident in clearing and closes a plain one', async () => {
    const sticky = insertIncident({ state: 'clearing', clearedSince: at(0), key: 'host:a' });
    const plain = insertIncident({ state: 'clearing', clearedSince: at(0), key: 'host:b', sticky: false });
    const out = await agent.resolvePass(at(40), cfg, CONFIG, 5);
    expect(out.resolvedQuiet).toBe(1);
    expect(row(sticky).state).toBe('clearing');
    expect(row(plain).state).toBe('resolved');
  });

  it('the evidence check never even considers a sticky incident', async () => {
    setSetting('llm_custom_endpoint', 'http://127.0.0.1:1/v1');
    const old = '2026-10-01T00:00:00.000Z';
    const sticky = insertIncident({ state: 'notified', key: 'host:a', openedAt: old });
    const plain = insertIncident({ state: 'notified', key: 'host:b', openedAt: old, sticky: false });
    db.prepare('UPDATE ops_incidents SET last_event_at = ? WHERE id IN (?, ?)').run(old, sticky, plain);
    await agent.resolvePass(NOW, cfg, CONFIG, 5);
    expect(row(sticky).evidence_check_at).toBeNull();
    expect(row(plain).evidence_check_at).not.toBeNull();
  });
});

describe('triage marks incidents sticky', () => {
  it('a pattern incident is sticky, recurring, human required and carries evidence.pattern', async () => {
    bursts([0, 4, 8]);
    tick(NOW, itemsAt(NOW));
    const [inc] = incidents();
    db.prepare('UPDATE ops_incidents SET requires_human = 0 WHERE id = ?').run(inc.id);   // prove triage sets it, not just the insert
    const a = await agent.triageIncident(row(inc.id));
    const after = row(inc.id);
    expect(after.requires_human).toBe(1);
    expect(after.classification).toBe('recurring');
    expect(a.human_required).toBe(true);
    const ev = JSON.parse(after.evidence_json);
    expect(ev.pattern).toMatchObject({ observerId: 'vcenter:vm-cpu', subjectLabel: 'web-01', count: 3, windowDays: 7, unit: '%' });
    expect(ev.pattern.bursts).toHaveLength(3);
    expect(ev.pattern.longestMinutes).toBeGreaterThan(0);
    expect(after.summary).toContain('web-01 ran hot in 3 short bursts in the last 7 days');
    expect(after.summary).toContain('This stays open until someone investigates.');
    expect(a.human_reason).toContain('short bursts');
  });

  it('the prompt carries the cadence sentence only for a pattern', () => {
    const base = { incident: { platforms: ['vcenter'] }, alerts: [] };
    expect(agent.systemPromptFor({ ...base, pattern: { count: 3 } }).system).toContain('the same short condition keeps returning');
    expect(agent.systemPromptFor(base).system).not.toContain('the same short condition keeps returning');
  });

  function repeats(key, host, { extraAfterResolve = 0 } = {}) {
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    const mk = (openedAt, resolvedAt, o = {}) => insertIncident({ key, host, title: 'Backup missed', state: resolvedAt ? 'resolved' : 'collecting', openedAt, resolvedAt, resolvedBy: resolvedAt ? (o.by || 'agent') : null, sticky: !!o.sticky, notifiedAt: null, notifyCount: 0, emailTo: null, triagedAt: null });
    mk(ago(50), ago(49));
    mk(ago(26), ago(25));
    for (let i = 0; i < extraAfterResolve; i += 1) mk(ago(4 - i * 0.5), ago(3.9 - i * 0.5));
    return { mkCurrent: () => mk(ago(1), null), mkResolvedSticky: () => mk(ago(10), ago(5), { by: 'doug', sticky: true }) };
  }

  it('a repeat is sticky with the setting on (the default) and not with it off', async () => {
    const { mkCurrent } = repeats('host:db-11', 'db-11');
    setSetting('ops_agent_pattern_min', '3');
    setSetting('ops_agent_pattern_days', '14');
    const id = mkCurrent();
    await agent.triageIncident(row(id));
    expect(row(id).requires_human).toBe(1);
    expect(row(id).occurrences).toBe(3);

    db.prepare('UPDATE ops_incidents SET requires_human = 0 WHERE id = ?').run(id);
    setSetting('ops_agent_sticky_repeats', '0');
    await agent.triageIncident(row(id));
    expect(row(id).requires_human).toBe(0);
    expect(JSON.parse(row(id).analysis_json).human_required).toBe(true);   // still told to a person, just not sticky
  });

  it('a repeat right after a person resolved the same key stays plain until it repeats again', async () => {
    const { mkCurrent, mkResolvedSticky } = repeats('host:db-12', 'db-12');
    setSetting('ops_agent_pattern_min', '3');
    setSetting('ops_agent_pattern_days', '14');
    mkResolvedSticky();
    const id = mkCurrent();
    await agent.triageIncident(row(id));
    expect(row(id).requires_human).toBe(0);
    const cd = agent.stickyCooldown('host:db-12', getOpsAgentSettings());
    expect(cd).toMatchObject({ sinceCount: 1, need: 3, suppressed: true });
  });

  it('a repeat that reaches the occurrence count again after the resolution is sticky again', async () => {
    const { mkCurrent, mkResolvedSticky } = repeats('host:db-13', 'db-13', { extraAfterResolve: 2 });
    setSetting('ops_agent_pattern_min', '3');
    setSetting('ops_agent_pattern_days', '14');
    mkResolvedSticky();
    const id = mkCurrent();
    await agent.triageIncident(row(id));
    expect(row(id).requires_human).toBe(1);
  });
});

describe('cooldown after a person resolves a pattern incident', () => {
  function resolvedByPerson(resolvedAt) {
    return insertIncident({ key: PKEY, state: 'resolved', sticky: true, resolvedAt, resolvedBy: 'doug' });
  }

  it('opens nothing until patternMin new bursts exist after the resolution', () => {
    bursts([0, 4, 8]);
    resolvedByPerson(at(12));
    const s1 = tick(at(30), itemsAt(at(30)));
    expect(s1.incidentsOpened).toBe(0);
    expect(incidents().filter((i) => i.state !== 'resolved')).toHaveLength(0);

    bursts([12, 16]);                       // two new bursts, still fewer than three
    expect(tick(at(40), itemsAt(at(40))).incidentsOpened).toBe(0);

    bursts([20]);                           // the third new burst
    const s3 = tick(at(50), itemsAt(at(50)));
    expect(s3.incidentsOpened).toBe(1);
    const open = incidents().filter((i) => i.state !== 'resolved');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ incident_key: PKEY, requires_human: 1, occurrences: 6 });
  });

  it('with the cooldown at 0 days a pattern with any newer burst opens again', () => {
    bursts([0, 4, 8, 12]);
    resolvedByPerson(at(12));
    const off = { ...settings, patternCooldownDays: 0 };
    const stats = agent.groupTick(at(30), off, { items: itemsAt(at(30)), failed: [] });
    expect(stats.incidentsOpened).toBe(1);
  });

  it('a pattern resolved by the agent itself is not a cooldown', () => {
    bursts([0, 4, 8]);
    expect(agent.stickyCooldown(PKEY, settings, { now: at(30), bursts: [] })).toBeNull();
    insertIncident({ key: PKEY, state: 'resolved', sticky: true, resolvedAt: at(12), resolvedBy: 'agent' });
    expect(agent.stickyCooldown(PKEY, settings, { now: at(30), bursts: [] })).toBeNull();
  });
});

describe('reminders', () => {
  const sent = [];
  const realTransport = alertNotifier.createTransport;
  const config = { smtpEnabled: true, smtpHost: 'smtp.example.com', smtpPort: 25, smtpFrom: 'icc@example.com', smtpRecipients: 'default@example.com' };
  const cfg = { ...settings, name: 'Otis', emailEnabled: true, recipients: '', reminderHours: 24, teamsEnabled: false };
  const REAL_NOW = () => new Date().toISOString();
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

  beforeEach(() => {
    sent.length = 0;
    alertNotifier.createTransport = () => ({ sendMail: async (m) => { sent.push(m); } });
  });
  afterEach(() => { alertNotifier.createTransport = realTransport; });

  it('sends after reminderHours with the REMINDER subject, counts it, and does not repeat inside the window', async () => {
    const id = insertIncident({ notifiedAt: hoursAgo(25), notifyCount: 1 });
    const out = await agent.reminderPass(REAL_NOW(), cfg, config);
    expect(out.reminders).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject.startsWith('REMINDER 1 | HUMAN REQUIRED | ')).toBe(true);
    expect(sent[0].to).toBe('ops@example.com');
    expect(sent[0].text).toContain('This is reminder 1. The incident stays open until someone resolves it in ICC (Acknowledge stops these reminders, Snooze pauses them).');
    expect(row(id)).toMatchObject({ reminder_count: 1, state: 'notified', notify_count: 1 });
    expect(row(id).reminder_at).not.toBeNull();

    const again = await agent.reminderPass(REAL_NOW(), cfg, config);
    expect(again.reminders).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('measures from the last send, reminder included', async () => {
    insertIncident({ notifiedAt: hoursAgo(80), notifyCount: 1, reminderAt: hoursAgo(10), reminderCount: 2 });
    expect((await agent.reminderPass(REAL_NOW(), cfg, config)).reminders).toBe(0);
  });

  it('the next reminder carries the next number', async () => {
    insertIncident({ notifiedAt: hoursAgo(80), notifyCount: 1, reminderAt: hoursAgo(30), reminderCount: 2 });
    await agent.reminderPass(REAL_NOW(), cfg, config);
    expect(sent[0].subject.startsWith('REMINDER 3 | ')).toBe(true);
  });

  it('skips an acknowledged, a snoozed, a baseline, a never-notified and a non-sticky incident', async () => {
    insertIncident({ key: 'host:a', notifiedAt: hoursAgo(30), ackAt: hoursAgo(1) });
    insertIncident({ key: 'host:b', notifiedAt: hoursAgo(30), snoozedUntil: new Date(Date.now() + 86400000).toISOString() });
    insertIncident({ key: 'host:c', notifiedAt: hoursAgo(30), baseline: true });
    insertIncident({ key: 'host:d', notifiedAt: null, notifyCount: 0 });
    insertIncident({ key: 'host:e', notifiedAt: hoursAgo(30), sticky: false });
    const out = await agent.reminderPass(REAL_NOW(), cfg, config);
    expect(out.reminders).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('an expired snooze reminds again', async () => {
    insertIncident({ notifiedAt: hoursAgo(30), snoozedUntil: hoursAgo(1) });
    expect((await agent.reminderPass(REAL_NOW(), cfg, config)).reminders).toBe(1);
  });

  it('reminderHours 0 turns reminders off', async () => {
    insertIncident({ notifiedAt: hoursAgo(300) });
    expect((await agent.reminderPass(REAL_NOW(), { ...cfg, reminderHours: 0 }, config)).reminders).toBe(0);
  });

  it('sends nothing while the SMTP switch is off', async () => {
    const id = insertIncident({ notifiedAt: hoursAgo(30) });
    const out = await agent.reminderPass(REAL_NOW(), cfg, { ...config, smtpEnabled: false });
    expect(out.reminders).toBe(0);
    expect(sent).toHaveLength(0);
    expect(row(id).reminder_count).toBe(0);
  });
});

describe('email and Teams carry the sticky facts', () => {
  const inc = { id: 7, title: 'web-01 bursts', host: 'web-01', platforms: '["vcenter"]', severity: 'warning', opened_at: NOW, notify_count: 1 };
  const analysis = { source: 'ai', classification: 'recurring', confidence: 'medium', title: 'web-01 bursts', summary: 'a', impact: 'i', human_required: true, escalate: 'e', next_steps: [] };
  const pattern = { windowDays: 7, count: 2, unit: '%', bursts: [{ openedAt: at(0), closedAt: at(3), minutes: 30, peak: 97 }, { openedAt: at(8), closedAt: at(10), minutes: 15, peak: 93 }] };

  it('renders the reminder line, the burst table and the stays-open line', () => {
    const mail = agent.renderEmail(inc, [], analysis, { reminder: 2, pattern, requiresHuman: true });
    expect(mail.subject.startsWith('REMINDER 2 | HUMAN REQUIRED | WARNING | web-01 | web-01 bursts')).toBe(true);
    expect(mail.text.split('\n')[0]).toContain('This is reminder 2.');
    expect(mail.text).toContain('BURSTS IN THE LAST 7 DAYS (2)');
    expect(mail.text).toContain('| 30 min | 97%');
    expect(mail.text).toContain('This incident stays open until someone resolves it in ICC.');
    expect(mail.html).toContain('<th style="padding:3px 8px">Started</th><th style="padding:3px 8px">Lasted</th><th style="padding:3px 8px">Peak</th>');
  });

  it('a plain email has none of it', () => {
    const mail = agent.renderEmail(inc, [], { ...analysis, human_required: false });
    expect(mail.subject.startsWith('WARNING | ')).toBe(true);
    expect(mail.text).not.toContain('reminder');
    expect(mail.text).not.toContain('BURSTS IN THE LAST');
    expect(mail.text).not.toContain('stays open until someone resolves');
  });

  it('the Teams card says awaiting investigation and numbers the reminder', () => {
    const text = (card) => JSON.stringify(card);
    const card = teams.buildCard({ ...inc, requires_human: 1, acknowledged_at: null }, analysis, { update: true, reminder: 3 });
    expect(text(card)).toContain('Awaiting investigation');
    expect(text(card)).toContain('(reminder 3)');
    const acked = teams.buildCard({ ...inc, requires_human: 1, acknowledged_at: NOW }, analysis, {});
    expect(text(acked)).not.toContain('Awaiting investigation');
  });
});

describe('human actions and the API', () => {
  let app;
  const post = (url, body) => request(app).post(url).set('x-api-key', API_KEY).send(body || {});
  const get = (url) => request(app).get(url).set('x-api-key', API_KEY);
  beforeAll(() => { app = createApp({ licenseGate: (req, res, next) => next() }); });

  it('resolving a sticky incident needs a note; the note becomes the resolution and a notes entry', async () => {
    const id = insertIncident();
    const bad = await post(`/api/ops-agent/incidents/${id}/resolve`, {});
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'A resolution note is required for an incident that was waiting on a person.', field: 'note' });
    expect(row(id).state).toBe('notified');
    const blank = await post(`/api/ops-agent/incidents/${id}/resolve`, { note: '   ' });
    expect(blank.status).toBe(400);

    const ok = await post(`/api/ops-agent/incidents/${id}/resolve`, { note: 'Nightly export job; moved it off the busy hour.' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id, state: 'resolved', resolution: 'Nightly export job; moved it off the busy hour.', requiresHuman: true, awaitingHuman: false });
    expect(ok.body.resolvedBy).toBeTruthy();
    expect(ok.body.notes).toHaveLength(1);
    expect(ok.body.notes[0]).toMatchObject({ kind: 'resolve', text: 'Nightly export job; moved it off the busy hour.' });
    expect(typeof ok.body.notes[0].at).toBe('string');
  });

  it('resolving a plain incident needs no note', async () => {
    const id = insertIncident({ sticky: false });
    const res = await post(`/api/ops-agent/incidents/${id}/resolve`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'resolved', resolution: null, notes: [] });
  });

  it('resolve, ack and snooze answer 404 for an unknown or already resolved incident', async () => {
    expect((await post('/api/ops-agent/incidents/99999/resolve', { note: 'x' })).status).toBe(404);
    expect((await post('/api/ops-agent/incidents/99999/ack', {})).status).toBe(404);
    expect((await post('/api/ops-agent/incidents/99999/snooze', { days: 3 })).status).toBe(404);
    const id = insertIncident({ state: 'resolved', resolvedAt: NOW, resolvedBy: 'doug' });
    expect((await post(`/api/ops-agent/incidents/${id}/ack`, {})).status).toBe(404);
  });

  it('ack stops the awaiting flag and records the optional note; unack restores it', async () => {
    const id = insertIncident();
    const ack = await post(`/api/ops-agent/incidents/${id}/ack`, { note: 'On it, checking the job schedule.' });
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect(ack.body.acknowledgedBy).toBeTruthy();
    expect(ack.body.awaitingHuman).toBe(false);
    expect(ack.body.state).toBe('notified');
    expect(ack.body.notes[0]).toMatchObject({ kind: 'ack', text: 'On it, checking the job schedule.' });
    const un = await post(`/api/ops-agent/incidents/${id}/unack`, {});
    expect(un.body).toMatchObject({ acknowledgedAt: null, acknowledgedBy: null, awaitingHuman: true });
    const quiet = await post(`/api/ops-agent/incidents/${id}/ack`, {});
    expect(quiet.body.notes).toHaveLength(1);   // no note given, nothing appended
  });

  it('snooze sets and clears snoozed_until and rejects bad days', async () => {
    const id = insertIncident();
    const s = await post(`/api/ops-agent/incidents/${id}/snooze`, { days: 7 });
    expect(s.status).toBe(200);
    expect(s.body.snoozed).toBe(true);
    expect(s.body.awaitingHuman).toBe(false);
    const days = (Date.parse(s.body.snoozedUntil) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(s.body.state).toBe('notified');
    expect(s.body.notes[0]).toMatchObject({ kind: 'snooze' });

    const cleared = await post(`/api/ops-agent/incidents/${id}/snooze`, { days: 0 });
    expect(cleared.body).toMatchObject({ snoozed: false, snoozedUntil: null, awaitingHuman: true });

    for (const bad of [-1, 91, 1.5, 'x', undefined]) {
      const r = await post(`/api/ops-agent/incidents/${id}/snooze`, bad === undefined ? {} : { days: bad });
      expect(r.status).toBe(400);
      expect(r.body.field).toBe('days');
    }
  });

  it('a snoozed incident keeps attaching alerts and stays open', () => {
    bursts([0, 4, 8]);
    tick(NOW, itemsAt(NOW));
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET snoozed_until = ?, state = 'notified', triaged_at = ? WHERE id = ?").run(new Date(Date.now() + 86400000).toISOString(), at(0), inc.id);
    bursts([12]);
    tick(at(60), itemsAt(at(60)));
    expect(row(inc.id).occurrences).toBe(4);
    expect(row(inc.id).state).toBe('collecting');
    expect(row(inc.id).resolved_at).toBeNull();
  });

  it('status counts and listIncidents needsHuman', async () => {
    const waiting = insertIncident({ key: 'pattern:a', host: 'a' });
    const acked = insertIncident({ key: 'pattern:b', host: 'b', ackAt: NOW });
    const snoozed = insertIncident({ key: 'pattern:c', host: 'c', snoozedUntil: new Date(Date.now() + 86400000).toISOString() });
    insertIncident({ key: 'host:plain', host: 'plain', sticky: false });
    insertIncident({ key: 'pattern:done', host: 'done', state: 'resolved', resolvedAt: NOW, resolvedBy: 'doug' });

    const st = (await get('/api/ops-agent/status')).body;
    expect(st.counts).toMatchObject({ awaitingHuman: 1, acknowledged: 1, snoozed: 1 });

    const all = (await get('/api/ops-agent/incidents?state=open')).body;
    expect(all).toHaveLength(4);
    const first = all[0];
    expect(first.id).toBe(waiting);   // awaiting human sorts first (+400)
    expect(first).toMatchObject({ requiresHuman: true, awaitingHuman: true, kind: 'pattern', occurrences: 1, notes: [], reminderCount: 0 });

    const needs = (await get('/api/ops-agent/incidents?needsHuman=1')).body;
    expect(needs.map((i) => i.id).sort()).toEqual([waiting, acked, snoozed].sort());
    expect(agent.listIncidents({ needsHuman: true })).toHaveLength(3);
  });

  it('the pulse token moves when an incident is acknowledged, snoozed or reminded', () => {
    const id = insertIncident();
    const t0 = agent.pulse().token;
    agent.acknowledge(id, 'doug');
    const t1 = agent.pulse().token;
    expect(t1).not.toBe(t0);
    agent.snooze(id, 2, 'doug');
    const t2 = agent.pulse().token;
    expect(t2).not.toBe(t1);
    db.prepare('UPDATE ops_incidents SET reminder_at = ?, reminder_count = reminder_count + 1 WHERE id = ?').run(NOW, id);
    expect(agent.pulse().token).not.toBe(t2);
  });

  it('kindOfKey reports pattern for pattern keys', () => {
    const id = insertIncident({ key: PKEY });
    expect(agent.getIncident(id).kind).toBe('pattern');
  });
});

describe('settings', () => {
  let app;
  const put = (body) => request(app).put('/api/settings').set('x-api-key', API_KEY).send(body);
  beforeAll(() => { app = createApp({ licenseGate: (req, res, next) => next() }); });

  it('defaults, round trip and out-of-range values', async () => {
    const d = getOpsAgentSettings();
    expect(d).toMatchObject({ stickyRepeats: true, reminderHours: 24, patternCooldownDays: 14 });
    const res = await put({ opsAgent: { stickyRepeats: false, reminderHours: 48, patternCooldownDays: 30 } });
    expect(res.status).toBe(200);
    expect(getOpsAgentSettings()).toMatchObject({ stickyRepeats: false, reminderHours: 48, patternCooldownDays: 30 });
    await put({ opsAgent: { reminderHours: 0, patternCooldownDays: 0 } });
    expect(getOpsAgentSettings()).toMatchObject({ reminderHours: 0, patternCooldownDays: 0 });
    await put({ opsAgent: { reminderHours: 999, patternCooldownDays: 91, stickyRepeats: true } });
    expect(getOpsAgentSettings()).toMatchObject({ stickyRepeats: true, reminderHours: 24, patternCooldownDays: 14 });
    for (const k of ['ops_agent_sticky_repeats', 'ops_agent_reminder_hours', 'ops_agent_pattern_cooldown_days']) setSetting(k, '');
  });
});

describe('migration 31', () => {
  it('adds the sticky columns and the index to ops_incidents', () => {
    const cols = new Map(db.prepare('PRAGMA table_info(ops_incidents)').all().map((c) => [c.name, c]));
    for (const c of ['requires_human', 'acknowledged_at', 'acknowledged_by', 'snoozed_until', 'reminder_at', 'reminder_count', 'occurrences', 'notes_json']) {
      expect(cols.has(c), c).toBe(true);
    }
    expect(cols.get('requires_human')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(cols.get('reminder_count')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(cols.get('occurrences')).toMatchObject({ notnull: 1, dflt_value: '1' });
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ops_incidents_human'").get();
    expect(idx).toBeTruthy();
  });
});
