// Ops Monitor landing-page contribution (manifest hook `opsSummary`, host
// contract landed 2026-08-03 — see backend/core/registry.js
// getOpsSummaryProviders() and backend/routes/ops.js). Ported from the
// built-in netbackupSummary() in backend/routes/ops.js; local helper
// re-implementations of ops.js's one/all/num/count/countSafe/spark7/fnum/
// exception since those are file-local there, not exposed via coreApi
// (plugin-sdk/proxmox/backend/src/ops.js pattern).
const one = (coreApi, sql, ...args) => coreApi.db.prepare(sql).get(...args);
const all = (coreApi, sql, ...args) => coreApi.db.prepare(sql).all(...args);
const num = (v) => Number(v) || 0;
const count = (coreApi, sql, ...args) => num(one(coreApi, sql, ...args)?.c);
const countSafe = (coreApi, sql, ...args) => { try { return count(coreApi, sql, ...args); } catch { return 0; } };
const fnum = (v) => Number(v).toLocaleString('en-US');
const exception = (severity, cnt, text, link) => ({ severity, count: cnt, text, link });

// Align [{d:'YYYY-MM-DD', c}] rows to a dense last-7-days array.
function spark7(rows) {
  const map = new Map(rows.map((r) => [r.d, num(r.c)]));
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push(map.get(d) || 0);
  }
  return out;
}

function opsSummary(coreApi) {
  const sources = count(coreApi, 'SELECT COUNT(*) c FROM netbackup_sources');
  if (!sources) return null;
  const policies = countSafe(coreApi, 'SELECT COUNT(*) c FROM netbackup_policies');
  const storageUnits = countSafe(coreApi, 'SELECT COUNT(*) c FROM netbackup_storage_units');
  const appliances = countSafe(coreApi, 'SELECT COUNT(*) c FROM netbackup_appliances');
  const jobs24h = countSafe(coreApi, "SELECT COUNT(*) c FROM netbackup_jobs WHERE started_at >= datetime('now','-1 day')");
  const failed24h = countSafe(coreApi,
    "SELECT COUNT(*) c FROM netbackup_jobs WHERE started_at >= datetime('now','-1 day') AND (status_code > 0 OR state = 'FAILED')"
  );
  const protectedClients = countSafe(coreApi,
    "SELECT COUNT(DISTINCT client_name) c FROM netbackup_jobs WHERE started_at >= datetime('now','-7 days')"
  );
  const sev = { critical: 0, warning: 0 };
  for (const r of all(coreApi, "SELECT severity, COUNT(*) c FROM netbackup_issue_history WHERE status = 'open' GROUP BY severity")) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
  }
  const exceptions = [];
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical issue${sev.critical === 1 ? '' : 's'}`, '/netbackup/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning issue${sev.warning === 1 ? '' : 's'}`, '/netbackup/alerts'));
  return {
    objects: sources + policies + storageUnits + appliances,
    headline: [
      { label: 'Jobs 24h', value: jobs24h },
      { label: 'Failed 24h', value: failed24h },
      { label: 'Protected clients', value: protectedClients },
    ],
    exceptions,
    spark: spark7(all(coreApi,
      "SELECT date(started_at) d, COUNT(*) c FROM netbackup_jobs WHERE (status_code > 0 OR state = 'FAILED') AND started_at >= datetime('now','-7 days') GROUP BY date(started_at)"
    )),
    sparkLabel: 'failed jobs / day',
  };
}

module.exports = { opsSummary };
