// Rubrik platform plugin manifest (ICC contract C1). Polls Rubrik Security
// Cloud live (services in ./rscApi.js + ./poller.js) when an 'rsc' connection
// is registered; demo instances keep their seeded estate instead.
//
// v2.0.0 restructure: this file now only assembles the manifest; the
// migrations (v1-v3, byte-identical) live in ./migrations.js and the v1.x
// routes (moved verbatim) live in ./routes.js.

const { migrations } = require('./migrations');
const { createRouter } = require('./routes');
const { server360, server360Suggest } = require('./server360');
const { createRubrikPoller: createPoller } = require('./poller');

// Ops landing page contribution (host getOpsSummaryProviders). Same shape as
// the built-in summarizers in the host's routes/ops.js: objects, headline,
// exceptions, 7-day spark. Every count is table-tolerant so an older schema
// degrades a figure, never the card.
const num = (v) => Number(v) || 0;
const fnum = (v) => Number(v).toLocaleString('en-US');
const exception = (severity, cnt, text, link) => ({ severity, count: cnt, text, link });
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
  const db = coreApi.db;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const count = (sql, ...args) => num(one(sql, ...args)?.c);
  const countSafe = (sql, ...args) => { try { return count(sql, ...args); } catch { return 0; } };
  const allSafe = (sql, ...args) => { try { return all(sql, ...args); } catch { return []; } };

  const clusters = countSafe('SELECT COUNT(*) c FROM rubrik_clusters');
  if (!clusters) return null;
  const clustersDown = countSafe("SELECT COUNT(*) c FROM rubrik_clusters WHERE status IS NOT NULL AND status != 'Connected'");
  const objects = countSafe('SELECT COUNT(*) c FROM rubrik_protected_objects');
  const nonCompliant = countSafe('SELECT COUNT(*) c FROM rubrik_protected_objects WHERE compliant = 0');
  const slaDomains = countSafe('SELECT COUNT(*) c FROM rubrik_sla_domains');
  const failed24h = countSafe("SELECT COUNT(*) c FROM rubrik_jobs WHERE status = 'Failed' AND started_at >= datetime('now','-1 day')");
  const anomalies = countSafe("SELECT COUNT(*) c FROM rubrik_anomaly_events WHERE status IN ('Open','Investigating')");
  const sev = { critical: 0, warning: 0 };
  for (const r of allSafe('SELECT severity, COUNT(*) c FROM rubrik_alerts WHERE resolved = 0 AND dismissed = 0 GROUP BY severity')) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
  }

  const exceptions = [];
  if (clustersDown) exceptions.push(exception('critical', clustersDown, `${fnum(clustersDown)} cluster${clustersDown === 1 ? '' : 's'} not connected`, '/rubrik/clusters'));
  if (anomalies) exceptions.push(exception('critical', anomalies, `${fnum(anomalies)} ransomware anomal${anomalies === 1 ? 'y' : 'ies'} open`, '/rubrik/security'));
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/rubrik/alerts'));
  if (failed24h) exceptions.push(exception('critical', failed24h, `${fnum(failed24h)} job${failed24h === 1 ? '' : 's'} failed (24h)`, '/rubrik/jobs'));
  if (nonCompliant) exceptions.push(exception('warning', nonCompliant, `${fnum(nonCompliant)} object${nonCompliant === 1 ? '' : 's'} out of SLA compliance`, '/rubrik/compliance'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning alert${sev.warning === 1 ? '' : 's'}`, '/rubrik/alerts'));

  return {
    objects: clusters + objects + slaDomains,
    headline: [
      { label: 'Clusters', value: clusters },
      { label: 'Protected objects', value: objects },
    ],
    exceptions,
    spark: spark7(allSafe("SELECT day d, COUNT(*) c FROM rubrik_protection_runs WHERE status = 'Failed' AND day >= date('now','-7 days') GROUP BY day")),
    sparkLabel: 'failed runs / day',
  };
}

module.exports = {
  id: 'rubrik',
  name: 'Rubrik',
  apiVersion: 1,
  color: '#00B388',
  migrations,
  createRouter,
  // Host Server 360 contribution (ops page): display-ready backup posture
  // for any Rubrik protected object matching the pivot identity.
  server360,
  server360Suggest,
  // Live RSC polling, one task per registered 'rsc' connection. Demo
  // instances keep their seeded estate and skip polling entirely.
  createPoller,
  // Gives Rubrik a section in /api/poller/status (contract: arraysTable +
  // metricsTable joined on arrayIdColumn).
  metricsHistory: { arraysTable: 'rubrik_clusters', metricsTable: 'rubrik_capacity_history', arrayIdColumn: 'cluster_id' },
  opsSummary,
  statusTables: [
    'rubrik_clusters',
    'rubrik_protected_objects',
    'rubrik_jobs',
    'rubrik_sla_domains',
    'rubrik_capacity_history',
    'rubrik_replication_pairs',
    'rubrik_archival_locations',
    'rubrik_anomaly_events',
    'rubrik_threat_hunts',
    'rubrik_events',
    'rubrik_connections',
  ],
};
