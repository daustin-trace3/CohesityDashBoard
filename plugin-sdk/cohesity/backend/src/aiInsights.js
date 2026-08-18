// Thin adapter satisfying WP-A's routerData.js optional-require contract
// verbatim (`isAiEnabled(coreApi)`, `getCachedReview(alertId, coreApi)`,
// `reviewAlert(alertId, opts, coreApi)` — see routerData.js header). All
// actual logic (LLM plumbing via coreApi.advisor) lives in ./advisor.js's
// shared per-coreApi advisor instance — see that file's header for why
// backend/services/aiInsights.js's original direct llmProvider/aiAudit calls
// couldn't be ported as-is.
const { createCohesityAdvisor } = require('./advisor');

function isAiEnabled(coreApi) {
  return createCohesityAdvisor(coreApi).isAiEnabled();
}

function getCachedReview(alertId, coreApi) {
  return createCohesityAdvisor(coreApi).getCachedReview(alertId);
}

function reviewAlert(alertId, opts, coreApi) {
  return createCohesityAdvisor(coreApi).reviewAlert(alertId, opts);
}

module.exports = { isAiEnabled, getCachedReview, reviewAlert };
