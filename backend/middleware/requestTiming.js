// Logs every API request that takes longer than ICC_SLOW_REQUEST_MS (default
// 1500 ms) with its method, path and status, and, when the SQL profiler is on
// (core/sqlProfile.js), the heaviest statements that ran meanwhile. This is
// the first thing to read when a page "sits on loading" on a box this session
// cannot reach: the line names the route, the SQL lines name the cause.
const logger = require('../utils/logger');
const sqlProfile = require('../core/sqlProfile');

const thresholdMs = () => {
  const n = Number(process.env.ICC_SLOW_REQUEST_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
};

function requestTiming(req, res, next) {
  const t0 = process.hrtime.bigint();
  const before = sqlProfile.isInstalled() ? sqlProfile.snapshot() : null;
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < thresholdMs()) return;
    let detail = '';
    if (before) {
      const after = sqlProfile.snapshot();
      const sqlMs = after.ms - before.ms;
      const calls = after.calls - before.calls;
      const rows = sqlProfile.diffTop(before, after, 3);
      detail = ` sql ${sqlMs.toFixed(0)} ms in ${calls} statements` + rows.map((r) => `\n    ${r.ms.toFixed(0)} ms ${r.calls} x  ${r.k}`).join('');
    }
    logger.warn(`[http] slow request ${ms.toFixed(0)} ms ${req.method} ${req.originalUrl} -> ${res.statusCode}${detail}`);
  });
  next();
}

module.exports = { requestTiming };
