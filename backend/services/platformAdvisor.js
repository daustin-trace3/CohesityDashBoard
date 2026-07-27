// Shared AI Advisor engine for per-platform report generation, modeled
// exactly on services/aiAdvisor.js's canonical sequence (anonymize -> prompt
// -> audit -> chatCompletion -> restore -> cache). Each platform (Pure,
// NetApp, Zerto, vCenter, Dell, Aria) supplies its own report specs and a
// dedicated cache table via createPlatformAdvisor({ platform, feature, table, reports }).
const db = require('../db/database');
const { getSetting, getAnalysisTtlHours } = require('./settings');
const { chatCompletion, resolveProvider, isConfigured } = require('./llmProvider');
const { createAnonymizer, PROMPT_NOTE } = require('./anonymizer');
const { recordExchange, attachResponse } = require('./aiAudit');
const { fmtBytes } = require('./insights');
const logger = require('../utils/logger');

function estateContext() {
  return (getSetting('llm_estate_context') || process.env.LLM_ESTATE_CONTEXT || '').trim();
}

// Shared helpers for the per-platform gatherers below (same patterns as
// aiAdvisor.js's capacity-trend math).
function linReg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x; }
  const denom = n * sx2 - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function parseUtcMs(ts) {
  if (!ts) return 0;
  return new Date(String(ts).replace(' ', 'T').replace(/Z*$/, 'Z')).getTime();
}

/**
 * @param {object} opts
 * @param {string} opts.platform - platform id, e.g. 'pure' (used in error logs only)
 * @param {string} opts.feature - audit label, e.g. 'Pure AI Advisor'
 * @param {string} opts.table - dedicated cache table name, e.g. 'pure_ai_reports'
 * @param {Record<string, {system: string, gather: () => object, noun: string}>} opts.reports
 */
function createPlatformAdvisor({ platform, feature, table, reports }) {
  const REPORTS = Object.keys(reports);

  async function generateReport(reportKey) {
    const spec = reports[reportKey];
    if (!spec) { const e = new Error('Unknown report.'); e.code = 'BAD_REPORT'; throw e; }
    if (!isConfigured()) { const e = new Error('LLM not configured.'); e.code = 'LLM_NOT_CONFIGURED'; throw e; }
    const { model: MODEL } = resolveProvider();

    const anon = createAnonymizer();
    const context = anon.anonymize(spec.gather());
    let system = spec.system + PROMPT_NOTE;
    const ec = estateContext();
    if (ec) system += ' Operator context describing what is NORMAL for this estate — treat as authoritative and do NOT flag anything it says is expected: ' + anon.anonymize(ec);

    const userPrompt =
      `Estate data (JSON):\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\nProduce the ${spec.noun}.`;

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ];
    const auditId = recordExchange({
      platform,
      feature,
      label: spec.noun,
      model: MODEL,
      messages,
      mappings: anon.mappings(),
    });

    let content;
    try {
      content = await chatCompletion(messages);
    } catch (e) {
      logger.error(`[${platform}Advisor] ${reportKey} generation failed:`, e.code || '', e.detail || e.message);
      throw e;
    }
    if (!content) { const e = new Error('LLM returned an empty response.'); e.code = 'LLM_EMPTY'; throw e; }

    attachResponse(auditId, content);
    content = anon.restore(content);

    const generatedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO ${table} (report_key, model, content, generated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(report_key) DO UPDATE SET model = excluded.model, content = excluded.content, generated_at = excluded.generated_at
    `).run(reportKey, MODEL, content, generatedAt);

    return { reportKey, model: MODEL, content, generatedAt, stale: false, ttlHours: getAnalysisTtlHours() };
  }

  function getCachedReport(reportKey) {
    const row = db.prepare(
      `SELECT report_key AS reportKey, model, content, generated_at AS generatedAt FROM ${table} WHERE report_key = ?`
    ).get(reportKey);
    if (!row) return null;
    const ttlHours = getAnalysisTtlHours();
    row.stale = (Date.now() - new Date(row.generatedAt).getTime()) > ttlHours * 60 * 60 * 1000;
    row.ttlHours = ttlHours;
    return row;
  }

  return { REPORTS, generateReport, getCachedReport, isConfigured };
}

module.exports = { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes };
