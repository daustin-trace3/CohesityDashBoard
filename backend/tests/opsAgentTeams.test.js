// Operations Agent Teams channel: card shape, settings round trip, the notify
// loop and the test route. postCard is always stubbed; nothing here may reach
// the network.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting } = require('../services/settings');
const { encrypt } = require('../services/encryption');
const teams = require('../services/opsAgentTeams');
const agent = require('../services/opsAgent');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
const HOOK = 'https://prod-00.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=secret';
const NOW = '2026-10-14T18:00:00.000Z';

const ANALYSIS = {
  source: 'ai', classification: 'incident', confidence: 'high', title: 'esx-01 lost a SAN path',
  summary: 'Port 3/14 went down on sw-core-1.\nDatastore DS1 went inaccessible on esx-01.',
  human_required: true, human_reason: 'Someone has to reseat the cable.',
  next_steps: [
    { owner: 'L2 SAN', action: 'Check the SFP.' }, { owner: 'L2 SAN', action: 'Reseat the cable.' },
    { owner: 'L2 virt', action: 'Confirm the datastore.' }, { owner: 'L3', action: 'Call the vendor.' },
  ],
};
const INC = { id: 42, title: 'esx-01', host: 'esx-01', platforms: JSON.stringify(['vcenter', 'brocade']), severity: 'critical' };

function insertIncident(o = {}) {
  return db.prepare(`
    INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count, baseline, analysis_json, triaged_at, summary, classification, confidence)
    VALUES (?, 'esx-01', 'esx-01', ?, 'critical', ?, ?, ?, ?, 1, ?, ?, ?, ?, 'incident', 'high')
  `).run(o.key || 'host:esx-01', JSON.stringify(['vcenter']), o.state || 'triaged', NOW, NOW, NOW, o.baseline ? 1 : 0, JSON.stringify(ANALYSIS), NOW, ANALYSIS.summary).lastInsertRowid;
}
const row = (id) => db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);

function teamsOn() {
  setSetting('ops_agent_teams_enabled', '1');
  setSetting('ops_agent_teams_webhook', encrypt(HOOK));
}

beforeEach(() => {
  db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_agent_runs;');
  setSetting('ops_agent_enabled', '1');
  setSetting('ops_agent_teams_enabled', '0');
  setSetting('ops_agent_teams_webhook', '');
  setSetting('ops_agent_teams_on_resolve', '');
  setSetting('icc_base_url', '');
  setSetting('smtp_enabled', '0');
  setSetting('ops_agent_renotify_minutes', '');
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.DASHBOARD_DEMO; });

describe('card', () => {
  it('builds a critical incident card with a deep link when the base URL is set', () => {
    const card = teams.buildCard(INC, ANALYSIS, { agentName: 'Otis', baseUrl: 'https://icc.example.com/', tenantId: 'default' });
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.4');
    expect(card.body[0]).toMatchObject({ type: 'TextBlock', text: 'CRITICAL | esx-01 lost a SAN path', color: 'Attention', weight: 'Bolder' });
    expect(card.body[1].text).toBe('Otis, incident #42');
    const texts = card.body.filter((b) => b.type === 'TextBlock').map((b) => b.text);
    expect(texts).toContain('Human required: Someone has to reseat the cable.');
    expect(texts).toContain('- Port 3/14 went down on sw-core-1.');
    expect(texts).toContain('3. [L2 virt] Confirm the datastore.');
    expect(texts.some((t) => /Call the vendor/.test(t))).toBe(false);   // first 3 steps only
    const facts = card.body.find((b) => b.type === 'FactSet').facts;
    expect(facts).toEqual([
      { title: 'Host', value: 'esx-01' },
      { title: 'Platforms', value: expect.any(String) },
      { title: 'Classification', value: 'incident (high confidence)' },
    ]);
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open in ICC', url: 'https://icc.example.com/t/default/ops/agent?incident=42' }]);
    const env = teams.envelope(card);
    expect(env).toEqual({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] });
  });

  it('omits the action and says so in the footer without a base URL', () => {
    const card = teams.buildCard({ ...INC, severity: 'warning' }, { ...ANALYSIS, human_required: false }, { agentName: 'Otis' });
    expect(card.actions).toBeUndefined();
    expect(card.body[0].color).toBe('Warning');
    expect(card.body[card.body.length - 1].text).toMatch(/No ICC address is set, so there is no link/);
    expect(card.body.some((b) => /Human required/.test(b.text || ''))).toBe(false);
    expect(teams.severityColor('info')).toBe('Default');
    expect(teams.severityColor('error')).toBe('Attention');
  });

  it('is ASCII only', () => {
    const json = JSON.stringify(teams.buildCard(INC, ANALYSIS, { agentName: 'Otis', baseUrl: 'https://icc.example.com' }));
    expect(/[^\x20-\x7E]/.test(json)).toBe(false);
  });
});

describe('notify loop', () => {
  it('posts a triaged incident when enabled and moves it to notified', async () => {
    teamsOn();
    setSetting('icc_base_url', 'https://icc.example.com');
    const post = vi.spyOn(teams, 'postCard').mockResolvedValue({ sent: true, status: 202 });
    const id = insertIncident();
    const stats = await agent.runOnce({ force: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(HOOK);
    expect(post.mock.calls[0][1].actions[0].url).toMatch(/\/ops\/agent\?incident=\d+$/);
    expect(stats.teamsPosted).toBe(1);
    const r = row(id);
    expect(r.state).toBe('notified');
    expect(r.teams_notified_at).toBeTruthy();
    expect(r.teams_error).toBeNull();
    expect(r.notify_count).toBe(0);   // email columns untouched
    expect(agent.getIncident(id).teamsNotifiedAt).toBe(r.teams_notified_at);
  });

  it('does not re-post inside the renotify window', async () => {
    setSetting('ops_agent_renotify_minutes', '60');
    teamsOn();
    const post = vi.spyOn(teams, 'postCard').mockResolvedValue({ sent: true });
    const id = insertIncident();
    db.prepare('UPDATE ops_incidents SET teams_notified_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    await agent.runOnce({ force: true });
    expect(post).not.toHaveBeenCalled();
    expect(row(id).state).toBe('triaged');
  });

  it('never posts while Teams is switched off', async () => {
    setSetting('ops_agent_teams_webhook', encrypt(HOOK));
    const post = vi.spyOn(teams, 'postCard').mockResolvedValue({ sent: true });
    insertIncident();
    await agent.runOnce({ force: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('never posts in demo mode', async () => {
    teamsOn();
    process.env.DASHBOARD_DEMO = '1';
    const post = vi.spyOn(teams, 'postCard').mockResolvedValue({ sent: true });
    const id = insertIncident();
    expect(await agent.notifyTeams(row(id), require('../services/settings').getOpsAgentSettings())).toEqual({ skipped: 'demo mode' });
    await agent.runOnce({ force: true });
    expect(post).not.toHaveBeenCalled();
    expect(row(id).teams_notified_at).toBeNull();
  });

  it('never posts a baseline incident', async () => {
    teamsOn();
    const post = vi.spyOn(teams, 'postCard').mockResolvedValue({ sent: true });
    const id = insertIncident({ baseline: true });
    await agent.runOnce({ force: true });
    expect(post).not.toHaveBeenCalled();
    expect(row(id).state).toBe('notified');
    expect(row(id).teams_notified_at).toBeNull();
  });

  it('posts a resolution card for an incident it had posted, unless switched off', async () => {
    teamsOn();
    const post = vi.spyOn(teams, 'postCard').mockResolvedValue({ sent: true });
    const id = insertIncident({ state: 'resolved' });
    db.prepare("UPDATE ops_incidents SET teams_notified_at = ?, resolution = 'Every alert cleared.' WHERE id = ?").run(NOW, id);
    const s = require('../services/settings').getOpsAgentSettings();
    await agent.notifyResolved(row(id), s, { smtpEnabled: false });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].body[0]).toMatchObject({ text: 'RESOLVED | esx-01', color: 'Good' });
    setSetting('ops_agent_teams_on_resolve', '0');
    await agent.notifyResolved(row(id), require('../services/settings').getOpsAgentSettings(), { smtpEnabled: false });
    expect(post).toHaveBeenCalledTimes(1);
  });

  // Last in this block: a failure holds that incident id back for the retry window.
  it('stores teams_error on a rejected post and keeps the incident triaged', async () => {
    teamsOn();
    const err = Object.assign(new Error('Teams workflow answered HTTP 400'), { code: 'TEAMS_FAILED' });
    const post = vi.spyOn(teams, 'postCard').mockRejectedValue(err);
    const id = insertIncident();
    await agent.runOnce({ force: true });
    expect(post).toHaveBeenCalledTimes(1);
    const r = row(id);
    expect(r.state).toBe('triaged');
    expect(r.teams_error).toBe('Teams workflow answered HTTP 400');
    expect(r.teams_notified_at).toBeNull();
    await agent.runOnce({ force: true });
    expect(post).toHaveBeenCalledTimes(1);   // retry waits, not every tick
  });
});

describe('settings and test route', () => {
  let app;
  beforeAll(() => { app = createApp({ licenseGate: (req, res, next) => next() }); });
  const get = () => request(app).get('/api/settings').set('x-api-key', API_KEY);
  const put = (body) => request(app).put('/api/settings').set('x-api-key', API_KEY).send(body);

  it('round trips the Teams settings and never returns the URL', async () => {
    let res = await get();
    expect(res.body.opsAgent).toMatchObject({ teamsEnabled: false, teamsOnResolve: true, teamsWebhookSet: false });
    res = await put({ opsAgent: { teamsEnabled: true, teamsOnResolve: false, teamsWebhook: HOOK }, iccBaseUrl: 'https://icc.example.com/' });
    expect(res.status).toBe(200);
    res = await get();
    expect(res.body.opsAgent).toMatchObject({ teamsEnabled: true, teamsOnResolve: false, teamsWebhookSet: true, iccBaseUrl: 'https://icc.example.com' });
    expect(res.body.iccBaseUrl).toBe('https://icc.example.com');
    expect(JSON.stringify(res.body)).not.toContain('logic.azure.com');
    expect(require('../services/settings').getTeamsWebhook()).toBe(HOOK);

    await put({ opsAgent: { teamsWebhook: '' } });            // blank keeps
    expect((await get()).body.opsAgent.teamsWebhookSet).toBe(true);
    const other = 'https://prod-01.westus.logic.azure.com/workflows/zzz';
    await put({ opsAgent: { teamsWebhook: other } });         // a new URL replaces
    expect(require('../services/settings').getTeamsWebhook()).toBe(other);
    await put({ opsAgent: { teamsWebhook: null } });          // explicit clear
    expect((await get()).body.opsAgent.teamsWebhookSet).toBe(false);

    expect((await put({ opsAgent: { teamsWebhook: 'http://plain.example.com' } })).status).toBe(400);
    expect((await put({ iccBaseUrl: 'icc.example.com' })).status).toBe(400);
  });

  it('POST /api/ops-agent/test-teams sends the sample card, 409 without a URL, 502 on failure', async () => {
    const post = vi.spyOn(teams, 'postCard').mockResolvedValue({ sent: true });
    let res = await request(app).post('/api/ops-agent/test-teams').set('x-api-key', API_KEY);
    expect(res.status).toBe(409);
    expect(post).not.toHaveBeenCalled();

    setSetting('ops_agent_teams_webhook', encrypt(HOOK));
    res = await request(app).post('/api/ops-agent/test-teams').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(post.mock.calls[0][1].body[0].text).toMatch(/^CRITICAL \| Sample: esx-demo-01 lost a SAN path$/);

    post.mockRejectedValueOnce(Object.assign(new Error('Teams workflow answered HTTP 401'), { code: 'TEAMS_FAILED' }));
    res = await request(app).post('/api/ops-agent/test-teams').set('x-api-key', API_KEY);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Teams workflow answered HTTP 401');

    process.env.DASHBOARD_DEMO = '1';
    res = await request(app).post('/api/ops-agent/test-teams').set('x-api-key', API_KEY);
    expect(res.status).toBe(409);
  });
});
