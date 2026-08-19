// Dell reports sub-router, mounted at /api/dell/reports. Fifteen read-only
// audit/operations/support reports, every one served from tables the poller
// already fills — no new appliance calls. Each endpoint returns { rows, summary? }
// shaped for the generic report table on DellReportsPage.
const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../db/database');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const days = (req, dflt) => req.query.days || dflt;
const daysParam = query('days').optional().isInt({ min: 1, max: 365 }).toInt();
const deviceParam = query('deviceId').optional().isInt().toInt();

// iDRAC login/logout messages carry user + source IP + protocol in prose:
//   "Successfully logged in using root, from 10.32.22.103 and wsman."
//   "The session for root from 10.40.2.15 using GUI is logged off."
function parseAccessMessage(msg) {
  const m1 = String(msg || '').match(/using\s+(\S+?),\s+from\s+([\d.]+)\s+and\s+(\w+)/i);
  if (m1) return { user: m1[1], sourceIp: m1[2], protocol: m1[3] };
  const m2 = String(msg || '').match(/session\s+for\s+(\S+)\s+from\s+([\d.]+)\s+using\s+(\w+)/i);
  if (m2) return { user: m2[1], sourceIp: m2[2], protocol: m2[3] };
  return { user: null, sourceIp: null, protocol: null };
}

/** 1. AUDIT — iDRAC access: every Audit-category hardware-log entry, with
 *  user/source IP/protocol parsed out of the message where possible. */
router.get('/idrac-access', [daysParam], validate, (req, res, next) => {
  try {
    const d = days(req, 30);
    const rows = db.prepare(`
      SELECT l.created_at, l.message_id, l.message, l.severity,
        dv.name AS device_name, dv.service_tag, o.name AS ome_name
      FROM dell_hardware_logs l
      JOIN dell_ome_instances o ON o.id = l.ome_id
      LEFT JOIN dell_devices dv ON dv.ome_id = l.ome_id AND dv.device_id = l.device_id
      WHERE l.category = 'Audit' AND l.created_at >= datetime('now', ?)
      ORDER BY l.created_at DESC LIMIT 5000
    `).all(`-${d} days`).map((r) => ({ ...r, ...parseAccessMessage(r.message) }));
    const users = {};
    let offHours = 0;
    for (const r of rows) {
      if (r.user) users[r.user] = (users[r.user] || 0) + 1;
      const h = Number(String(r.created_at).slice(11, 13));
      if (h < 6 || h >= 22) offHours += 1;
    }
    res.json({
      rows,
      summary: {
        total: rows.length, uniqueUsers: Object.keys(users).length, offHours,
        byUser: Object.entries(users).map(([user, count]) => ({ user, count })).sort((a, b) => b.count - a.count),
      },
    });
  } catch (err) { next(err); }
});

/** 2. AUDIT — config change timeline: Configuration-category hardware logs
 *  merged with drift-episode events (detected / resolved), newest first. */
router.get('/config-changes', [daysParam, deviceParam], validate, (req, res, next) => {
  try {
    const d = days(req, 30);
    const devClause = req.query.deviceId ? 'AND dv.id = ?' : '';
    const devArgs = req.query.deviceId ? [req.query.deviceId] : [];
    const logs = db.prepare(`
      SELECT l.created_at AS at, 'Hardware Log' AS source, l.message_id AS ref,
        l.message AS event, l.severity, dv.name AS device_name, o.name AS ome_name
      FROM dell_hardware_logs l
      JOIN dell_ome_instances o ON o.id = l.ome_id
      LEFT JOIN dell_devices dv ON dv.ome_id = l.ome_id AND dv.device_id = l.device_id
      WHERE l.category = 'Configuration' AND l.created_at >= datetime('now', ?) ${devClause}
      ORDER BY l.created_at DESC LIMIT 2500
    `).all(`-${d} days`, ...devArgs);
    const drift = db.prepare(`
      SELECT h.first_seen, h.resolved_at, h.attr_group, h.attribute, h.expected, h.current,
        dv.name AS device_name, o.name AS ome_name
      FROM dell_config_drift_history h
      JOIN dell_ome_instances o ON o.id = h.ome_id
      LEFT JOIN dell_devices dv ON dv.ome_id = h.ome_id AND dv.device_id = h.device_id
      WHERE (h.first_seen >= datetime('now', ?) OR h.resolved_at >= datetime('now', ?)) ${devClause}
      LIMIT 2500
    `).all(`-${d} days`, `-${d} days`, ...devArgs);
    const rows = [...logs];
    for (const h of drift) {
      const label = `${h.attr_group ? `${h.attr_group} > ` : ''}${h.attribute}`;
      if (h.first_seen) rows.push({ at: h.first_seen, source: 'Config Drift', ref: 'detected', severity: 'warning', device_name: h.device_name, ome_name: h.ome_name, event: `${label} drifted — expected "${h.expected ?? ''}", found "${h.current ?? ''}"` });
      if (h.resolved_at) rows.push({ at: h.resolved_at, source: 'Config Drift', ref: 'resolved', severity: 'info', device_name: h.device_name, ome_name: h.ome_name, event: `${label} back in compliance` });
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({ rows: rows.slice(0, 5000) });
  } catch (err) { next(err); }
});

/** 3. AUDIT — remediation tracking: drift episodes with durations, MTTR, and
 *  the attributes drifting on the most devices fleet-wide. */
router.get('/remediation', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT h.attr_group, h.attribute, h.expected, h.current, h.first_seen, h.resolved_at,
        ROUND(julianday(COALESCE(h.resolved_at, datetime('now'))) - julianday(h.first_seen), 1) AS duration_days,
        CASE WHEN h.resolved_at IS NULL THEN 'open' ELSE 'resolved' END AS status,
        dv.name AS device_name, h.service_tag, o.name AS ome_name
      FROM dell_config_drift_history h
      JOIN dell_ome_instances o ON o.id = h.ome_id
      LEFT JOIN dell_devices dv ON dv.ome_id = h.ome_id AND dv.device_id = h.device_id
      ORDER BY h.resolved_at IS NOT NULL, h.first_seen DESC LIMIT 5000
    `).all();
    const resolved = rows.filter((r) => r.status === 'resolved');
    const offenders = db.prepare(`
      SELECT attribute, attr_group, COUNT(DISTINCT device_id) AS devices, COUNT(*) AS episodes
      FROM dell_config_drift_history GROUP BY attr_group, attribute
      ORDER BY devices DESC, episodes DESC LIMIT 15
    `).all();
    res.json({
      rows,
      summary: {
        open: rows.length - resolved.length,
        resolved: resolved.length,
        mttrDays: resolved.length ? Number((resolved.reduce((n, r) => n + (r.duration_days || 0), 0) / resolved.length).toFixed(1)) : null,
        offenders,
      },
    });
  } catch (err) { next(err); }
});

/** 4. AUDIT — job accountability: who ran what on the appliances. */
router.get('/job-accountability', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT j.created_by, j.name, j.job_type, j.last_run_status, j.last_run, j.targets,
        j.state, j.builtin, o.name AS ome_name
      FROM dell_jobs j JOIN dell_ome_instances o ON o.id = j.ome_id
      ORDER BY j.last_run DESC LIMIT 5000
    `).all();
    const byUser = db.prepare(`
      SELECT created_by AS user, COUNT(*) AS jobs,
        SUM(CASE WHEN last_run_status = 'Failed' THEN 1 ELSE 0 END) AS failed
      FROM dell_jobs GROUP BY created_by ORDER BY jobs DESC
    `).all();
    res.json({ rows, summary: { byUser } });
  } catch (err) { next(err); }
});

/** 5. OPS — job health: failure rate by type, stalled schedules, disabled jobs. */
router.get('/job-health', (req, res, next) => {
  try {
    const byType = db.prepare(`
      SELECT job_type, COUNT(*) AS total,
        SUM(CASE WHEN last_run_status = 'Failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN last_run_status = 'Warning' THEN 1 ELSE 0 END) AS warning
      FROM dell_jobs GROUP BY job_type ORDER BY failed DESC, total DESC
    `).all();
    const stalled = db.prepare(`
      SELECT j.name, j.job_type, j.schedule, j.next_run, j.last_run, o.name AS ome_name
      FROM dell_jobs j JOIN dell_ome_instances o ON o.id = j.ome_id
      WHERE j.state = 'Enabled' AND j.schedule IS NOT NULL AND j.schedule != 'startnow'
        AND j.next_run IS NOT NULL AND j.next_run < datetime('now', '-1 hour')
      ORDER BY j.next_run
    `).all();
    const disabled = db.prepare(`
      SELECT j.name, j.job_type, j.last_run, j.last_run_status, o.name AS ome_name
      FROM dell_jobs j JOIN dell_ome_instances o ON o.id = j.ome_id
      WHERE j.state != 'Enabled' ORDER BY j.name
    `).all();
    res.json({ rows: byType, summary: { stalled, disabled } });
  } catch (err) { next(err); }
});

/** 6. OPS — predictive-failure / SSD-wear watchlist. */
router.get('/predictive-watchlist', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT c.name, c.serial, c.slot, c.status, c.size_bytes,
        json_extract(c.extra, '$.mediaType') AS media,
        json_extract(c.extra, '$.predictiveFailure') AS predictive_failure,
        json_extract(c.extra, '$.endurance') AS endurance_pct,
        dv.name AS device_name, dv.service_tag, o.name AS ome_name
      FROM dell_components c
      JOIN dell_ome_instances o ON o.id = c.ome_id
      LEFT JOIN dell_devices dv ON dv.ome_id = c.ome_id AND dv.device_id = c.device_id
      WHERE c.kind = 'disk' AND (
        json_extract(c.extra, '$.predictiveFailure') IS NOT NULL
        OR CAST(json_extract(c.extra, '$.endurance') AS REAL) <= 30
        OR c.status IN ('warning', 'critical'))
      ORDER BY c.status = 'critical' DESC,
        json_extract(c.extra, '$.predictiveFailure') IS NOT NULL DESC,
        CAST(COALESCE(json_extract(c.extra, '$.endurance'), 100) AS REAL)
      LIMIT 2000
    `).all();
    res.json({ rows });
  } catch (err) { next(err); }
});

/** 7. OPS — hardware event trends: noisiest servers, week-over-week movement. */
router.get('/hw-event-trends', [daysParam], validate, (req, res, next) => {
  try {
    const d = days(req, 90);
    // INDEXED BY: left to itself the planner can pick idx_dell_hwlogs_dev_time
    // to satisfy the GROUP BY, which walks the ENTIRE table (millions of rows
    // at fleet scale). Range-scan the day window, then group-sort the result.
    const rows = db.prepare(`
      SELECT dv.name AS device_name, dv.service_tag, dv.model, o.name AS ome_name,
        COUNT(*) AS total,
        SUM(CASE WHEN l.severity IN ('critical', 'fatal') THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN l.severity = 'warning' THEN 1 ELSE 0 END) AS warning,
        SUM(CASE WHEN l.created_at >= datetime('now', '-7 days') AND l.severity IN ('critical', 'fatal', 'warning') THEN 1 ELSE 0 END) AS bad_7d,
        SUM(CASE WHEN l.created_at >= datetime('now', '-14 days') AND l.created_at < datetime('now', '-7 days') AND l.severity IN ('critical', 'fatal', 'warning') THEN 1 ELSE 0 END) AS bad_prev_7d
      FROM dell_hardware_logs l INDEXED BY idx_dell_hwlogs_time
      JOIN dell_ome_instances o ON o.id = l.ome_id
      LEFT JOIN dell_devices dv ON dv.ome_id = l.ome_id AND dv.device_id = l.device_id
      WHERE l.created_at >= datetime('now', ?)
      GROUP BY l.ome_id, l.device_id
      ORDER BY critical DESC, warning DESC, total DESC LIMIT 100
    `).all(`-${d} days`);
    res.json({ rows: rows.map((r) => ({ ...r, trend: r.bad_7d - r.bad_prev_7d })) });
  } catch (err) { next(err); }
});

/** 8. OPS — firmware currency: baseline drift offenders + iDRAC version sprawl. */
router.get('/firmware-currency', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT f.baseline_name, f.service_tag, f.device_model, f.noncompliant_components,
        dv.name AS device_name, o.name AS ome_name
      FROM dell_firmware_compliance f
      JOIN dell_ome_instances o ON o.id = f.ome_id
      LEFT JOIN dell_devices dv ON dv.ome_id = f.ome_id AND (dv.service_tag = f.service_tag OR dv.device_id = f.device_id)
      WHERE f.status = 'noncompliant'
      ORDER BY f.noncompliant_components DESC LIMIT 2000
    `).all();
    // LIKE, not '=': the appliance reports device_type UPPERCASE ("SERVER").
    const sprawl = db.prepare(`
      SELECT firmware_version, COUNT(*) AS devices FROM dell_devices
      WHERE firmware_version IS NOT NULL AND device_type LIKE '%server%'
      GROUP BY firmware_version ORDER BY devices DESC
    `).all();
    res.json({ rows, summary: { sprawl } });
  } catch (err) { next(err); }
});

/** 9. OPS — thermal/power outliers vs same-model peers. */
router.get('/thermal-power', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT d.name AS device_name, d.model, d.inlet_temp_c, d.power_w, o.name AS ome_name,
        m.avg_power AS model_avg_power,
        CASE WHEN m.avg_power > 0 AND d.power_w IS NOT NULL
          THEN ROUND((d.power_w - m.avg_power) / m.avg_power * 100, 0) END AS power_delta_pct
      FROM dell_devices d
      JOIN dell_ome_instances o ON o.id = d.ome_id
      LEFT JOIN (SELECT model, AVG(power_w) AS avg_power FROM dell_devices
                 WHERE power_w IS NOT NULL GROUP BY model) m ON m.model = d.model
      WHERE d.inlet_temp_c IS NOT NULL OR d.power_w IS NOT NULL
      ORDER BY d.inlet_temp_c DESC LIMIT 2000
    `).all();
    res.json({ rows });
  } catch (err) { next(err); }
});

/** 10. OPS — stale management: blind spots (disconnected / stale inventory). */
router.get('/stale-management', [daysParam], validate, (req, res, next) => {
  try {
    const d = days(req, 7);
    const rows = db.prepare(`
      SELECT d.name AS device_name, d.service_tag, d.model, d.device_type,
        d.connection_state, d.last_inventory_time, o.name AS ome_name,
        CASE WHEN d.last_inventory_time IS NOT NULL
          THEN ROUND(julianday('now') - julianday(d.last_inventory_time), 1) END AS inventory_age_days
      FROM dell_devices d JOIN dell_ome_instances o ON o.id = d.ome_id
      WHERE d.connection_state = 0
         OR d.last_inventory_time IS NULL
         OR d.last_inventory_time < datetime('now', ?)
      ORDER BY d.connection_state, inventory_age_days DESC LIMIT 2000
    `).all(`-${d} days`);
    const checked = db.prepare('SELECT COUNT(*) AS n FROM dell_devices').get().n;
    res.json({ rows, summary: { checked } });
  } catch (err) { next(err); }
});

/** 11. OPS — profile hygiene: drifted, failed, or stray profiles. */
router.get('/profile-hygiene', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT p.name, p.template_name, p.target_name, p.state, p.last_run_status,
        p.profile_modified, p.last_deploy_date, o.name AS ome_name,
        CASE WHEN p.profile_modified = 1 THEN 'modified from template'
             WHEN p.last_run_status = 'Failed' THEN 'deploy failed'
             WHEN p.state = 'unassigned' THEN 'unassigned' END AS issue
      FROM dell_config_profiles p JOIN dell_ome_instances o ON o.id = p.ome_id
      WHERE p.profile_modified = 1 OR p.last_run_status = 'Failed' OR p.state = 'unassigned'
      ORDER BY p.profile_modified DESC, p.name LIMIT 2000
    `).all();
    // checked lets the empty state say "all N profiles healthy" — an exception
    // report with zero rows reads as broken otherwise (bit Doug on prod).
    const checked = db.prepare('SELECT COUNT(*) AS n FROM dell_config_profiles').get().n;
    res.json({ rows, summary: { checked } });
  } catch (err) { next(err); }
});

/** 13. SUPPORT — warranty/renewal forecast: expiries by quarter, coverage mix,
 *  and the risk overlap (active hardware faults on near-expiry boxes). */
router.get('/warranty-forecast', (req, res, next) => {
  try {
    // One row per service tag: its BEST contract (renewals win over lapsed base).
    const best = db.prepare(`
      SELECT w.ome_id, w.service_tag, w.device_model, MAX(w.days_remaining) AS days_remaining,
        (SELECT w2.end_date FROM dell_warranties w2 WHERE w2.ome_id = w.ome_id AND w2.service_tag = w.service_tag
          ORDER BY w2.days_remaining DESC LIMIT 1) AS end_date,
        (SELECT w2.service_level FROM dell_warranties w2 WHERE w2.ome_id = w.ome_id AND w2.service_tag = w.service_tag
          ORDER BY w2.days_remaining DESC LIMIT 1) AS service_level
      FROM dell_warranties w GROUP BY w.ome_id, w.service_tag
    `).all();
    const byQuarter = {};
    for (const b of best) {
      if (b.days_remaining == null || b.days_remaining <= 0 || !b.end_date) continue;
      const dt = new Date(b.end_date);
      if (Number.isNaN(dt.getTime())) continue;
      const q = `${dt.getFullYear()} Q${Math.floor(dt.getMonth() / 3) + 1}`;
      byQuarter[q] = (byQuarter[q] || 0) + 1;
    }
    const levelBucket = (s) => {
      const l = String(s || '').toLowerCase();
      if (l.includes('prosupport plus')) return 'ProSupport Plus';
      if (l.includes('prosupport')) return 'ProSupport';
      if (l.includes('basic')) return 'Basic';
      return s ? 'Other' : 'Unknown';
    };
    const byLevel = {};
    for (const b of best) byLevel[levelBucket(b.service_level)] = (byLevel[levelBucket(b.service_level)] || 0) + 1;
    // The money report: active component faults on boxes running out of support.
    const risk = db.prepare(`
      SELECT dv.name AS device_name, dv.service_tag, dv.model, o.name AS ome_name,
        (SELECT MAX(w.days_remaining) FROM dell_warranties w
          WHERE w.ome_id = dv.ome_id AND w.service_tag = dv.service_tag) AS warranty_days_left,
        COUNT(*) AS failing_components,
        GROUP_CONCAT(c.kind || ' ' || COALESCE(c.slot, c.name, ''), '; ') AS failing_detail
      FROM dell_components c
      JOIN dell_devices dv ON dv.ome_id = c.ome_id AND dv.device_id = c.device_id
      JOIN dell_ome_instances o ON o.id = dv.ome_id
      WHERE c.status IN ('critical', 'warning')
      GROUP BY c.ome_id, c.device_id
      HAVING warranty_days_left IS NOT NULL AND warranty_days_left <= 90
      ORDER BY warranty_days_left LIMIT 500
    `).all();
    res.json({
      rows: risk,
      summary: {
        contracts: db.prepare('SELECT COUNT(*) AS n FROM dell_warranties').get().n,
        tags: best.length,
        expired: best.filter((b) => b.days_remaining != null && b.days_remaining <= 0).length,
        byQuarter: Object.entries(byQuarter).sort(([a], [b]) => a.localeCompare(b)).map(([quarter, count]) => ({ quarter, count })),
        byLevel: Object.entries(byLevel).map(([level, count]) => ({ level, count })).sort((a, b) => b.count - a.count),
      },
    });
  } catch (err) { next(err); }
});

/** 14. SUPPORT — refresh planning: ranked candidates by age, support runway,
 *  and failing-part density. Warranty start date stands in for ship date. */
router.get('/refresh-planning', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT d.name AS device_name, d.service_tag, d.model, o.name AS ome_name,
        (SELECT MIN(w.start_date) FROM dell_warranties w
          WHERE w.ome_id = d.ome_id AND w.service_tag = d.service_tag) AS ship_date,
        (SELECT MAX(w.days_remaining) FROM dell_warranties w
          WHERE w.ome_id = d.ome_id AND w.service_tag = d.service_tag) AS warranty_days_left,
        (SELECT COUNT(*) FROM dell_components c
          WHERE c.ome_id = d.ome_id AND c.device_id = d.device_id
            AND c.status IN ('critical', 'warning')) AS failing_components,
        (SELECT COUNT(*) FROM dell_firmware_compliance f
          WHERE f.ome_id = d.ome_id AND (f.service_tag = d.service_tag OR f.device_id = d.device_id)
            AND f.status = 'noncompliant') AS fw_noncompliant
      FROM dell_devices d JOIN dell_ome_instances o ON o.id = d.ome_id
      WHERE d.device_type LIKE '%server%'
    `).all().map((r) => {
      const ageYears = r.ship_date ? Number(((Date.now() - new Date(r.ship_date).getTime()) / (365.25 * 864e5)).toFixed(1)) : null;
      // Simple transparent score: age + expired support + failing parts weigh a
      // box toward refresh. Not a prediction — a sort key Doug can sanity-check.
      const score = (ageYears || 0) * 10
        + (r.warranty_days_left != null && r.warranty_days_left <= 0 ? 40 : r.warranty_days_left != null && r.warranty_days_left <= 90 ? 20 : 0)
        + (r.failing_components || 0) * 15 + (r.fw_noncompliant ? 5 : 0);
      return { ...r, age_years: ageYears, refresh_score: Math.round(score) };
    }).sort((a, b) => b.refresh_score - a.refresh_score).slice(0, 500);
    res.json({ rows });
  } catch (err) { next(err); }
});

/** 15. SUPPORT — per-server audit timeline: alerts + hardware logs + drift
 *  episodes (+ jobs that name the device) merged chronologically. */
router.get('/server-timeline', [query('deviceId').isInt().toInt(), daysParam], validate, (req, res, next) => {
  try {
    const d = days(req, 90);
    const dev = db.prepare(`
      SELECT d.*, o.name AS ome_name FROM dell_devices d
      JOIN dell_ome_instances o ON o.id = d.ome_id WHERE d.id = ?
    `).get(req.query.deviceId);
    if (!dev) return res.status(404).json({ error: 'Device not found.' });
    const rows = [];
    for (const a of db.prepare(`
      SELECT created_at, severity, category, message FROM dell_alerts
      WHERE ome_id = ? AND (service_tag = ? OR device_name = ?) AND created_at >= datetime('now', ?)
    `).all(dev.ome_id, dev.service_tag, dev.name, `-${d} days`)) {
      rows.push({ at: a.created_at, source: 'Alert', severity: a.severity, ref: a.category, event: a.message });
    }
    for (const l of db.prepare(`
      SELECT created_at, severity, category, message_id, message FROM dell_hardware_logs
      WHERE ome_id = ? AND device_id = ? AND created_at >= datetime('now', ?)
    `).all(dev.ome_id, dev.device_id, `-${d} days`)) {
      rows.push({ at: l.created_at, source: 'Hardware Log', severity: l.severity, ref: `${l.category || ''} ${l.message_id || ''}`.trim(), event: l.message });
    }
    for (const h of db.prepare(`
      SELECT first_seen, resolved_at, attr_group, attribute, expected, current
      FROM dell_config_drift_history WHERE ome_id = ? AND device_id = ?
        AND (first_seen >= datetime('now', ?) OR resolved_at >= datetime('now', ?))
    `).all(dev.ome_id, dev.device_id, `-${d} days`, `-${d} days`)) {
      const label = `${h.attr_group ? `${h.attr_group} > ` : ''}${h.attribute}`;
      if (h.first_seen) rows.push({ at: h.first_seen, source: 'Config Drift', severity: 'warning', ref: 'detected', event: `${label} drifted — expected "${h.expected ?? ''}", found "${h.current ?? ''}"` });
      if (h.resolved_at) rows.push({ at: h.resolved_at, source: 'Config Drift', severity: 'info', ref: 'resolved', event: `${label} back in compliance` });
    }
    // Jobs rarely target one device by name, but when they do it's worth showing.
    for (const j of db.prepare(`
      SELECT name, job_type, last_run, last_run_status FROM dell_jobs
      WHERE ome_id = ? AND targets IS NOT NULL AND (targets LIKE ? OR targets LIKE ?)
        AND last_run >= datetime('now', ?)
    `).all(dev.ome_id, `%${dev.name}%`, `%${dev.service_tag}%`, `-${d} days`)) {
      rows.push({ at: j.last_run, source: 'Job', severity: j.last_run_status === 'Failed' ? 'critical' : 'info', ref: j.job_type, event: `${j.name} — ${j.last_run_status}` });
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({ device: { name: dev.name, serviceTag: dev.service_tag, model: dev.model, omeName: dev.ome_name }, rows: rows.slice(0, 5000) });
  } catch (err) { next(err); }
});

/** 12. SUPPORT — support case packet: everything Dell support asks for about
 *  one server, as a downloadable text file. */
router.get('/support-packet', [query('deviceId').isInt().toInt()], validate, (req, res, next) => {
  try {
    const dev = db.prepare(`
      SELECT d.*, o.name AS ome_name FROM dell_devices d
      JOIN dell_ome_instances o ON o.id = d.ome_id WHERE d.id = ?
    `).get(req.query.deviceId);
    if (!dev) return res.status(404).json({ error: 'Device not found.' });
    const comps = db.prepare('SELECT * FROM dell_components WHERE ome_id = ? AND device_id = ? ORDER BY kind, slot').all(dev.ome_id, dev.device_id);
    const warranty = db.prepare('SELECT * FROM dell_warranties WHERE ome_id = ? AND service_tag = ? ORDER BY days_remaining DESC').all(dev.ome_id, dev.service_tag);
    const firmware = db.prepare("SELECT * FROM dell_firmware_compliance WHERE ome_id = ? AND (service_tag = ? OR device_id = ?)").all(dev.ome_id, dev.service_tag, dev.device_id);
    const alerts = db.prepare(`
      SELECT * FROM dell_alerts WHERE ome_id = ? AND (service_tag = ? OR device_name = ?)
        AND created_at >= datetime('now', '-30 days') ORDER BY created_at DESC LIMIT 200
    `).all(dev.ome_id, dev.service_tag, dev.name);
    const hwlogs = db.prepare(`
      SELECT * FROM dell_hardware_logs WHERE ome_id = ? AND device_id = ?
        AND created_at >= datetime('now', '-30 days') ORDER BY created_at DESC LIMIT 300
    `).all(dev.ome_id, dev.device_id);
    const drift = db.prepare('SELECT * FROM dell_config_drift_history WHERE ome_id = ? AND device_id = ? AND resolved_at IS NULL').all(dev.ome_id, dev.device_id);

    const gb = (b) => (b != null ? `${Math.round(b / 1024 ** 3)} GB` : '');
    const x = (v) => (v == null || v === '' ? '-' : String(v));
    const L = [];
    L.push('DELL SUPPORT CASE PACKET', '='.repeat(60));
    L.push(`Generated:      ${new Date().toISOString()}`);
    L.push(`OME Instance:   ${dev.ome_name}`);
    L.push('');
    L.push('IDENTITY', '-'.repeat(60));
    L.push(`Device Name:    ${x(dev.name)}`);
    L.push(`Service Tag:    ${x(dev.service_tag)}`);
    L.push(`Model:          ${x(dev.model)}`);
    L.push(`Asset Tag:      ${x(dev.asset_tag)}`);
    L.push(`IP Address:     ${x(dev.ip_address)}`);
    L.push(`iDRAC Firmware: ${x(dev.firmware_version)}`);
    L.push(`Health:         ${x(dev.health)}   Power: ${x(dev.power_state)}   Connected: ${dev.connection_state === 0 ? 'NO' : 'yes'}`);
    L.push(`Last Inventory: ${x(dev.last_inventory_time)}`);
    L.push('');
    L.push('SUPPORT CONTRACTS', '-'.repeat(60));
    if (!warranty.length) L.push('(none on record)');
    for (const w of warranty) L.push(`${x(w.service_level)} | ${x(w.start_date).slice(0, 10)} -> ${x(w.end_date).slice(0, 10)} | ${w.days_remaining != null ? `${w.days_remaining} days remaining` : '-'}`);
    L.push('');
    L.push('HARDWARE INVENTORY (with serials)', '-'.repeat(60));
    for (const kind of ['processor', 'memory', 'raid', 'vdisk', 'disk', 'nic', 'fc', 'psu', 'os']) {
      const rows = comps.filter((c) => c.kind === kind);
      if (!rows.length) continue;
      L.push(`[${kind.toUpperCase()}]`);
      for (const c of rows) {
        const extra = [];
        if (c.size_bytes) extra.push(gb(c.size_bytes));
        if (c.speed) extra.push(c.speed);
        if (c.status && c.status !== 'ok') extra.push(`STATUS: ${String(c.status).toUpperCase()}`);
        L.push(`  ${x(c.slot)} | ${x(c.name)} | SN ${x(c.serial)}${extra.length ? ` | ${extra.join(' | ')}` : ''}`);
      }
    }
    L.push('');
    L.push('FIRMWARE BASELINE COMPLIANCE', '-'.repeat(60));
    if (!firmware.length) L.push('(not in any firmware baseline)');
    for (const f of firmware) L.push(`${x(f.baseline_name)}: ${x(f.status)}${f.noncompliant_components ? ` (${f.noncompliant_components} component(s) behind)` : ''}`);
    L.push('');
    L.push('OPEN CONFIG DRIFT', '-'.repeat(60));
    if (!drift.length) L.push('(none)');
    for (const h of drift) L.push(`${x(h.attr_group)} > ${x(h.attribute)} | expected "${x(h.expected)}" found "${x(h.current)}" | detected ${x(h.first_seen)}`);
    L.push('');
    L.push(`ALERTS (last 30 days, ${alerts.length})`, '-'.repeat(60));
    for (const a of alerts) L.push(`${x(a.created_at)} [${x(a.severity)}] ${x(a.message_id)} ${x(a.message)}`);
    if (!alerts.length) L.push('(none)');
    L.push('');
    L.push(`HARDWARE LOG (last 30 days, ${hwlogs.length})`, '-'.repeat(60));
    for (const l of hwlogs) L.push(`${x(l.created_at)} [${x(l.severity)}] ${x(l.message_id)} ${x(l.message)}`);
    if (!hwlogs.length) L.push('(none)');
    L.push('');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="support-packet-${dev.service_tag || dev.id}-${new Date().toISOString().slice(0, 10)}.txt"`);
    res.send(L.join('\r\n'));
  } catch (err) { next(err); }
});

module.exports = router;
