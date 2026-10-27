// Deep pass: a critical or low-confidence first answer from the model gets one
// more, deeper triage that starts from that answer, replaces it, and spends a
// budget unit of its own. The model is a local fake bridge that records every
// request; capabilities and platform evidence are stubbed so the suite does not
// depend on either.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import path from 'path';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting } = require('../services/settings');
const alertNotifier = require('../services/alertNotifier');
const caps = require('../services/agentCapabilities');
const agent = require('../services/opsAgent');

const evidencePath = path.resolve(__dirname, '../services/agentEvidence/index.js');
let savedEntry;
let server;
let requests;
let confidences;           // queue: confidence of each model answer, then 'high'
const realCollect = alertNotifier.collectOpenAlerts;
let current;               // the open alerts the stubbed collector reports

const answer = (confidence, tag) => JSON.stringify({
  classification: 'incident', confidence, title: `Host esx-01 ${tag}`, summary: `summary ${tag}`, impact: 'impact',
  correlation: 'correlation', likely_cause: `cause ${tag}`, reviewed: ['looked'], next_steps: [{ owner: 'ops', action: 'check' }],
  escalate: 'no', human_required: false, human_reason: '',
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/chat\/completions$/.test(req.url)) { res.writeHead(404); return res.end(); }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push(body);
      const deep = body.includes('second, deeper pass');
      const c = confidences.length ? confidences.shift() : 'high';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'test-model', choices: [{ message: { content: answer(c, deep ? 'deep' : 'first') } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  setSetting('llm_custom_endpoint', `http://127.0.0.1:${server.address().port}/v1`);
});
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  db.exec('DELETE FROM ops_incident_analyses; DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_agent_runs;');
  requests = [];
  confidences = [];
  current = [];
  caps._setBuiltins([]);
  setSetting('ops_agent_enabled', '1');
  setSetting('ops_agent_hold_minutes', '0');
  setSetting('ops_agent_deep_pass', '');
  setSetting('ops_agent_analyses_per_hour', '');
  setSetting('ops_agent_email_enabled', '0');
  alertNotifier.collectOpenAlerts = () => ({ items: current, failed: [] });
  savedEntry = require.cache[evidencePath];
  require.cache[evidencePath] = { id: evidencePath, filename: evidencePath, loaded: true, exports: { gather: () => ({ blocks: [], chars: 0 }), PROVIDERS: [], PLATFORM_EVIDENCE_CHAR_CAP: 6000 } };
});

afterEach(() => {
  alertNotifier.collectOpenAlerts = realCollect;
  if (savedEntry) require.cache[evidencePath] = savedEntry; else delete require.cache[evidencePath];
});

const alert = (severity) => ({ platform: 'vcenter', sourceKey: 'v:cpu-esx-01', severity, host: 'esx-01', message: 'Host esx-01 CPU is high', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() });
const analyses = (id) => db.prepare('SELECT * FROM ops_incident_analyses WHERE incident_id = ? ORDER BY id').all(id);
const only = () => db.prepare('SELECT * FROM ops_incidents').get();

describe('deep pass', () => {
  it('gives a critical incident a second pass that starts from the first answer', async () => {
    current = [alert('critical')];
    confidences = ['high', 'high'];
    await agent.runOnce({ force: true });
    const inc = only();
    const rows = analyses(inc.id);
    expect(rows.map((r) => r.trigger)).toEqual(['tick', 'deep-pass']);
    expect(inc.deep_pass_at).toBeTruthy();
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toContain('priorAnalysis');
    expect(requests[1]).toContain('priorAnalysis');
    expect(requests[1]).toContain('second, deeper pass');
    expect(requests[1]).toContain('cause first');
    // The deep answer replaced the first one on the incident.
    expect(inc.summary).toBe('summary deep');
  });

  it('gives a low-confidence warning one second pass', async () => {
    current = [alert('warning')];
    confidences = ['low', 'medium'];
    await agent.runOnce({ force: true });
    const inc = only();
    expect(inc.severity).toBe('warning');
    expect(analyses(inc.id).map((r) => r.trigger)).toEqual(['tick', 'deep-pass']);
    expect(inc.confidence).toBe('medium');
  });

  it('does not deep-pass a medium-confidence warning', async () => {
    current = [alert('warning')];
    confidences = ['medium'];
    await agent.runOnce({ force: true });
    const inc = only();
    expect(analyses(inc.id)).toHaveLength(1);
    expect(inc.deep_pass_at).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('never deep-passes the same incident twice', async () => {
    current = [alert('critical')];
    await agent.runOnce({ force: true });
    const inc = only();
    db.prepare("UPDATE ops_incidents SET state = 'collecting', hold_until = ? WHERE id = ?").run('2020-01-01T00:00:00.000Z', inc.id);
    const before = requests.length;
    await agent.runOnce({ force: true });
    expect(requests.length - before).toBe(1);
    expect(analyses(inc.id).filter((r) => r.trigger === 'deep-pass')).toHaveLength(1);
  });

  it('stops when the hourly budget is spent', async () => {
    setSetting('ops_agent_analyses_per_hour', '1');
    current = [alert('critical')];
    await agent.runOnce({ force: true });
    const inc = only();
    expect(analyses(inc.id)).toHaveLength(1);
    expect(inc.deep_pass_at).toBeNull();
  });

  it('is off when the setting is off', async () => {
    setSetting('ops_agent_deep_pass', '0');
    current = [alert('critical')];
    await agent.runOnce({ force: true });
    expect(analyses(only().id)).toHaveLength(1);
  });

  it('a hand re-triage never runs it', async () => {
    current = [alert('critical')];
    setSetting('ops_agent_deep_pass', '0');
    await agent.runOnce({ force: true });
    setSetting('ops_agent_deep_pass', '');
    const inc = only();
    requests.length = 0;
    await agent.retriage(inc.id);
    expect(requests).toHaveLength(1);
    expect(analyses(inc.id).map((r) => r.trigger)).toEqual(['tick', 'retriage']);
    expect(only().deep_pass_at).toBeNull();
  });
});
