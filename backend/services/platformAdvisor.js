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
 * @param {Record<string, {system: string, gather: (params?: object) => object, noun: string|Function, scoped?: boolean}>} opts.reports
 *   A report with `scoped: true` analyses ONE object (a device, a host): callers pass
 *   { scope } (its identifier), gather(params) receives it and returns null when the
 *   object does not exist, and the cache row is keyed `<reportKey>:<scope>` so every
 *   object keeps its own report. `noun` may be a function of params for the label.
 */
function createPlatformAdvisor({ platform, feature, table, reports }) {
  const REPORTS = Object.keys(reports);
  const SCOPED = REPORTS.filter((k) => reports[k].scoped);
  const isScoped = (reportKey) => !!(reports[reportKey] && reports[reportKey].scoped);

  function cacheKey(reportKey, params) {
    const spec = reports[reportKey];
    if (!spec) { const e = new Error('Unknown report.'); e.code = 'BAD_REPORT'; throw e; }
    if (!spec.scoped) return reportKey;
    const scope = String((params && params.scope) || '').trim();
    if (!scope) { const e = new Error('This report needs a scope (the object to analyse).'); e.code = 'BAD_SCOPE'; throw e; }
    return `${reportKey}:${scope}`;
  }

  async function generateReport(reportKey, params = {}) {
    const spec = reports[reportKey];
    const key = cacheKey(reportKey, params);
    if (!isConfigured()) { const e = new Error('LLM not configured.'); e.code = 'LLM_NOT_CONFIGURED'; throw e; }
    const { model: MODEL } = resolveProvider();

    const raw = spec.scoped ? spec.gather(params) : spec.gather();
    if (spec.scoped && raw == null) { const e = new Error('Nothing found for that scope.'); e.code = 'SCOPE_NOT_FOUND'; throw e; }
    const noun = typeof spec.noun === 'function' ? spec.noun(params) : spec.noun;

    const anon = createAnonymizer();
    const context = anon.anonymize(raw);
    let system = spec.system + PROMPT_NOTE;
    const ec = estateContext();
    if (ec) system += ' Operator context describing what is NORMAL for this estate — treat as authoritative and do NOT flag anything it says is expected: ' + anon.anonymize(ec);

    const userPrompt =
      `Estate data (JSON):\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\nProduce the ${anon.anonymize(noun)}.`;

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ];
    const auditId = recordExchange({
      platform,
      feature,
      label: noun,
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
    `).run(key, MODEL, content, generatedAt);

    return { reportKey, scope: spec.scoped ? params.scope : undefined, model: MODEL, content, generatedAt, stale: false, ttlHours: getAnalysisTtlHours() };
  }

  function getCachedReport(reportKey, params = {}) {
    if (!reports[reportKey]) return null;
    let key;
    try { key = cacheKey(reportKey, params); } catch { return null; }
    const row = db.prepare(
      `SELECT report_key AS reportKey, model, content, generated_at AS generatedAt FROM ${table} WHERE report_key = ?`
    ).get(key);
    if (!row) return null;
    row.reportKey = reportKey;
    if (reports[reportKey].scoped) row.scope = params.scope;
    const ttlHours = getAnalysisTtlHours();
    row.stale = (Date.now() - new Date(row.generatedAt).getTime()) > ttlHours * 60 * 60 * 1000;
    row.ttlHours = ttlHours;
    return row;
  }

  return { REPORTS, SCOPED, isScoped, generateReport, getCachedReport, isConfigured };
}

module.exports = { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes };
