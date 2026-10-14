// Operations Agent: Microsoft Teams channel. Microsoft retired the Office 365
// connector incoming webhooks, so the target is a Power Automate flow with the
// "When a Teams webhook request is received" trigger (the Workflows app in
// Teams). The flow takes a message envelope carrying one Adaptive Card and
// posts it into the chat or channel it was built for.
//
// buildCard and buildResolvedCard are pure, so the card shape is testable
// without a network; postCard is the only thing that leaves the machine.
const axios = require('axios');
const { isDemo } = require('./demoMode');
const { platformMeta } = require('./platformMeta');

const POST_TIMEOUT_MS = 10000;
const SUMMARY_LINES = 5;
const NEXT_STEPS = 3;

/** Header colour by severity: Attention for critical/error, Warning for warning. */
function severityColor(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical' || s === 'error') return 'Attention';
  if (s === 'warning') return 'Warning';
  return 'Default';
}

/** Deep link to the incident on the Ops Agent page, or null with no base URL.
 *  A multi-tenant install serves every page under /t/<tenant>. */
function incidentLink(baseUrl, tenantId, id) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${tenantId ? `/t/${encodeURIComponent(tenantId)}` : ''}/ops/agent?incident=${id}`;
}

const text = (t, o = {}) => ({ type: 'TextBlock', text: String(t), wrap: true, ...o });

function cardShell(body, link) {
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  if (link) card.actions = [{ type: 'Action.OpenUrl', title: 'Open in ICC', url: link }];
  return card;
}

function footer(link, agentName) {
  return link
    ? text(`Analysis from ${agentName}.`, { isSubtle: true, size: 'Small', spacing: 'Medium' })
    : text(`Analysis from ${agentName}. No ICC address is set, so there is no link; set it under Global Settings > Operations Agent.`, { isSubtle: true, size: 'Small', spacing: 'Medium' });
}

/**
 * The incident card. inc is an ops_incidents row (platforms as its JSON
 * string), analysis the stored triage. opts: agentName, baseUrl, tenantId,
 * update (true when this incident was posted before).
 */
function buildCard(inc, analysis, opts = {}) {
  const a = analysis || {};
  const agentName = opts.agentName || 'ICC Operations Agent';
  const sev = String(inc.severity || 'warning').toUpperCase();
  let platforms = [];
  try { platforms = JSON.parse(inc.platforms || '[]'); } catch { platforms = []; }
  const labels = platforms.map((p) => platformMeta(p).label);
  const link = incidentLink(opts.baseUrl, opts.tenantId, inc.id);

  const body = [
    text(`${sev} | ${a.title || inc.title || `Incident #${inc.id}`}`, { size: 'Medium', weight: 'Bolder', color: severityColor(inc.severity) }),
    text(`${agentName}, incident #${inc.id}${opts.update ? ' (update)' : ''}`, { isSubtle: true, spacing: 'None' }),
  ];
  if (a.human_required === true) {
    body.push(text(`Human required${a.human_reason ? `: ${a.human_reason}` : ''}`, { weight: 'Bolder', color: 'Attention' }));
  }
  const facts = [];
  if (inc.host) facts.push({ title: 'Host', value: String(inc.host) });
  if (labels.length) facts.push({ title: 'Platforms', value: labels.join(', ') });
  if (a.classification) facts.push({ title: 'Classification', value: `${a.classification} (${a.confidence || 'low'} confidence)` });
  if (facts.length) body.push({ type: 'FactSet', facts });

  const lines = String(a.summary || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, SUMMARY_LINES);
  if (lines.length) {
    body.push(text('What happened', { weight: 'Bolder', spacing: 'Medium' }));
    for (const l of lines) body.push(text(lines.length > 1 ? `- ${l}` : l, { spacing: 'Small' }));
  }
  const steps = (a.next_steps || []).slice(0, NEXT_STEPS);
  if (steps.length) {
    body.push(text('Next steps', { weight: 'Bolder', spacing: 'Medium' }));
    steps.forEach((s, i) => body.push(text(`${i + 1}. [${s.owner || 'L2'}] ${s.action}`, { spacing: 'Small' })));
  }
  body.push(footer(link, agentName));
  return cardShell(body, link);
}

/** Short closure card for an incident that had been posted. */
function buildResolvedCard(inc, opts = {}) {
  const agentName = opts.agentName || 'ICC Operations Agent';
  let platforms = [];
  try { platforms = JSON.parse(inc.platforms || '[]'); } catch { platforms = []; }
  const link = incidentLink(opts.baseUrl, opts.tenantId, inc.id);
  const body = [
    text(`RESOLVED | ${inc.title || `Incident #${inc.id}`}`, { size: 'Medium', weight: 'Bolder', color: 'Good' }),
    text(`${agentName}, incident #${inc.id}${platforms.length ? ` | ${platforms.map((p) => platformMeta(p).label).join(', ')}` : ''}`, { isSubtle: true, spacing: 'None' }),
    text(inc.resolution || 'Resolved.'),
    text('No action is needed unless it returns.', { isSubtle: true, size: 'Small', spacing: 'Medium' }),
  ];
  return cardShell(body, link);
}

/** The message envelope the Workflows trigger expects. */
function envelope(card) {
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
}

/** POST one card to the workflow URL. Throws on a non-2xx answer or a network
 *  failure; the message never carries the URL, which is the secret. */
async function postCard(url, card) {
  if (isDemo()) return { skipped: 'demo mode' };
  try {
    const res = await axios.post(url, envelope(card), {
      timeout: POST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 0,
    });
    return { sent: true, status: res.status };
  } catch (err) {
    const status = err.response?.status;
    const e = new Error(status ? `Teams workflow answered HTTP ${status}` : `Teams workflow unreachable: ${err.code || err.message}`);
    e.code = 'TEAMS_FAILED';
    throw e;
  }
}

module.exports = { buildCard, buildResolvedCard, postCard, envelope, severityColor, incidentLink };
