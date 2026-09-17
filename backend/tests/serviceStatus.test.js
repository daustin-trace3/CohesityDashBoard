/**
 * Service Status backend: sweep (event create/refresh/clear), reachability
 * from poller_status, per-platform state timeline, the AI analysis worker
 * (dedupe + rate cap + verdict-override rule), deriveVerdict as a pure
 * function, and the read/analyze routes. Self-contained express app +
 * supertest against the shared per-file test DB (mirrors tests/topology.test.js).
 *
 * AI is kept OFF (service_status_ai_enabled='0', no token) for the sweep/
 * reachability/timeline tests so the fire-and-forget runPending() call each
 * sweep makes resolves synchronously to analysis_status 'disabled' instead
 * of racing a real network call. Tests that exercise the AI path enable it
 * explicitly and call runPending() directly (awaited), never through sweep().
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const registry = require('../core/registry');
const { setSetting } = require('../services/settings');
const pollerStatus = require('../services/pollerStatus');
const svc = require('../services/serviceStatus');
const serviceStatusRouter = require('../routes/serviceStatus');

let app;
let seq = 0;
function nextName(prefix) { seq += 1; return `${prefix}-${seq}`; }

function makeItem(platform, overrides = {}) {
  const now = new Date().toISOString();
  return {
    platform,
    sourceKey: overrides.sourceKey || nextName('key'),
    severity: overrides.severity || 'critical',
    host: overrides.host || 'host-a',
    message: overrides.message || 'something broke',
    firstSeen: overrides.firstSeen || now,
    lastSeen: overrides.lastSeen || now,
  };
}

function clearAll() {
  db.exec('DELETE FROM service_alert_events');
  db.exec('DELETE FROM service_alert_analyses');
  db.exec('DELETE FROM service_status_timeline');
  db.exec('DELETE FROM poller_status');
  db.exec('DELETE FROM dell_ome_instances');
  db.exec('DELETE FROM dell_devices');
  db.exec('DELETE FROM ai_audit_exchanges');
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
  app.use('/api/service-status', serviceStatusRouter);

  // Registry-gated platforms (Service Status enablement is registry-driven,
  // not the settings platform toggles) , a minimal fake manifest per id.
  for (const id of ['dell', 'zerto']) {
    registry.registerPlugin({
      id, name: id, apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
    });
  }
});

beforeEach(() => {
  clearAll();
  setSetting('service_status_ai_enabled', '0');
  setSetting('service_status_analyses_per_minute', '3');
  setSetting('service_status_dedupe_minutes', '60');
  svc._resetTestSeams();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  svc._resetTestSeams();
});

function openEvents(platform) {
  return db.prepare('SELECT * FROM service_alert_events WHERE platform = ? AND cleared_at IS NULL').all(platform);
}
function lastTimeline(platform) {
  return db.prepare('SELECT * FROM service_status_timeline WHERE platform = ? ORDER BY id DESC LIMIT 1').get(platform);
}

describe('sweep', () => {
  it('1) one critical + one warning: exactly one pending event created; timeline degraded', async () => {
    svc._setCollector(() => ({
      items: [
        makeItem('dell', { sourceKey: 'crit-1', severity: 'critical', host: 'r740-01' }),
        makeItem('dell', { sourceKey: 'warn-1', severity: 'warning', host: 'r740-02' }),
      ],
      failed: [],
    }));
    await svc.sweep();

    const events = db.prepare('SELECT * FROM service_alert_events').all();
    expect(events).toHaveLength(1);
    expect(events[0].source_key).toBe('crit-1');
    expect(lastTimeline('dell').state).toBe('degraded');
  });

  it('2) a second sweep with the same critical: still one event, last_seen_at advances, no new timeline row', async () => {
    svc._setCollector(() => ({ items: [makeItem('dell', { sourceKey: 'crit-1' })], failed: [] }));
    await svc.sweep();
    const first = db.prepare('SELECT * FROM service_alert_events').get();
    const timelineCountBefore = db.prepare('SELECT COUNT(*) c FROM service_status_timeline').get().c;

    await new Promise((r) => setTimeout(r, 5));
    await svc.sweep();

    const events = db.prepare('SELECT * FROM service_alert_events').all();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(first.id);
    expect(events[0].last_seen_at >= first.last_seen_at).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM service_status_timeline').get().c).toBe(timelineCountBefore);
  });

  it('3) collector drops the critical: cleared_at is set, timeline appends an ok row', async () => {
    svc._setCollector(() => ({ items: [makeItem('dell', { sourceKey: 'crit-1' })], failed: [] }));
    await svc.sweep();
    expect(openEvents('dell')).toHaveLength(1);

    svc._setCollector(() => ({ items: [], failed: [] }));
    await svc.sweep();

    expect(openEvents('dell')).toHaveLength(0);
    const row = db.prepare('SELECT * FROM service_alert_events WHERE source_key = ?').get('crit-1');
    expect(row.cleared_at).not.toBeNull();
    expect(lastTimeline('dell').state).toBe('ok');
  });

  it('4) collector reports the platform in `failed`: its open events are NOT cleared', async () => {
    svc._setCollector(() => ({ items: [makeItem('dell', { sourceKey: 'crit-1' })], failed: [] }));
    await svc.sweep();
    expect(openEvents('dell')).toHaveLength(1);

    svc._setCollector(() => ({ items: [], failed: ['dell'] }));
    await svc.sweep();

    expect(openEvents('dell')).toHaveLength(1);
  });

  it("5) zerto 'error' is critical; dell 'error' is not", async () => {
    svc._setCollector(() => ({
      items: [
        makeItem('zerto', { sourceKey: 'z-1', severity: 'error', host: 'site-a' }),
        makeItem('dell', { sourceKey: 'd-1', severity: 'error', host: 'r740-03' }),
      ],
      failed: [],
    }));
    await svc.sweep();

    expect(openEvents('zerto')).toHaveLength(1);
    expect(openEvents('dell')).toHaveLength(0);
  });

  it('11) reachability: a poll error becomes a poll: event with the source name as host; deriveVerdict offline; timeline offline', async () => {
    db.prepare(`
      INSERT INTO dell_ome_instances (id, name, host, username, encrypted_credentials)
      VALUES (5, 'ome-prod-05', 'ome05.corp.local', 'admin', 'enc')
    `).run();
    pollerStatus.markEnd('dell', 5, 'error');

    svc._setCollector(() => ({ items: [], failed: [] }));
    await svc.sweep();

    const row = db.prepare("SELECT * FROM service_alert_events WHERE platform = 'dell' AND source_key = 'poll:5'").get();
    expect(row).toBeTruthy();
    expect(row.host).toBe('ome-prod-05');
    // The platform's only source is unreachable, so the platform is offline.
    expect(lastTimeline('dell').state).toBe('offline');
    expect(lastTimeline('dell').reason).toBe('1 open critical alert, source unreachable');
  });

  it('12) one of two sources unreachable -> platform degraded; both unreachable -> offline; board counts sources', async () => {
    const ins = db.prepare(`
      INSERT INTO dell_ome_instances (id, name, host, username, encrypted_credentials)
      VALUES (?, ?, ?, 'admin', 'enc')
    `);
    ins.run(7, 'ome-east', 'ome-east.corp.local');
    ins.run(8, 'ome-west', 'ome-west.corp.local');
    pollerStatus.markEnd('dell', 7, 'error');
    pollerStatus.markEnd('dell', 8, 'success');
    svc._setCollector(() => ({ items: [], failed: [] }));

    await svc.sweep();
    expect(openEvents('dell').map((e) => e.host)).toEqual(['ome-east']);
    expect(lastTimeline('dell').state).toBe('degraded');
    expect(lastTimeline('dell').reason).toBe('1 open critical alert, 1 of 2 sources unreachable');

    const board = svc.getBoard({ days: 7 }).platforms.find((p) => p.id === 'dell');
    expect(board.current).toMatchObject({ state: 'degraded', openEvents: 1, sourcesPolled: 2, sourcesUnreachable: 1, openOffline: 0 });

    pollerStatus.markEnd('dell', 8, 'error');
    await svc.sweep();
    expect(lastTimeline('dell').state).toBe('offline');
    expect(lastTimeline('dell').reason).toBe('2 open critical alerts, all 2 sources unreachable');
  });

  it('13) a poller_status row left behind by a deleted source raises no event and clears an existing one', async () => {
    db.prepare(`
      INSERT INTO dell_ome_instances (id, name, host, username, encrypted_credentials)
      VALUES (9, 'ome-old', 'ome-old.corp.local', 'admin', 'enc')
    `).run();
    pollerStatus.markEnd('dell', 9, 'error');
    svc._setCollector(() => ({ items: [], failed: [] }));
    await svc.sweep();
    expect(openEvents('dell')).toHaveLength(1);
    expect(lastTimeline('dell').state).toBe('offline');

    // Doug removes the OME instance; its poller_status row survives with 'error'.
    db.prepare('DELETE FROM dell_ome_instances WHERE id = 9').run();
    await svc.sweep();
    expect(openEvents('dell')).toHaveLength(0);
    expect(lastTimeline('dell').state).toBe('ok');
    // The cleared event says why it cleared, and a second sweep does not stack the suffix.
    await svc.sweep();
    const cleared = db.prepare("SELECT host, cleared_at FROM service_alert_events WHERE platform = 'dell' AND source_key = 'poll:9'").get();
    expect(cleared.cleared_at).toBeTruthy();
    expect(cleared.host).toBe('ome-old (source removed)');
    const evidence = svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, { hostRecords: [], platformPolls: svc._platformPollsFor('dell') });
    expect(evidence.verdict).toBe('degraded'); // the stale key no longer reads as "every poll errored"
  });

  it('14) a host analysed as offline leaves the platform degraded while its sources still answer', async () => {
    db.prepare(`
      INSERT INTO dell_ome_instances (id, name, host, username, encrypted_credentials)
      VALUES (10, 'ome-live', 'ome-live.corp.local', 'admin', 'enc')
    `).run();
    pollerStatus.markEnd('dell', 10, 'success');
    svc._setCollector(() => ({ items: [makeItem('dell', { sourceKey: 'dell-host-down', host: 'esx-99' })], failed: [] }));
    await svc.sweep();
    const ev = openEvents('dell')[0];
    // The sweep already wrote the evidence-only analysis (AI off); flip its verdict.
    db.prepare("UPDATE service_alert_analyses SET verdict = 'offline' WHERE event_id = ?").run(ev.id);
    await svc.sweep();
    // Still degraded, so no new timeline row; the board's live counters carry the verdict count.
    expect(lastTimeline('dell').state).toBe('degraded');
    const board = svc.getBoard({ days: 7 }).platforms.find((p) => p.id === 'dell');
    expect(board.current).toMatchObject({ state: 'degraded', openOffline: 1, sourcesPolled: 1, sourcesUnreachable: 0 });
  });
});

describe('deriveVerdict (pure function)', () => {
  it('1) poll: source key -> offline, high', () => {
    const v = svc.deriveVerdict({ source_key: 'poll:5', platform: 'dell' }, { hostRecords: [], platformPolls: [] });
    expect(v).toMatchObject({ verdict: 'offline', confidence: 'high' });
  });

  it('2) an own-platform record with up === false -> offline, high', () => {
    const evidence = { hostRecords: [{ platform: 'dell', up: false }], platformPolls: [] };
    const v = svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, evidence);
    expect(v).toMatchObject({ verdict: 'offline', confidence: 'high' });
  });

  it('3) an own-platform record with up === true (none false) -> degraded, high', () => {
    const evidence = { hostRecords: [{ platform: 'dell', up: true }], platformPolls: [] };
    const v = svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, evidence);
    expect(v).toMatchObject({ verdict: 'degraded', confidence: 'high' });
  });

  it('4) no own-platform record, another platform record up===false -> offline, medium; up===true -> degraded, medium', () => {
    const offlineEvidence = { hostRecords: [{ platform: 'vcenter', up: false }], platformPolls: [] };
    expect(svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, offlineEvidence)).toMatchObject({ verdict: 'offline', confidence: 'medium' });

    const degradedEvidence = { hostRecords: [{ platform: 'vcenter', up: true }], platformPolls: [] };
    expect(svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, degradedEvidence)).toMatchObject({ verdict: 'degraded', confidence: 'medium' });
  });

  it('5) nothing found: every platform poll errored -> offline, low; otherwise -> degraded, low', () => {
    const allErrored = { hostRecords: [], platformPolls: [{ lastPollStatus: 'error' }, { lastPollStatus: 'error' }] };
    expect(svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, allErrored)).toMatchObject({ verdict: 'offline', confidence: 'low' });

    const nothing = { hostRecords: [], platformPolls: [] };
    const v = svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, nothing);
    expect(v).toMatchObject({ verdict: 'degraded', confidence: 'low' });
    expect(v.reason).toMatch(/no inventory record/i);
  });

  it('3b) own-platform record with no live up/down field -> degraded, medium, names the record', () => {
    const known = { hostRecords: [{ platform: 'cohesity', name: 'nyc-coh-prd-01', up: null, fields: {} }], platformPolls: [] };
    const v = svc.deriveVerdict({ source_key: 'k1', platform: 'cohesity' }, known);
    expect(v).toMatchObject({ verdict: 'degraded', confidence: 'medium' });
    expect(v.reason).toMatch(/inventory record for this system/i);
  });
});

describe('isCriticalSeverity', () => {
  it('applies the default set except for zerto, which uses its own', () => {
    expect(svc.isCriticalSeverity('dell', 'critical')).toBe(true);
    expect(svc.isCriticalSeverity('dell', 'error')).toBe(false);
    expect(svc.isCriticalSeverity('zerto', 'error')).toBe(true);
    expect(svc.isCriticalSeverity('zerto', 'critical')).toBe(false);
    expect(svc.isCriticalSeverity('dell', 'warning')).toBe(false);
  });
});

describe('runPending (AI analysis)', () => {
  // Creates one event via a real sweep (AI off, so it lands 'disabled'
  // deterministically), then resets it to 'pending' so the AI path under
  // test starts clean.
  function seedPendingEvent(overrides = {}) {
    svc._setCollector(() => ({ items: [makeItem('dell', overrides)], failed: [] }));
    return svc.sweep().then(() => {
      const row = db.prepare('SELECT * FROM service_alert_events WHERE platform = ? AND source_key = ?')
        .get('dell', overrides.sourceKey);
      db.prepare("UPDATE service_alert_events SET analysis_status = 'pending' WHERE id = ?").run(row.id);
      return row.id;
    });
  }

  it('6) AI verdict offline WITH a reason: stored, platform stays degraded (its sources still answer), an audit exchange is recorded', async () => {
    const id = await seedPendingEvent({ sourceKey: 'e6', host: 'r740-06' });
    setSetting('service_status_ai_enabled', '1');
    process.env.OPENAI_API_KEY = 'test-token';
    svc._setChat(async () => JSON.stringify({
      verdict: 'offline', verdict_reason: 'confirmed unreachable via IPMI',
      why: 'power fault', actions: ['check psu', 'check idrac'], current_state: 'unreachable', confidence: 'high',
    }));

    await svc.runPending();

    const analysis = db.prepare('SELECT * FROM service_alert_analyses WHERE event_id = ?').get(id);
    expect(analysis.ai_verdict).toBe('offline');
    expect(analysis.verdict).toBe('offline');
    expect(analysis.verdict_reason).toMatch(/IPMI/);
    // One host judged offline does not take the whole platform red.
    expect(lastTimeline('dell').state).toBe('degraded');

    const audit = db.prepare("SELECT * FROM ai_audit_exchanges WHERE feature = 'Service Status'").all();
    expect(audit.length).toBeGreaterThan(0);
  });

  it('7) AI verdict offline WITHOUT a reason while evidence says degraded: final verdict stays degraded, ai_verdict stored as offline', async () => {
    const id = await seedPendingEvent({ sourceKey: 'e7', host: 'unknown-host-7' });
    setSetting('service_status_ai_enabled', '1');
    process.env.OPENAI_API_KEY = 'test-token';
    svc._setChat(async () => JSON.stringify({
      verdict: 'offline', verdict_reason: '', why: 'w', actions: [], current_state: 'c', confidence: 'medium',
    }));

    await svc.runPending();

    const analysis = db.prepare('SELECT * FROM service_alert_analyses WHERE event_id = ?').get(id);
    expect(analysis.evidence_verdict).toBe('degraded'); // no inventory record for this host
    expect(analysis.ai_verdict).toBe('offline');
    expect(analysis.verdict).toBe('degraded');
  });

  it('8) a throwing chat call: status failed, evidence-only row, verdict = evidence verdict', async () => {
    const id = await seedPendingEvent({ sourceKey: 'e8', host: 'unknown-host-8' });
    setSetting('service_status_ai_enabled', '1');
    process.env.OPENAI_API_KEY = 'test-token';
    svc._setChat(async () => { throw Object.assign(new Error('boom'), { code: 'LLM_REQUEST_FAILED' }); });

    await svc.runPending();

    const row = db.prepare('SELECT * FROM service_alert_events WHERE id = ?').get(id);
    expect(row.analysis_status).toBe('failed');
    const analysis = db.prepare('SELECT * FROM service_alert_analyses WHERE event_id = ?').get(id);
    expect(analysis.ai_verdict).toBeNull();
    expect(analysis.verdict).toBe(analysis.evidence_verdict);
    expect(analysis.error).toMatch(/boom/);
  });

  it('9) dedupe: two events, same host + message within the window -> second reuses the first, chat called once', async () => {
    svc._setCollector(() => ({
      items: [
        makeItem('dell', { sourceKey: 'dup-1', host: 'r740-09', message: 'psu failure' }),
        makeItem('dell', { sourceKey: 'dup-2', host: 'r740-09', message: 'psu failure' }),
      ],
      failed: [],
    }));
    await svc.sweep();
    const rows = db.prepare("SELECT * FROM service_alert_events WHERE platform = 'dell' AND host = 'r740-09' ORDER BY id ASC").all();
    expect(rows).toHaveLength(2);
    for (const r of rows) db.prepare("UPDATE service_alert_events SET analysis_status = 'pending' WHERE id = ?").run(r.id);

    setSetting('service_status_ai_enabled', '1');
    process.env.OPENAI_API_KEY = 'test-token';
    let chatCalls = 0;
    svc._setChat(async () => {
      chatCalls += 1;
      return JSON.stringify({ verdict: 'degraded', verdict_reason: '', why: 'w', actions: [], current_state: 'c', confidence: 'medium' });
    });

    await svc.runPending();

    expect(chatCalls).toBe(1);
    const first = db.prepare('SELECT * FROM service_alert_analyses WHERE event_id = ?').get(rows[0].id);
    const second = db.prepare('SELECT * FROM service_alert_analyses WHERE event_id = ?').get(rows[1].id);
    expect(first.reused_from).toBeNull();
    expect(second.reused_from).toBe(rows[0].id);
    const secondEvent = db.prepare('SELECT * FROM service_alert_events WHERE id = ?').get(rows[1].id);
    expect(secondEvent.analysis_status).toBe('done');
  });

  it('10) cap: analyses_per_minute=1 with three pending -> exactly one done after one runPending call', async () => {
    svc._setCollector(() => ({
      items: [
        makeItem('dell', { sourceKey: 'cap-1', host: 'h1', message: 'm1' }),
        makeItem('dell', { sourceKey: 'cap-2', host: 'h2', message: 'm2' }),
        makeItem('dell', { sourceKey: 'cap-3', host: 'h3', message: 'm3' }),
      ],
      failed: [],
    }));
    await svc.sweep();
    const rows = db.prepare("SELECT * FROM service_alert_events WHERE platform = 'dell' ORDER BY id ASC").all();
    expect(rows).toHaveLength(3);
    for (const r of rows) db.prepare("UPDATE service_alert_events SET analysis_status = 'pending' WHERE id = ?").run(r.id);

    setSetting('service_status_ai_enabled', '1');
    setSetting('service_status_analyses_per_minute', '1');
    process.env.OPENAI_API_KEY = 'test-token';
    svc._setChat(async () => JSON.stringify({ verdict: 'degraded', verdict_reason: '', why: 'w', actions: [], current_state: 'c', confidence: 'medium' }));

    await svc.runPending();

    const after = db.prepare("SELECT id, analysis_status FROM service_alert_events WHERE platform = 'dell' ORDER BY id ASC").all();
    const doneCount = after.filter((r) => r.analysis_status === 'done').length;
    const pendingCount = after.filter((r) => r.analysis_status === 'pending').length;
    expect(doneCount).toBe(1);
    expect(pendingCount).toBe(2);
  });
});

describe('routes', () => {
  it('13) GET /board carries the last known state forward per day and reports unknown before the first row', async () => {
    const today = new Date();
    const dateStr = (daysAgo) => new Date(today.getTime() - daysAgo * 86400000).toISOString().slice(0, 10);

    // 5 days ago -> degraded, 2 days ago -> ok. Days before day -5 are unknown.
    db.prepare("INSERT INTO service_status_timeline (platform, state, at, reason, event_ids_json) VALUES ('dell','degraded', ?, 'seed', '[]')")
      .run(`${dateStr(5)}T10:00:00.000Z`);
    db.prepare("INSERT INTO service_status_timeline (platform, state, at, reason, event_ids_json) VALUES ('dell','ok', ?, 'seed', '[]')")
      .run(`${dateStr(2)}T10:00:00.000Z`);

    const res = await request(app).get('/api/service-status/board?days=7');
    expect(res.status).toBe(200);
    const dell = res.body.platforms.find((p) => p.id === 'dell');
    expect(dell).toBeTruthy();

    const byDate = Object.fromEntries(dell.days.map((d) => [d.date, d.state]));
    expect(byDate[dateStr(6)]).toBe('unknown');
    expect(byDate[dateStr(5)]).toBe('degraded');
    expect(byDate[dateStr(4)]).toBe('degraded'); // carried forward
    expect(byDate[dateStr(2)]).toBe('ok');
    expect(byDate[dateStr(0)]).toBe('ok'); // carried forward to today
    expect(dell.current.state).toBe('ok');
  });

  it('GET /events?platform&date lists the seeded event; GET /events/:id returns its analysis', async () => {
    svc._setCollector(() => ({ items: [makeItem('dell', { sourceKey: 'route-1', host: 'r740-11' })], failed: [] }));
    await svc.sweep();
    const row = db.prepare("SELECT * FROM service_alert_events WHERE source_key = 'route-1'").get();
    const today = new Date().toISOString().slice(0, 10);

    const listRes = await request(app).get(`/api/service-status/events?platform=dell&date=${today}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.events.some((e) => e.sourceKey === 'route-1')).toBe(true);

    const getRes = await request(app).get(`/api/service-status/events/${row.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(row.id);
    expect(getRes.body.analysis).toBeTruthy(); // sweep's own runPending ran with AI off -> a 'disabled' analysis row exists
  });

  it('GET /events 400s on missing/invalid params', async () => {
    const missing = await request(app).get('/api/service-status/events');
    expect(missing.status).toBe(400);
    const badDate = await request(app).get('/api/service-status/events?platform=dell&date=not-a-date');
    expect(badDate.status).toBe(400);
  });

  it('GET /events/:id 404s when missing', async () => {
    const res = await request(app).get('/api/service-status/events/999999');
    expect(res.status).toBe(404);
  });

  it('POST /events/:id/analyze with no AI token configured -> 503 with the exact advisor-style message', async () => {
    svc._setCollector(() => ({ items: [makeItem('dell', { sourceKey: 'noai-1' })], failed: [] }));
    await svc.sweep();
    const row = db.prepare("SELECT * FROM service_alert_events WHERE source_key = 'noai-1'").get();

    const res = await request(app).post(`/api/service-status/events/${row.id}/analyze`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(
      'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.'
    );
  });

  it('POST /sweep runs a sweep and returns ok', async () => {
    svc._setCollector(() => ({ items: [], failed: [] }));
    const res = await request(app).post('/api/service-status/sweep');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// Cross-platform root cause: a Dell alert whose host is down in vCenter and
// whose Brocade fabric logins are missing. Mirrors demo/scenarios/sanBootPathDown.js.
describe('cross-platform evidence (SAN path down)', () => {
  const HOST = 'ut-esx-0102.icc.demo';
  let brocadeSourceId;

  function seedSanScenario() {
    db.exec("DELETE FROM brocade_device_ports; DELETE FROM brocade_switch_ports; DELETE FROM brocade_switches; DELETE FROM brocade_issue_history");
    db.exec("DELETE FROM brocade_sources WHERE name = 'SanNav UT'");
    brocadeSourceId = db.prepare(`
      INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl, enabled,
        polling_interval_minutes, event_poll_minutes, fos_proxy_enabled, sannav_version)
      VALUES ('SanNav UT', '10.0.0.9', 443, 'admin', 'x', 0, 1, 60, 5, 0, '2.3.0')
    `).run().lastInsertRowid;
    db.prepare(`INSERT INTO brocade_switches (source_id, wwn, name, fabric_name, operational_status, stale) VALUES (?, ?, ?, 'PROD-A', 'HEALTHY', 0)`)
      .run(brocadeSourceId, '10:00:00:00:00:00:aa:02', 'UT-SW02');
    db.prepare(`
      INSERT INTO brocade_switch_ports (source_id, switch_wwn, switch_name, port_number, state, status, status_message, occupied, stale)
      VALUES (?, '10:00:00:00:00:00:aa:02', 'UT-SW02', 18, 'Offline', 'No_Light', 'no sync on port group 16-19', 1, 0)
    `).run(brocadeSourceId);
    db.prepare(`
      INSERT INTO brocade_device_ports (source_id, wwn, port_role, fabric_name, switch_wwn, switch_name, port_number,
        enclosure_name, fdmi_host_name, is_missing, stale)
      VALUES (?, '10:00:00:10:9b:ut:00:18', 'Initiator', 'PROD-A', '10:00:00:00:00:00:aa:02', 'UT-SW02', 18, 'ut-esx-0102', ?, 1, 0)
    `).run(brocadeSourceId, HOST);
    db.exec("DELETE FROM vcenter_hosts WHERE name LIKE 'ut-esx-%'");
    const vc = db.prepare('SELECT id FROM vcenter_vcenters LIMIT 1').get();
    const vcId = vc ? vc.id : db.prepare(`INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('ut-vc', 'ut-vc.local', 'u', 'x')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state, power_state) VALUES (?, 'host-ut', ?, 'ut-cl', 'NOT_RESPONDING', 'POWERED_ON')`).run(vcId, HOST);
  }

  it('brocadeIssues rule host_link_down fires once per host and names the switch port state', () => {
    seedSanScenario();
    const { computeIssues } = require('../services/brocadeIssues');
    const hits = computeIssues().filter((i) => i.type === 'host_link_down');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: 'critical', target: HOST, source: 'SanNav UT' });
    expect(hits[0].message).toContain('UT-SW02 port 18 (No_Light)');
    expect(hits[0].message).toContain('no sync on port group 16-19');
  });

  it('deriveVerdict: management-plane up on the alerting platform but another platform reports down -> offline, medium', () => {
    const evidence = {
      hostRecords: [
        { platform: 'dell', up: true, fields: {} },
        { platform: 'vcenter', up: false, fields: {} },
      ],
      platformPolls: [],
    };
    const v = svc.deriveVerdict({ source_key: 'k1', platform: 'dell' }, evidence);
    expect(v).toMatchObject({ verdict: 'offline', confidence: 'medium' });
    expect(v.reason).toMatch(/vCenter reports this host as down/);
  });

  it('a Dell alert gathers SAN paths and the open Brocade/vCenter events for the same host into its evidence', async () => {
    seedSanScenario();
    // dell_devices row: iDRAC reachable, server powered on (management plane says up).
    const ome = db.prepare(`INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('OME UT', 'ome-ut', 'u', 'x')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO dell_devices (ome_id, device_id, service_tag, name, device_type, health, power_state, connection_state) VALUES (?, 1, 'UTTAG01', ?, 'Server', 'critical', 'on', 1)`).run(ome, HOST);
    svc._setCollector(() => ({
      items: [
        makeItem('brocade', { sourceKey: `host_link_down|SanNav UT|${HOST}`, host: HOST, message: `Host ${HOST} lost its fabric login on UT-SW02 port 18 (No_Light); link down` }),
        makeItem('dell', { sourceKey: 'd1:990001', host: `${HOST} (UTTAG01)`, message: `System failed to boot: no bootable device on the FC boot path of ${HOST}` }),
      ],
      failed: [],
    }));
    await svc.sweep();
    const dellEvent = db.prepare("SELECT * FROM service_alert_events WHERE platform = 'dell'").get();
    const analysis = db.prepare('SELECT * FROM service_alert_analyses WHERE event_id = ?').get(dellEvent.id);
    expect(analysis.evidence_verdict).toBe('offline');
    const evidence = JSON.parse(analysis.evidence_json);
    expect(evidence.sanPaths).toHaveLength(1);
    expect(evidence.sanPaths[0]).toMatchObject({ switch_name: 'UT-SW02', port_number: 18, is_missing: true, switch_port_status: 'No_Light', linkState: 'lost fabric login' });
    expect(evidence.relatedOtherPlatformEvents.map((e) => e.platform)).toEqual(['brocade']);
    expect(evidence.hostRecords.some((r) => r.platform === 'vcenter' && r.up === false)).toBe(true);
    // The host is judged offline, but Dell's own OME source still answers, so the platform is degraded.
    expect(lastTimeline('dell').state).toBe('degraded');
  });
});
