// Cohesity manifest hooks (phase-1 hook contract, WP-B territory). Spread
// into the manifest by index.js (`...hooks`). Ported VERBATIM:
//   - opsSummary        <- backend/routes/ops.js's cohesitySummary()
//                          (EXACT headline labels: 'Clusters', 'Protection jobs')
//   - collectAlerts     <- backend/services/alertNotifier.js's
//                          collectCohesityAlerts() (EXACT sourceKey format
//                          `c${clusterId}:${alertId}` — R10: any change
//                          re-emails every open alert)
//   - searchCategories  <- backend/routes/search.js's 4 cohesity-* entries
//   - server360/server360Suggest <- reshaped from backend/routes/server360.js's
//                          inline cohesity block (raw {objects,agents}) into the
//                          display-ready {title,chip,groups} shape every other
//                          converted plugin's server360 hook returns (registry
//                          getServer360Providers() contract — see
//                          plugin-sdk/proxmox/backend/src/server360.js for the
//                          reference implementation this follows)
//   - initExtras(coreApi) <- starts the licensing/views/gflags schedulers
//                          (the built-in's 3 independent schedulers never
//                          owned by the per-cluster cohesity poller).
//                          Demo-inert: each of the three checks
//                          DASHBOARD_DEMO==='1' internally and no-ops.
// Does NOT declare metricsHistory — cohesity's poller-status sections stay
// core (R7).
const licensing = require('./licensing');
const views = require('./views');
const gflags = require('./gflags');

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

  const FAILED_RUN_STATUSES = "('kFailure','kFailed','kError','kCanceled','kCancelled')";

  const clusters = count('SELECT COUNT(*) c FROM clusters');
  if (!clusters) return null;
  const sev = {};
  for (const r of all('SELECT severity, COUNT(*) c FROM alerts WHERE resolved = 0 AND dismissed = 0 GROUP BY severity')) {
    sev[String(r.severity || '').toLowerCase()] = num(r.c);
  }
  const failed24 = count(
    `SELECT COUNT(*) c FROM protection_runs WHERE status IN ${FAILED_RUN_STATUSES} AND start_time >= datetime('now','-1 day')`
  );
  const jobs = count("SELECT COUNT(DISTINCT job_name) c FROM protection_runs WHERE start_time >= datetime('now','-7 days')");
  const exceptions = [];
  if (failed24) exceptions.push(exception('critical', failed24, `${fnum(failed24)} protection run${failed24 === 1 ? '' : 's'} failed (24h)`, '/data-protection'));
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/cohesity/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning alert${sev.warning === 1 ? '' : 's'}`, '/cohesity/alerts'));
  const gflagChanges = countSafe("SELECT COUNT(*) c FROM gflag_changes WHERE detected_at >= datetime('now','-1 day')");
  if (gflagChanges) exceptions.push(exception('warning', gflagChanges, `${fnum(gflagChanges)} gflag change${gflagChanges === 1 ? '' : 's'} detected (24h)`, '/cohesity/gflags'));
  return {
    objects: clusters + jobs,
    headline: [
      { label: 'Clusters', value: clusters },
      { label: 'Protection jobs', value: jobs },
    ],
    exceptions,
    spark: spark7(all(
      `SELECT date(start_time) d, COUNT(*) c FROM protection_runs
       WHERE status IN ${FAILED_RUN_STATUSES} AND start_time >= datetime('now','-7 days') GROUP BY date(start_time)`
    )),
    sparkLabel: 'failed runs / day',
  };
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return String(value);
}

/** Active Cohesity alerts (not resolved, not dismissed). sourceKey format is
 *  load-bearing — see module header (R10). */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT a.cohesity_alert_id AS alertId, a.cluster_id AS clusterId, a.severity AS severity,
           a.alert_type AS alertType, a.description AS description,
           a.first_seen AS firstSeen, a.last_updated AS lastSeen, c.name AS hostName
    FROM alerts a JOIN clusters c ON a.cluster_id = c.id
    WHERE a.resolved = 0 AND a.dismissed = 0
  `).all();
  return rows.map((r) => ({
    sourceKey: `c${r.clusterId}:${r.alertId}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.hostName,
    message: `${r.alertType ? `${r.alertType}: ` : ''}${r.description || ''}`.trim(),
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
  }));
}

const searchCategories = [
  { key: 'cohesity-clusters', label: 'Clusters', platform: 'cohesity', perm: 'cohesity:clusters:view', base: '/cohesity/clusters',
    sql: `SELECT name AS title, connection_type AS subtitle FROM clusters WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'cohesity-objects', label: 'Objects (Sources)', platform: 'cohesity', perm: 'cohesity:workloads:view', base: '/sources',
    sql: `SELECT o.name AS title, (o.environment || ' · ' || c.name) AS subtitle
          FROM cohesity_objects o JOIN clusters c ON c.id = o.cluster_id
          WHERE o.name LIKE ? ESCAPE '\\' ORDER BY o.name LIMIT ?` },
  { key: 'cohesity-views', label: 'Views', platform: 'cohesity', perm: 'cohesity:views:view', base: '/views',
    sql: `SELECT name AS title, system_name AS subtitle FROM cohesity_views WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'cohesity-groups', label: 'Protection Groups', platform: 'cohesity', perm: 'cohesity:governance:view', base: '/governance',
    sql: `SELECT p.name AS title, c.name AS subtitle FROM policies p JOIN clusters c ON c.id = p.cluster_id
          WHERE p.name LIKE ? ESCAPE '\\' ORDER BY p.name LIMIT ?` },
];

// ── server360 / server360Suggest ────────────────────────────────────────
// Reshaped from routes/server360.js's inline `cohesity: { objects, agents }`
// contribution into the display-ready section shape (facts/lines/link
// groups) every enabled installed plugin returns via
// registry.getServer360Providers().

function server360(coreApi, { names } = {}) {
  const nameList = (names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  if (!nameList.length) return null;
  const db = coreApi.db;
  const namePh = nameList.map(() => '?').join(',');

  const objects = db.prepare(`
    SELECT o.*, c.name AS cluster_name FROM cohesity_objects o
    JOIN clusters c ON c.id = o.cluster_id
    WHERE lower(o.name) IN (${namePh}) ORDER BY o.is_protected DESC
  `).all(...nameList).map((o) => {
    let protectionGroups = [];
    try { protectionGroups = o.protection_groups ? JSON.parse(o.protection_groups) : []; } catch { protectionGroups = []; }
    return { ...o, protection_groups: protectionGroups };
  });
  const agents = db.prepare(`
    SELECT a.*, c.name AS cluster_name FROM cohesity_agents a
    JOIN clusters c ON c.id = a.cluster_id
    WHERE lower(a.name) IN (${namePh})
  `).all(...nameList);

  if (!objects.length && !agents.length) return null;

  const groups = [];
  for (const o of objects) {
    const facts = [
      { label: 'Object', value: `${o.name} (${o.environment || 'Unknown'})` },
      { label: 'Cluster', value: o.cluster_name },
      { label: 'Protected', value: o.is_protected ? 'Yes' : 'No', tone: o.is_protected ? 'ok' : 'crit' },
      { label: 'Protection Groups', value: o.protection_groups.length ? o.protection_groups.join(', ') : '—' },
      o.last_backup_status
        ? { label: 'Last Backup', value: o.last_backup_status, tone: o.last_backup_status === 'kSuccess' ? 'ok' : 'crit' }
        : { label: 'Last Backup', value: '—' },
    ];
    groups.push({
      facts,
      lines: [],
      link: { label: 'Open Object 360 →', href: `/cohesity/object-360?name=${encodeURIComponent(o.name)}` },
    });
  }
  for (const a of agents) {
    if (objects.some((o) => o.cluster_name === a.cluster_name)) continue;
    groups.push({
      facts: [
        { label: 'Agent', value: `${a.name} (${a.cluster_name})` },
        { label: 'Agent Version', value: a.agent_version || '—' },
        { label: 'Agent Status', value: a.agent_status || '—', tone: a.agent_status === 'kHealthy' ? 'ok' : 'neutral' },
      ],
      lines: [],
      link: { label: 'Open Object 360 →', href: `/cohesity/object-360?name=${encodeURIComponent(a.name)}` },
    });
  }

  return { title: 'Backup (Cohesity)', chip: { label: 'Cohesity', color: '#6CB33F' }, groups };
}

function server360Suggest(coreApi, q) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return coreApi.db
    .prepare(`SELECT name FROM cohesity_objects WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`)
    .all(pattern)
    .map((r) => r.name);
}

/** Called once after the per-cluster poller's init() succeeds (index.js).
 *  Each scheduler is independently demo-inert (checks DASHBOARD_DEMO==='1'). */
function initExtras(coreApi) {
  licensing.initLicensing(coreApi);
  views.initViews(coreApi);
  gflags.initGflags(coreApi);
}

module.exports = { opsSummary, collectAlerts, searchCategories, server360, server360Suggest, initExtras };
