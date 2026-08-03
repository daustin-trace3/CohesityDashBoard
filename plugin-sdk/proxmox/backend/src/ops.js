// Ops Monitor landing-page contribution (manifest hook `opsSummary`, host
// contract landed 2026-08-03 — see backend/core/registry.js
// getOpsSummaryProviders() and backend/routes/ops.js). Ported from the
// built-in proxmoxSummary() in backend/routes/ops.js; local helper
// re-implementations of ops.js's one/all/num/count/countSafe/spark7/fnum/
// exception since those are file-local there, not exposed via coreApi.
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
  const servers = count(coreApi, 'SELECT COUNT(*) c FROM proxmox_servers');
  if (!servers) return null;
  const nodes = countSafe(coreApi, 'SELECT COUNT(*) c FROM proxmox_nodes');
  const nodesOffline = countSafe(coreApi, "SELECT COUNT(*) c FROM proxmox_nodes WHERE status != 'online'");
  const guests = countSafe(coreApi, 'SELECT COUNT(*) c FROM proxmox_guests');
  const guestsRunning = countSafe(coreApi, "SELECT COUNT(*) c FROM proxmox_guests WHERE status = 'running'");
  const storagePools = countSafe(coreApi, 'SELECT COUNT(*) c FROM proxmox_storage');
  const sev = { critical: 0, warning: 0 };
  for (const r of all(coreApi, "SELECT severity, COUNT(*) c FROM proxmox_issue_history WHERE status = 'open' GROUP BY severity")) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
  }
  const exceptions = [];
  if (nodesOffline) exceptions.push(exception('critical', nodesOffline, `${fnum(nodesOffline)} node${nodesOffline === 1 ? '' : 's'} offline`, '/proxmox/nodes'));
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical issue${sev.critical === 1 ? '' : 's'}`, '/proxmox/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning issue${sev.warning === 1 ? '' : 's'}`, '/proxmox/alerts'));
  return {
    objects: nodes + guests + storagePools,
    headline: [
      { label: 'Nodes', value: nodes },
      { label: 'Guests', value: `${guestsRunning}/${guests}` },
    ],
    exceptions,
    spark: spark7(all(coreApi,
      "SELECT date(started_at) d, COUNT(*) c FROM proxmox_tasks WHERE status IS NOT NULL AND status != 'OK' AND started_at >= datetime('now','-7 days') GROUP BY date(started_at)"
    )),
    sparkLabel: 'failed tasks / day',
  };
}

module.exports = { opsSummary };
