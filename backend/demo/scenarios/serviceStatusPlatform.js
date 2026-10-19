// Service Status in platform mode (Doug, 2026-10-19) states whether ICC can
// reach and poll each platform's sources. The demo has no poller process, so
// poller_status would stay empty (every platform "No data") and then age past
// the stale window. This scenario:
//   - refreshDemoPollerStatus: stamps a successful poll "now" on every seeded
//     source of every platform, except one source that stays errored so the
//     board shows one degraded platform. Called at demo boot and every few
//     minutes by server.js (poller_status is live state, not seeded content).
//   - seedServiceStatusHistory: called by seedDemo only. Writes a 30 day
//     timeline in the platform vocabulary (two short, cleared reachability
//     incidents in the past and the ongoing degraded one) with matching
//     cleared poll: events so past-day dots open to something.
// Re-runnable: both functions only touch their own rows (the history rows are
// cleared with the other seeded tables by seedDemo's wipe).
const SOURCE_TABLES = {
  cohesity: 'clusters', pure: 'pure_arrays', netapp: 'netapp_arrays',
  vcenter: 'vcenter_vcenters', dell: 'dell_ome_instances', aria: 'aria_instances',
  ariaops: 'ariaops_instances', aws: 'aws_accounts', unifi: 'unifi_sources',
  brocade: 'brocade_sources', bluecat: 'bluecat_sources', eon: 'eon_sources',
  logicmonitor: 'lm_sources',
};
// Platforms with a single global poll target (entity 0, no source table).
const GLOBAL_TARGETS = ['zerto', 'netbackup', 'proxmox'];
// Which platform carries the ongoing unreachable source, first one with two or more sources.
const DEGRADED_ORDER = ['vcenter', 'dell', 'netapp', 'pure', 'brocade', 'cohesity'];
const BLIP_ORDER = ['dell', 'netapp', 'pure', 'brocade', 'cohesity', 'vcenter'];

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function sourcesOf(db) {
  const out = [];
  for (const [platform, table] of Object.entries(SOURCE_TABLES)) {
    if (!hasTable(db, table)) continue;
    const rows = db.prepare(`SELECT id, name FROM ${table} ORDER BY id`).all();
    if (rows.length) out.push({ platform, rows: rows.map((r) => ({ id: r.id, name: r.name || platform })) });
  }
  for (const platform of GLOBAL_TARGETS) out.push({ platform, rows: [{ id: 0, name: platform }] });
  return out;
}

function pickStory(list) {
  const degraded = DEGRADED_ORDER.map((p) => list.find((s) => s.platform === p && s.rows.length >= 2)).find(Boolean) || null;
  const blip = BLIP_ORDER.map((p) => list.find((s) => s.platform === p && s.rows.length >= 1 && s !== degraded)).find(Boolean) || null;
  return { degraded, blip };
}

function refreshDemoPollerStatus(db, { now = Date.now() } = {}) {
  const list = sourcesOf(db);
  const { degraded } = pickStory(list);
  const iso = new Date(now).toISOString();
  const start = new Date(now - 4000).toISOString();
  const up = db.prepare(`
    INSERT INTO poller_status (type, entity_id, last_poll_start, last_poll_end, last_poll_status, is_syncing)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(type, entity_id) DO UPDATE SET
      last_poll_start = excluded.last_poll_start, last_poll_end = excluded.last_poll_end,
      last_poll_status = excluded.last_poll_status, is_syncing = 0
  `);
  let sources = 0;
  db.transaction(() => {
    for (const { platform, rows } of list) {
      rows.forEach((r, i) => {
        const broken = degraded && degraded.platform === platform && i === rows.length - 1;
        up.run(platform, r.id, start, iso, broken ? 'error' : 'success');
        sources += 1;
      });
    }
  })();
  return { sources, degradedPlatform: degraded ? degraded.platform : null };
}

function seedServiceStatusHistory(db, { now = Date.now() } = {}) {
  const list = sourcesOf(db);
  const { degraded, blip } = pickStory(list);
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  const H = 3600000;
  const D = 24 * H;
  const insTimeline = db.prepare('INSERT INTO service_status_timeline (platform, state, at, reason, event_ids_json) VALUES (?, ?, ?, ?, ?)');
  const insEvent = db.prepare(`
    INSERT INTO service_alert_events
      (platform, source_key, severity, host, message, first_seen, detected_at, last_seen_at, cleared_at, analysis_status)
    VALUES (?, ?, 'critical', ?, ?, ?, ?, ?, ?, 'disabled')
  `);
  const plural = (n) => `${n} source${n === 1 ? '' : 's'}`;
  let rows = 0;
  let events = 0;

  db.transaction(() => {
    for (const { platform, rows: src } of list) {
      const n = src.length;
      insTimeline.run(platform, 'ok', at(30 * D), `ICC reaches all ${plural(n)}`, '[]');
      rows += 1;
      const episodes = [];
      if (blip && blip.platform === platform) episodes.push({ startAgo: 15 * D, durationH: 2, source: src[0] });
      if (degraded && degraded.platform === platform) {
        episodes.push({ startAgo: 9 * D, durationH: 5, source: src[0] });
        episodes.push({ startAgo: 3 * H, durationH: null, source: src[src.length - 1] });
      }
      for (const ep of episodes) {
        const startIso = at(ep.startAgo);
        const endIso = ep.durationH ? new Date(Date.parse(startIso) + ep.durationH * H).toISOString() : null;
        const state = n === 1 ? 'offline' : 'degraded';
        const reason = n === 1 ? 'source unreachable' : `1 of ${n} sources unreachable`;
        insEvent.run(
          platform, `poll:${ep.source.id}`, ep.source.name,
          `ICC could not reach this source on its last poll (${startIso})`, startIso, startIso, endIso || startIso, endIso
        );
        events += 1;
        insTimeline.run(platform, state, startIso, reason, '[]');
        rows += 1;
        if (endIso) {
          insTimeline.run(platform, 'ok', endIso, `ICC reaches all ${plural(n)}`, '[]');
          rows += 1;
        }
      }
    }
  })();
  return { timelineRows: rows, events, degradedPlatform: degraded ? degraded.platform : null, blipPlatform: blip ? blip.platform : null };
}

module.exports = { refreshDemoPollerStatus, seedServiceStatusHistory };
