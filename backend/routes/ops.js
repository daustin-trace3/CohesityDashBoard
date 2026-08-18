const express = require('express');
const db = require('../db/database');
const registry = require('../core/registry');

const router = express.Router();

// Cross-platform ops summary powering the Ops Monitor landing page. Every
// platform summarizer is independently fault-isolated: a broken table or
// query degrades that one card to health 'unknown' instead of failing the
// whole page.

const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const num = (v) => Number(v) || 0;
const count = (sql, ...args) => num(one(sql, ...args)?.c);
// Optional count — table may not exist on older DBs.
const countSafe = (sql, ...args) => { try { return count(sql, ...args); } catch { return 0; } };

const FAILED_RUN_STATUSES = "('kFailure','kFailed','kError','kCanceled','kCancelled')";

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

const fnum = (v) => Number(v).toLocaleString('en-US');
const exception = (severity, cnt, text, link) => ({ severity, count: cnt, text, link });

function cohesitySummary() {
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

const PLATFORMS = [
  { id: 'cohesity', label: 'Cohesity', color: '#6CB33F', route: '/cohesity', fn: cohesitySummary },
];

const SEV_RANK = { critical: 0, warning: 1, info: 2 };

// Zero objects with nothing wrong means no source is connected yet — report
// 'unknown' (NO DATA) rather than a hollow green. Shared by the built-in
// PLATFORMS loop and the plugin-contributed opsSummary loop below.
function healthOf(s) {
  return s.exceptions.some((e) => e.severity === 'critical') ? 'critical'
    : s.exceptions.some((e) => e.severity === 'warning') ? 'warning'
    : num(s.objects) === 0 ? 'unknown' : 'ok';
}

router.get('/summary', async (req, res) => {
  const cards = [];
  for (const p of PLATFORMS) {
    // Cohesity is always-on (enabled iff clusters exist — its summarizer
    // returns null when there are none); registry drives the rest.
    if (p.id !== 'cohesity' && registry.getPlugin(p.id)?.enabled !== true) continue;
    const base = { id: p.id, label: p.label, color: p.color, route: p.route };
    try {
      const s = await p.fn();
      if (!s) continue;
      cards.push({ ...base, ...s, health: healthOf(s) });
    } catch (err) {
      cards.push({ ...base, health: 'unknown', objects: 0, headline: [], exceptions: [], spark: null, error: true });
    }
  }

  // Plugin-contributed cards (Phase 1 manifest-driven core hooks): any
  // enabled plugin declaring opsSummary, that isn't already a built-in above.
  const builtinIds = new Set(PLATFORMS.map((p) => p.id));
  for (const provider of registry.getOpsSummaryProviders()) {
    if (builtinIds.has(provider.id)) continue;
    const base = { id: provider.id, label: provider.name, color: provider.color, route: `/${provider.id}` };
    try {
      const s = await provider.run();
      if (!s) continue;
      cards.push({ ...base, ...s, health: healthOf(s) });
    } catch (err) {
      cards.push({ ...base, health: 'unknown', objects: 0, headline: [], exceptions: [], spark: null, error: true });
    }
  }
  const attention = cards
    .flatMap((c) => c.exceptions.map((e) => ({ ...e, platformId: c.id, platform: c.label, color: c.color })))
    .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || b.count - a.count)
    .slice(0, 10);
  const totals = {
    platforms: cards.length,
    objects: cards.reduce((s, c) => s + num(c.objects), 0),
    critical: cards.flatMap((c) => c.exceptions).filter((e) => e.severity === 'critical').reduce((s, e) => s + num(e.count), 0),
    warning: cards.flatMap((c) => c.exceptions).filter((e) => e.severity === 'warning').reduce((s, e) => s + num(e.count), 0),
  };
  res.json({ generatedAt: new Date().toISOString(), platforms: cards, attention, totals });
});

module.exports = router;
