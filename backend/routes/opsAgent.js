// Operations Agent: incidents the agent opened, its triage, and manual
// actions. Reachable to any authenticated caller like /api/service-status;
// settings live under /api/settings (admin).
const express = require('express');
const agent = require('../services/opsAgent');
const capabilities = require('../services/agentCapabilities');
const agentProfiles = require('../services/agentProfiles');
const observations = require('../services/agentObservations');
const { getSetting, getObservationSettings } = require('../services/settings');
const { requirePermission } = require('../middleware/requirePermission');
const { requireOps, canViewAnyOf, canViewPlatform, grantsOf } = require('../services/platformAccess');
const { hasPermission } = require('../services/rbac');

const router = express.Router();

// Every read needs ops:*:view and every write ops:*:manage. The admin routes
// below keep their own requirePermission on top of this gate.
router.use((req, res, next) => requireOps(req.method === 'GET' ? 'view' : 'manage')(req, res, next));

/** An incident is visible to a caller who holds *:*:view or a view grant on any
 *  platform the incident touches. Counts on /status and /pulse stay
 *  estate-wide; only the lists and single reads are scoped. */
function visibleIncident(req, inc) {
  const grants = grantsOf(req);
  if (hasPermission(grants, '*:*:view')) return true;
  const platforms = Array.isArray(inc && inc.platforms) ? inc.platforms : [];
  return canViewAnyOf(grants, platforms);
}

/** 404 unless the incident exists and is visible; returns the incident or null (response sent). */
function guardIncident(req, res, id) {
  const inc = agent.getIncident(id);
  if (!inc || !visibleIncident(req, inc)) { res.status(404).json({ error: 'Incident not found.' }); return null; }
  return inc;
}

const observationVisible = (req, platform) => hasPermission(grantsOf(req), '*:*:view') || canViewPlatform(grantsOf(req), platform);

function fail(res, err) {
  if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
  if (err.code === 'NOTE_REQUIRED') return res.status(400).json({ error: err.message, field: 'note' });
  if (err.code === 'BAD_DAYS') return res.status(400).json({ error: err.message, field: 'days' });
  if (err.code === 'LLM_NOT_CONFIGURED') return res.status(503).json({ error: err.message });
  if (err.code === 'LLM_RATE_LIMITED') return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
  if (err.code === 'SMTP_NOT_CONFIGURED' || err.code === 'NO_RECIPIENTS') return res.status(409).json({ error: err.message });
  if (err.code === 'TEAMS_NOT_CONFIGURED') return res.status(409).json({ error: err.message });
  if (err.code === 'TEAMS_FAILED') return res.status(502).json({ error: err.message });
  if (err.code === 'SMTP_FAILED' || err.code === 'LLM_REQUEST_FAILED') return res.status(502).json({ error: err.message, detail: err.detail });
  return null;
}

// Counts here and on /pulse are estate-wide; lists and single reads are scoped by platform.
router.get('/status', (req, res, next) => {
  try { res.json(agent.status()); } catch (err) { next(err); }
});

/** Live-update probe: tiny, uncached, safe to call every few seconds. */
router.get('/pulse', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(agent.pulse());
  } catch (err) { next(err); }
});

router.get('/incidents', (req, res, next) => {
  try {
    const state = ['open', 'resolved', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const limit = Number(req.query.limit) || 100;
    const needsHuman = req.query.needsHuman === '1' || req.query.needsHuman === 'true';
    res.json(agent.listIncidents({ state, limit, needsHuman }).filter((i) => visibleIncident(req, i)));
  } catch (err) { next(err); }
});

router.get('/incidents/:id', (req, res, next) => {
  try {
    const inc = guardIncident(req, res, Number(req.params.id));
    if (!inc) return;
    res.json(inc);
  } catch (err) { next(err); }
});

router.get('/incidents/:id/analyses', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!guardIncident(req, res, id)) return;
    res.json(agent.listAnalyses(id, { full: req.query.full === '1' || req.query.full === 'true' }));
  } catch (err) { next(err); }
});

router.post('/incidents/:id/retriage', async (req, res, next) => {
  try { if (!guardIncident(req, res, Number(req.params.id))) return; res.json(await agent.retriage(Number(req.params.id))); } catch (err) { if (!fail(res, err)) next(err); }
});

router.post('/incidents/:id/resend', async (req, res, next) => {
  try { if (!guardIncident(req, res, Number(req.params.id))) return; res.json(await agent.resend(Number(req.params.id))); } catch (err) { if (!fail(res, err)) next(err); }
});

const actor = (req) => req.auth?.user?.username || req.user?.username || 'manual';
const noteOf = (req) => (req.body && typeof req.body.note === 'string' ? req.body.note : null);

router.post('/incidents/:id/resolve', (req, res, next) => {
  try {
    if (!guardIncident(req, res, Number(req.params.id))) return;
    res.json(agent.resolve(Number(req.params.id), actor(req), noteOf(req)));
  } catch (err) { if (!fail(res, err)) next(err); }
});

/** Acknowledge: someone has it. Stops reminders; the incident stays open. */
router.post('/incidents/:id/ack', (req, res, next) => {
  try { if (!guardIncident(req, res, Number(req.params.id))) return; res.json(agent.acknowledge(Number(req.params.id), actor(req), noteOf(req))); } catch (err) { if (!fail(res, err)) next(err); }
});

router.post('/incidents/:id/unack', (req, res, next) => {
  try { if (!guardIncident(req, res, Number(req.params.id))) return; res.json(agent.unacknowledge(Number(req.params.id), actor(req))); } catch (err) { if (!fail(res, err)) next(err); }
});

/** Snooze: pause reminders for 1 to 90 days; 0 clears the snooze. */
router.post('/incidents/:id/snooze', (req, res, next) => {
  try { if (!guardIncident(req, res, Number(req.params.id))) return; res.json(agent.snooze(Number(req.params.id), req.body && req.body.days, actor(req))); } catch (err) { if (!fail(res, err)) next(err); }
});

/** Run one tick now, even when the agent is switched off (manual check). */
router.post('/run', async (req, res, next) => {
  try {
    const stats = await agent.runOnce({ force: true });
    res.json({ ran: Boolean(stats), stats: stats || null, status: agent.status() });
  } catch (err) { next(err); }
});

/** Observation episodes (sustained-signal findings over polled metrics). */
router.get('/observations', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const scope = ['active', 'closed', 'all', 'watching'].includes(req.query.scope) ? req.query.scope : 'active';
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const settings = getObservationSettings();
    const obs = new Map(observations.listObservers(settings).map((o) => [o.id, o]));
    const patterns = new Map();
    for (const g of observations.patternGroups(new Date().toISOString(), settings)) patterns.set(`${g[0].observer_id}|${g[0].subject_key}`, g.length);
    if (scope === 'watching') {
      return res.json(observations.watchingEpisodes({ obs }).filter((e) => observationVisible(req, e.platform)).slice(0, limit).map((e) => {
        const n = patterns.get(`${e.observerId}|${e.subjectKey}`) || 0;
        return { ...e, inPattern: n > 0, patternCount: n };
      }));
    }
    const rows = observations.listEpisodes({ scope, limit }).filter((r) => observationVisible(req, r.platform));
    res.json(rows.map((r) => {
      const n = patterns.get(`${r.observer_id}|${r.subject_key}`) || 0;
      return { ...observations.describe(r, { obs }), inPattern: n > 0, patternCount: n };
    }));
  } catch (err) { next(err); }
});

router.get('/observations/:id', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const row = observations.getEpisode(Number(req.params.id));
    if (!row || !observationVisible(req, row.platform)) return res.status(404).json({ error: 'Observation not found.' });
    const settings = getObservationSettings();
    const obs = new Map(observations.listObservers(settings).map((o) => [o.id, o]));
    const history = observations.episodeHistory(row.subject_key, 30)
      .filter((h) => h.id !== row.id)
      .map((h) => observations.describe(h, { seriesCap: 0, obs }));
    const n = observations.patternGroups(new Date().toISOString(), settings)
      .filter((g) => g[0].observer_id === row.observer_id && g[0].subject_key === row.subject_key).map((g) => g.length)[0] || 0;
    res.json({ ...observations.describe(row, { seriesCap: 0, obs }), inPattern: n > 0, patternCount: n, history });
  } catch (err) { next(err); }
});

/** Every observer (built-in and pack) with its enabled state and the live
 *  warn and crit lines read from the owning platform's settings. */
router.get('/observers', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const settings = getObservationSettings();
    res.json(observations.listObservers(settings).filter((o) => observationVisible(req, o.platform)).map((o) => {
      let thresholds = { warn: null, crit: null };
      try { thresholds = observations.getObserver(o.id).thresholds(getSetting); } catch { /* observer threshold read failed */ }
      return { ...o, thresholds: { warn: thresholds.warn, crit: thresholds.crit } };
    }));
  } catch (err) { next(err); }
});

/** The capability catalog with each one's enabled state. Toggles are saved
 *  through PUT /api/settings { opsAgent: { capabilities: { id: bool } } },
 *  which carries the admin permission; this read is for the page and the
 *  incident modal. */
router.get('/capabilities', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ capabilities: capabilities.listCapabilities(), riskClasses: capabilities.RISK_CLASSES });
  } catch (err) { next(err); }
});

/** Audit trail: what the agent ran, against what, with what result. */
router.get('/capability-runs', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const incidentId = req.query.incident ? Number(req.query.incident) : null;
    res.json(capabilities.listRuns({ limit, incidentId }));
  } catch (err) { next(err); }
});

/** Platform profiles for the enabled platforms: focus text, port map, guest
 *  ports, evidence budget and relation sentences, each with its default and
 *  where the current value comes from. Saved through PUT /api/settings
 *  { opsAgent: { platformProfiles: { <id>: { focus, ports, guestPorts } } } }. */
router.get('/profiles', (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ profiles: agentProfiles.listProfiles(), maxFocus: agentProfiles.MAX_FOCUS, osFamilies: agentProfiles.OS_FAMILIES });
  } catch (err) { next(err); }
});

/** The system prompt a triage of this incident would send, built from its
 *  stored evidence. No model call and no probes. */
router.get('/prompt-preview', requirePermission(() => 'admin:settings:view'), (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const inc = agent.getIncident(Number(req.query.incidentId));
    if (!inc) return res.status(404).json({ error: 'Incident not found.' });
    const evidence = inc.evidence || { incident: { platforms: inc.platforms }, alerts: [] };
    if (!evidence.incident) evidence.incident = { platforms: inc.platforms };
    const built = agent.systemPromptFor(evidence);
    res.json({
      system: built.system, focusUsed: built.focusUsed, chars: built.chars, approxTokens: Math.ceil(built.chars / 4),
      evidenceChars: JSON.stringify(evidence).length, relations: evidence.relations || [],
    });
  } catch (err) { next(err); }
});

router.get('/sample-email', (req, res, next) => {
  try { res.json(agent.sampleEmail()); } catch (err) { next(err); }
});

router.post('/test-email', async (req, res, next) => {
  try { res.json(await agent.sendSampleEmail()); } catch (err) { if (!fail(res, err)) next(err); }
});

/** Post the sample incident card to the stored Teams workflow URL. Same gate
 *  as PUT /api/settings, since it spends the saved secret. */
router.post('/test-teams', requirePermission(() => 'admin:settings:manage'), async (req, res, next) => {
  try { res.json(await agent.sendSampleTeams()); } catch (err) { if (!fail(res, err)) next(err); }
});

module.exports = router;
