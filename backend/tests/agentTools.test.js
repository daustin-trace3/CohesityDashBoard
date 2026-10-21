import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const http = require('http');
const db = require('../db/database');
const { setSetting, getOpsAgentSettings } = require('../services/settings');
const caps = require('../services/agentCapabilities');
const tools = require('../services/agentCapabilities/tools');
const agent = require('../services/opsAgent');
const { createAnonymizer } = require('../services/anonymizer');
const profiles = require('../services/agentProfiles');

const NOW = '2026-10-21T20:00:00.000Z';

function insertIncident(key, host, platforms = ['dell']) {
  const r = db.prepare(`INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at)
    VALUES (?, ?, ?, ?, 'critical', 'collecting', ?, ?, ?)`).run(key, 'test', host, JSON.stringify(platforms), NOW, NOW, NOW);
  return db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(r.lastInsertRowid);
}
function attach(inc, platform, sourceKey, host) {
  db.prepare(`INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, attached_at, first_seen) VALUES (?, ?, ?, 'critical', ?, 'm', ?, ?)`)
    .run(inc.id, platform, sourceKey, host, NOW, NOW);
}
const alertsOf = (id) => db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ?').all(id);

function loopbackIncident() {
  const ome = db.prepare("INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('OME-L', '127.0.0.1', 'u', 'x')").run().lastInsertRowid;
  const inc = insertIncident('platform:dell:wide', null);
  attach(inc, 'dell', `poll:${ome}`, 'OME-L');
  return inc;
}

let runs;
const fakeCaps = () => [
  { id: 'ping', label: 'Ping', description: 'Pings.', risk: 'network-probe', defaultEnabled: true, run: (t) => { runs.push(['ping', t.name]); return { ok: true, summary: 'replied', data: { addr: t.address } }; } },
  { id: 'tcp_port', label: 'TCP', description: 'Ports.', risk: 'network-probe', defaultEnabled: true, appliesTo: (t) => (t.portEntries || []).length > 0, run: (t) => { runs.push(['tcp_port', t.name, t.ports]); return { ok: true, summary: `ports ${t.ports.join(',')}`, data: { ports: t.ports } }; } },
];

// A scripted OpenAI-compatible server: one reply per request, bodies recorded.
let server; let bodies; let script;
async function startServer() {
  bodies = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      bodies.push(body);
      const step = script.shift() || { content: '{}' };
      if (step.status) {
        res.writeHead(step.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.error || 'bad' } }));
        return;
      }
      const message = { role: 'assistant', content: step.content ?? null };
      if (step.tool_calls) message.tool_calls = step.tool_calls;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  setSetting('llm_provider', 'custom');
  setSetting('llm_custom_endpoint', `http://127.0.0.1:${server.address().port}/v1`);
  setSetting('llm_model', 'test-model');
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const ANSWER = JSON.stringify({ classification: 'one-off', confidence: 'high', title: 'T', summary: ['Line one.'], impact: 'i', correlation: 'independent', likely_cause: 'c', reviewed: ['r'], next_steps: [{ owner: 'L2', action: 'a' }], escalate: 'e', human_required: false, human_reason: 'h' });

beforeEach(async () => {
  runs = [];
  db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_capability_runs; DELETE FROM dell_devices; DELETE FROM dell_ome_instances;');
  setSetting(caps.SETTING_KEY, '');
  setSetting('ops_agent_capability_mode', '');
  setSetting('ops_agent_max_tool_calls', '');
  delete process.env.DASHBOARD_DEMO;
  caps._setBuiltins(fakeCaps());
  script = [];
  await startServer();
});
afterEach(async () => {
  caps._setBuiltins(null);
  setSetting('llm_provider', '');
  setSetting('llm_custom_endpoint', '');
  setSetting('llm_model', '');
  await new Promise((r) => server.close(r));
});
afterAll(() => { caps._setBuiltins(null); });

describe('migration v29 and settings', () => {
  it('ops_capability_runs has requested_by and reason', () => {
    const cols = db.prepare('PRAGMA table_info(ops_capability_runs)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['requested_by', 'reason']));
  });

  it('capabilityMode and maxToolCalls default, round trip and reject out-of-range', () => {
    expect(getOpsAgentSettings()).toMatchObject({ capabilityMode: 'playbook', maxToolCalls: 6 });
    setSetting('ops_agent_capability_mode', 'tools');
    setSetting('ops_agent_max_tool_calls', '9');
    expect(getOpsAgentSettings()).toMatchObject({ capabilityMode: 'tools', maxToolCalls: 9 });
    setSetting('ops_agent_max_tool_calls', '40');
    expect(getOpsAgentSettings().maxToolCalls).toBe(6);
    setSetting('ops_agent_capability_mode', 'bogus');
    expect(getOpsAgentSettings().capabilityMode).toBe('playbook');
  });
});

describe('buildToolset', () => {
  it('names tools from the catalog, restricts target and ports to the incident menu', () => {
    const inc = loopbackIncident();
    const anon = createAnonymizer();
    const ts = tools.buildToolset(inc, alertsOf(inc.id), anon);
    expect(ts.tools.map((t) => t.function.name)).toEqual(['ping', 'tcp_port']);
    const tcp = ts.tools.find((t) => t.function.name === 'tcp_port').function.parameters;
    expect(tcp.required).toEqual(['target', 'reason']);
    expect(tcp.properties.target.enum).toHaveLength(1);
    expect(tcp.properties.ports.items.enum).toEqual([443]);
    const ping = ts.tools.find((t) => t.function.name === 'ping').function.parameters;
    expect(ping.properties.ports).toBeUndefined();
    // The enum holds the anonymized form, not the stored address.
    const [token] = tcp.properties.target.enum;
    expect(ts.targets.get(token).address).toBe('127.0.0.1');
    expect(ts.tools[0].function.description).toMatch(/Risk class: network-probe/);
  });

  it('names a pack capability with __ in place of the colon', () => {
    caps._setBuiltins([...fakeCaps(), { id: 'pk:lag', label: 'Lag', risk: 'platform-api', defaultEnabled: true, platform: 'dell', run: () => ({ ok: true, summary: 'x' }) }]);
    const inc = loopbackIncident();
    const ts = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    expect(ts.tools.map((t) => t.function.name)).toContain('pk__lag');
    expect(ts.caps.get('pk__lag').id).toBe('pk:lag');
  });

  it('leaves out a tool nothing applies to', () => {
    caps.saveEnabled({ ping: false });
    const inc = loopbackIncident();
    const ts = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    expect(ts.tools.map((t) => t.function.name)).toEqual(['tcp_port']);
  });
});

describe('runToolCall', () => {
  const ctxOf = (inc) => ({ alerts: alertsOf(inc.id), evidence: null, logger: null });

  it('runs an allowed call, tags the audit row with requested_by model and the reason', async () => {
    const inc = loopbackIncident();
    const ts = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    const [token] = ts.tools[0].function.parameters.properties.target.enum;
    const r = await tools.runToolCall(call('c1', 'ping', { target: token, reason: 'confirm the path' }), ts, inc, ctxOf(inc));
    expect(r).toMatchObject({ ok: true, summary: 'replied', reason: 'confirm the path' });
    const rows = caps.listRuns({ incidentId: inc.id });
    expect(rows[0]).toMatchObject({ capability: 'ping', requestedBy: 'model', reason: 'confirm the path' });
  });

  it('refuses an unknown target and does not run anything', async () => {
    const inc = loopbackIncident();
    const ts = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    const r = await tools.runToolCall(call('c1', 'ping', { target: 'HOST-99', reason: 'x' }), ts, inc, ctxOf(inc));
    expect(r).toMatchObject({ ok: false, refused: true, summary: 'refused: target not in this incident' });
    expect(runs).toHaveLength(0);
    expect(caps.listRuns({})).toHaveLength(0);
  });

  it('refuses a port outside the target list, accepts one inside, refuses a repeat', async () => {
    const inc = loopbackIncident();
    const ts = tools.buildToolset(inc, alertsOf(inc.id), createAnonymizer());
    const [token] = ts.tools[0].function.parameters.properties.target.enum;
    const bad = await tools.runToolCall(call('c1', 'tcp_port', { target: token, ports: [22], reason: 'x' }), ts, inc, ctxOf(inc));
    expect(bad.refused).toBe(true);
    expect(bad.summary).toMatch(/port not in/);
    const good = await tools.runToolCall(call('c2', 'tcp_port', { target: token, ports: [443], reason: 'x' }), ts, inc, ctxOf(inc));
    expect(good.ok).toBe(true);
    expect(runs).toEqual([['tcp_port', 'OME-L', [443]]]);
    const again = await tools.runToolCall(call('c3', 'tcp_port', { target: token, ports: [443], reason: 'x' }), ts, inc, ctxOf(inc));
    expect(again.refused).toBe(true);
    const junk = await tools.runToolCall({ id: 'c4', function: { name: 'ping', arguments: '{not json' } }, ts, inc, ctxOf(inc));
    expect(junk.refused).toBe(true);
    const nope = await tools.runToolCall(call('c5', 'rm_rf', { target: token }), ts, inc, ctxOf(inc));
    expect(nope.refused).toBe(true);
  });
});

describe('prompt', () => {
  it('adds the tools sentence only when asked', () => {
    const on = profiles.buildSystemPrompt({ platforms: [], tools: true }).system;
    const off = profiles.buildSystemPrompt({ platforms: [] }).system;
    expect(on).toMatch(/You may call the listed checks/);
    expect(off).not.toMatch(/You may call the listed checks/);
    expect(on.indexOf('You may call')).toBeLessThan(on.indexOf('network, when present'));
  });
});

describe('triage loop (tools mode)', () => {
  beforeEach(() => { setSetting('ops_agent_capability_mode', 'tools'); });

  const tokenIn = (body) => body.tools.find((t) => t.function.name === 'ping').function.parameters.properties.target.enum[0];

  it('runs a requested check, feeds the tool message back and stores liveChecks with requestedBy model', async () => {
    const inc = loopbackIncident();
    // Reply 1 is built after the first request is seen, so use a getter script.
    script.push({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', get arguments() { return JSON.stringify({ target: tokenIn(bodies[0]), reason: 'is the source up' }); } } }] });
    script.push({ content: ANSWER });
    await agent.triageIncident(inc, { force: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools.length).toBe(2);
    expect(bodies[0].response_format).toBeUndefined();
    const second = bodies[1].messages;
    expect(second[second.length - 2].tool_calls[0].id).toBe('call_1');
    expect(second[second.length - 1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(JSON.parse(second[second.length - 1].content)).toMatchObject({ ok: true, summary: 'replied' });
    const row = db.prepare('SELECT evidence_json, analysis_json FROM ops_incidents WHERE id = ?').get(inc.id);
    const ev = JSON.parse(row.evidence_json);
    expect(ev.liveChecks.ran).toBe(true);
    expect(ev.liveChecks.results[0]).toMatchObject({ capability: 'ping', requestedBy: 'model', reason: 'is the source up' });
    expect(JSON.parse(row.analysis_json).source).toBe('ai');
    expect(runs).toEqual([['ping', 'OME-L']]);
  });

  it('records no checks when the model answers without calling any', async () => {
    const inc = loopbackIncident();
    script.push({ content: ANSWER });
    await agent.triageIncident(inc, { force: true });
    const ev = JSON.parse(db.prepare('SELECT evidence_json FROM ops_incidents WHERE id = ?').get(inc.id).evidence_json);
    expect(ev.liveChecks).toMatchObject({ ran: false, skipped: 'agent decided no live check was needed', results: [] });
    expect(runs).toHaveLength(0);
  });

  it('stops at maxToolCalls, then asks for the answer with tool_choice none and json_object', async () => {
    setSetting('ops_agent_max_tool_calls', '1');
    const inc = loopbackIncident();
    const two = () => [
      { id: 'a', type: 'function', function: { name: 'ping', get arguments() { return JSON.stringify({ target: tokenIn(bodies[0]), reason: 'r' }); } } },
      { id: 'b', type: 'function', function: { name: 'tcp_port', get arguments() { return JSON.stringify({ target: tokenIn(bodies[0]), reason: 'r' }); } } },
    ];
    script.push({ tool_calls: two() });
    script.push({ content: ANSWER });
    await agent.triageIncident(inc, { force: true });
    expect(runs).toEqual([['ping', 'OME-L']]);
    const last = bodies[bodies.length - 1];
    expect(last.tool_choice).toBe('none');
    expect(last.response_format).toEqual({ type: 'json_object' });
    const msgs = last.messages;
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(JSON.parse(toolMsgs[1].content).summary).toMatch(/budget/);
  });

  it('falls back to the playbook when the provider rejects tool calling with a 400', async () => {
    const inc = loopbackIncident();
    script.push({ status: 400, error: 'tools are not supported by this model' });
    script.push({ content: ANSWER });
    await agent.triageIncident(inc, { force: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].tools).toBeUndefined();
    const ev = JSON.parse(db.prepare('SELECT evidence_json FROM ops_incidents WHERE id = ?').get(inc.id).evidence_json);
    expect(ev.liveChecks.ran).toBe(true);
    expect(ev.liveChecks.results.every((r) => r.requestedBy === 'playbook')).toBe(true);
    expect(runs.map((r) => r[0]).sort()).toEqual(['ping', 'tcp_port']);
  });

  it('never sends tools or runs checks in demo mode', async () => {
    process.env.DASHBOARD_DEMO = '1';
    const inc = loopbackIncident();
    script.push({ content: ANSWER });
    await agent.triageIncident(inc, { force: true });
    expect(bodies[0].tools).toBeUndefined();
    expect(runs).toHaveLength(0);
    const ev = JSON.parse(db.prepare('SELECT evidence_json FROM ops_incidents WHERE id = ?').get(inc.id).evidence_json);
    expect(ev.liveChecks.ran).toBe(false);
  });

  it('playbook mode is unchanged: checks run first, no tools are sent', async () => {
    setSetting('ops_agent_capability_mode', 'playbook');
    const inc = loopbackIncident();
    script.push({ content: ANSWER });
    await agent.triageIncident(inc, { force: true });
    expect(bodies[0].tools).toBeUndefined();
    expect(runs.map((r) => r[0]).sort()).toEqual(['ping', 'tcp_port']);
  });
});

describe('email rendering', () => {
  it('prints the agent-asked heading and the reason', () => {
    const inc = { id: 1, title: 't', severity: 'critical', platforms: '["dell"]', opened_at: NOW };
    const lc = { ran: true, results: [{ capability: 'ping', label: 'Ping', ok: true, summary: 'replied', at: NOW, requestedBy: 'model', reason: 'confirm path', target: { name: 'OME-L', address: '127.0.0.1' } }] };
    const mail = agent.renderEmail(inc, [], { summary: 's', classification: 'one-off' }, { liveChecks: lc });
    expect(mail.text).toMatch(/CHECKED LIVE \(from the ICC server\) \(ASKED FOR BY THE AGENT\)/);
    expect(mail.text).toMatch(/\(asked for by the agent: confirm path\)/);
    expect(mail.html).toMatch(/asked for by the agent: confirm path/);
  });
});
