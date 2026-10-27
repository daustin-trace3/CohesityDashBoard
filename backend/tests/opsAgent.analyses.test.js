// Analysis history: every triage pass is kept in ops_incident_analyses beside
// the latest answer on ops_incidents. No AI provider is configured here, so
// triage writes the rule-based digest; the platform evidence provider is
// stubbed through the require cache so this suite does not depend on it.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import request from 'supertest';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting, getOpsAgentSettings } = require('../services/settings');
const agent = require('../services/opsAgent');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
const NOW = '2026-10-27T20:00:00.000Z';
const settings = { ...getOpsAgentSettings(), minSeverity: 'warning', holdMinutes: 10 };
const item = (o = {}) => ({ platform: 'vcenter', sourceKey: 'v:down-esx-01', severity: 'critical', host: 'esx-01', message: 'Host esx-01 is not responding', firstSeen: NOW, lastSeen: NOW, ...o });

const evidencePath = path.resolve(__dirname, '../services/agentEvidence/index.js');
let savedEntry;
const stubEvidence = (gather) => {
  require.cache[evidencePath] = { id: evidencePath, filename: evidencePath, loaded: true, exports: { gather, PROVIDERS: [], PLATFORM_EVIDENCE_CHAR_CAP: 6000 } };
};

const row = (id) => db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);
const analyses = (id) => db.prepare('SELECT * FROM ops_incident_analyses WHERE incident_id = ? ORDER BY id').all(id);

function openIncident(o = {}) {
  agent.groupTick(NOW, settings, { items: [item(o)], failed: [] });
  return db.prepare('SELECT * FROM ops_incidents ORDER BY id DESC LIMIT 1').get();
}

beforeEach(() => {
  db.exec('DELETE FROM ops_incident_analyses; DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_agent_runs;');
  setSetting('ops_agent_enabled', '1');
  setSetting('llm_custom_endpoint', '');
  setSetting('ops_agent_analysis_history_days', '');
  savedEntry = require.cache[evidencePath];
  stubEvidence(() => ({ blocks: [], chars: 0 }));
});

afterEach(() => {
  if (savedEntry) require.cache[evidencePath] = savedEntry; else delete require.cache[evidencePath];
});

describe('analysis history', () => {
  it('each triage appends an analyses row with pass numbering', async () => {
    const inc = openIncident();
    await agent.triageIncident(inc);
    const first = analyses(inc.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ pass: 1, trigger: 'tick' });
    expect(JSON.parse(first[0].analysis_json).classification).toBe(row(inc.id).classification);
    expect(JSON.parse(first[0].evidence_json).incident.id).toBe(inc.id);
    // A second pass after new alerts landed on an already triaged incident is 'growth'.
    await agent.triageIncident(row(inc.id));
    const second = analyses(inc.id);
    expect(second.map((r) => r.pass)).toEqual([1, 2]);
    expect(second[1].trigger).toBe('growth');
    expect(agent.getIncident(inc.id).analysesCount).toBe(2);
  });

  it('a retriage keeps the earlier row and adds trigger retriage', async () => {
    const inc = openIncident();
    await agent.triageIncident(inc);
    const firstId = analyses(inc.id)[0].id;
    await agent.retriage(inc.id);
    const rows = analyses(inc.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(firstId);
    expect(rows[1]).toMatchObject({ trigger: 'retriage', pass: 2 });
    // ops_incidents still carries the latest answer.
    expect(row(inc.id).analysis_json).toBe(rows[1].analysis_json);
  });

  it('the route returns newest first and full=1 carries evidence', async () => {
    const inc = openIncident();
    await agent.triageIncident(inc);
    await agent.retriage(inc.id);
    const app = createApp({ licenseGate: (req, res, next) => next() });
    const slim = await request(app).get(`/api/ops-agent/incidents/${inc.id}/analyses`).set('x-api-key', API_KEY);
    expect(slim.status).toBe(200);
    expect(slim.body.map((r) => r.pass)).toEqual([2, 1]);
    expect(slim.body[0]).toMatchObject({ trigger: 'retriage', classification: expect.any(String) });
    expect(slim.body[0].analysis).toBeTruthy();
    expect(slim.body[0].evidence).toBeUndefined();
    const full = await request(app).get(`/api/ops-agent/incidents/${inc.id}/analyses?full=1`).set('x-api-key', API_KEY);
    expect(full.body[0].evidence.incident.id).toBe(inc.id);
    const missing = await request(app).get('/api/ops-agent/incidents/999999/analyses').set('x-api-key', API_KEY);
    expect(missing.status).toBe(404);
  });

  it('prune honours the setting', () => {
    const inc = openIncident();
    const ins = db.prepare('INSERT INTO ops_incident_analyses (incident_id, at, trigger, pass) VALUES (?, ?, ?, ?)');
    const day = 86400000;
    ins.run(inc.id, new Date(Date.now() - 200 * day).toISOString(), 'tick', 1);
    ins.run(inc.id, new Date(Date.now() - 100 * day).toISOString(), 'tick', 2);
    agent.pruneAnalyses();
    expect(analyses(inc.id).map((r) => r.pass)).toEqual([2]);
    setSetting('ops_agent_analysis_history_days', '30');
    expect(getOpsAgentSettings().analysisHistoryDays).toBe(30);
    agent.pruneAnalyses();
    expect(analyses(inc.id)).toHaveLength(0);
  });

  it('PUT /api/settings clamps analysisHistoryDays like the other agent numbers', async () => {
    const app = createApp({ licenseGate: (req, res, next) => next() });
    const put = (body) => request(app).put('/api/settings').set('x-api-key', API_KEY).send(body);
    await put({ opsAgent: { analysisHistoryDays: 90 } });
    expect(getOpsAgentSettings().analysisHistoryDays).toBe(90);
    await put({ opsAgent: { analysisHistoryDays: 5000 } });
    expect(getOpsAgentSettings().analysisHistoryDays).toBe(180);
  });
});
