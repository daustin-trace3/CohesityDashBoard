// Ops Agent cross-platform helpers: the dated timeline around an incident and
// the open alerts other platforms hold for the same object. Both read tables
// ICC already has; every source is guarded, because a platform's tables may be
// absent on a branch, a pack-served install, or a tenant that never enabled it.
const db = require('../db/database');
const logger = require('../utils/logger');

const WINDOW_BEFORE_MS = 60 * 60000;
const TIMELINE_CAP = 20;
const TEXT_CAP = 160;
const RELATED_WINDOW_MS = 24 * 3600000;
const RELATED_CAP = 10;

function all(dbh, sql, ...args) {
  try { return dbh.prepare(sql).all(...args); } catch { return []; }
}

/** ms epoch from an ISO string, a zoneless SQLite stamp (read as UTC) or a number. */
function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return v > 1e14 ? Math.round(v / 1000) : v > 1e11 ? v : v * 1000;
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseTs(Number(s));
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Same candidate rule Service Status uses: raw, before " (", inside trailing
 *  parentheses, each also domain-stripped. */
function hostCandidates(host) {
  const raw = String(host || '').trim();
  if (!raw) return [];
  const out = new Set();
  const beforeParen = raw.split(' (')[0].trim();
  const parenMatch = raw.match(/\(([^)]*)\)\s*$/);
  const inParen = parenMatch ? parenMatch[1].trim() : '';
  for (const c of [raw, beforeParen, inParen]) {
    if (!c) continue;
    out.add(c.toLowerCase());
    const stripped = c.split('.')[0].trim();
    if (stripped) out.add(stripped.toLowerCase());
  }
  out.delete('');
  return [...out];
}

const clip = (s, n = TEXT_CAP) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

// ---------------------------------------------------------------------------
// Open alerts on other platforms for the same object
// ---------------------------------------------------------------------------

/**
 * Open alerts the agent holds on OTHER platforms (other incidents) whose host
 * is this host, by name candidates or by the identity index, first seen within
 * 24 h either side of anchorMs. Shape { platform, severity, host, message,
 * firstSeen, incidentId }, newest first, capped at 10.
 */
function relatedOtherPlatformEvents({ incidentId, platform, host, anchorMs }, dbh = db) {
  try {
    const cands = new Set(hostCandidates(host));
    if (!cands.size) return [];
    const rows = all(dbh, `
      SELECT a.incident_id, a.platform, a.severity, a.host, a.message, a.first_seen, a.attached_at
      FROM ops_incident_alerts a JOIN ops_incidents i ON i.id = a.incident_id
      WHERE a.cleared_at IS NULL AND i.state != 'resolved' AND a.incident_id != ? AND a.platform != ? AND a.host IS NOT NULL
      ORDER BY a.rowid DESC LIMIT 1500`, incidentId, platform);
    if (!rows.length) return [];
    let hi = null;
    let idx = null;
    let mine = null;
    try {
      hi = require('./hostIdentity');
      idx = hi.buildIdentityIndex(dbh);
      mine = hi.resolveToken(idx, String(host).split(' (')[0]);
    } catch { idx = null; }
    const aka = (x, y) => (x.alsoKnownAs || []).some((a) => a.platform === y.platform && a.refKey === y.refKey);
    const sameObject = (otherHost) => {
      if (!mine || !idx || !hi) return false;
      try {
        const r = hi.resolveToken(idx, String(otherHost).split(' (')[0]);
        if (!r) return false;
        if (r === mine || (r.platform === mine.platform && r.refKey === mine.refKey)) return true;
        return aka(mine, r) || aka(r, mine);
      } catch { return false; }
    };
    const out = [];
    for (const r of rows) {
      const at = parseTs(r.first_seen) || parseTs(r.attached_at);
      if (anchorMs && at != null && Math.abs(at - anchorMs) > RELATED_WINDOW_MS) continue;
      const rc = hostCandidates(r.host);
      if (!(rc.some((c) => cands.has(c)) || sameObject(r.host))) continue;
      out.push({
        platform: r.platform, severity: r.severity, host: r.host, message: clip(r.message, 300),
        firstSeen: at != null ? new Date(at).toISOString() : null, incidentId: r.incident_id, _at: at || 0,
      });
    }
    out.sort((a, b) => b._at - a._at);
    return out.slice(0, RELATED_CAP).map(({ _at, ...rest }) => rest);
  } catch (err) {
    logger.warn(`[OpsAgent] related platform events skipped: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * evidence.timeline: up to 20 { at (ISO), platform, text (<= 160) }, newest
 * first, from [first alert - 60 min, now] around the incident's hosts and site.
 * Never throws; a failing source contributes nothing.
 */
function buildTimeline(inc, alerts, evidence, { dbh = db, now = Date.now() } = {}) {
  const items = [];
  try {
    const list = Array.isArray(alerts) ? alerts : [];
    const firstMs = list.map((a) => parseTs(a.first_seen)).filter((x) => x != null).sort((a, b) => a - b)[0]
      ?? parseTs(inc && inc.opened_at) ?? now;
    const start = firstMs - WINDOW_BEFORE_MS;
    const inWindow = (ms) => ms != null && ms >= start && ms <= now + 60000;
    const add = (ms, platform, text) => {
      if (!inWindow(ms)) return;
      items.push({ at: new Date(ms).toISOString(), platform, text: clip(text) });
    };

    // Who and where.
    const hostSet = new Set();
    const checkNames = new Set();
    const locations = new Set();
    for (const a of list) {
      if (!a.host) continue;
      const h = String(a.host);
      const at = h.indexOf(' @ ');
      if (at > 0) { checkNames.add(h.slice(0, at).trim().toLowerCase()); locations.add(h.slice(at + 3).trim().toLowerCase()); continue; }
      for (const c of hostCandidates(h)) hostSet.add(c);
    }
    const key = String((inc && inc.incident_key) || '');
    const siteKeys = new Set();
    if (key.startsWith('site:')) siteKeys.add(key.slice(5).toLowerCase());
    if (hostSet.size) {
      const ph = [...hostSet].map(() => '?').join(',');
      for (const r of all(dbh, `SELECT DISTINCT site_key FROM lm_devices WHERE site_key IS NOT NULL AND stale = 0
        AND (lower(display_name) IN (${ph}) OR lower(name) IN (${ph}) OR lower(sysname) IN (${ph}))`, ...hostSet, ...hostSet, ...hostSet)) {
        if (r.site_key) siteKeys.add(String(r.site_key).toLowerCase());
      }
    }

    // 1. LogicMonitor circuit events at the site.
    if (siteKeys.size) {
      const ph = [...siteKeys].map(() => '?').join(',');
      let n = 0;
      for (const r of all(dbh, `SELECT device_name, port, site_key, role, event, at FROM lm_circuit_events
        WHERE lower(site_key) IN (${ph}) ORDER BY at DESC LIMIT 200`, ...siteKeys)) {
        const ms = parseTs(r.at);
        if (!inWindow(ms) || n >= 5) continue;
        n += 1;
        add(ms, 'logicmonitor', `Circuit ${r.event}: ${[r.device_name, r.port].filter(Boolean).join(' ')}${r.role ? ` (${r.role})` : ''} at site ${r.site_key}`);
      }
    }

    // 2. Latency episodes for the incident's checks, probe locations or site.
    const keyLoc = key.startsWith('lm-location:') ? key.slice('lm-location:'.length) : '';
    if (checkNames.size || locations.size || siteKeys.size || keyLoc) {
      let n = 0;
      for (const r of all(dbh, `SELECT subject_label, site_key, kind, state, opened_at, promoted_at, peak_ms
        FROM lm_latency_episodes ORDER BY opened_at DESC LIMIT 400`)) {
        if (n >= 6) break;
        const label = String(r.subject_label || '').toLowerCase();
        const [chk, loc = ''] = label.split(' @ ');
        const slugLoc = loc.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const hit = checkNames.has(chk.trim()) || (loc && locations.has(loc.trim()))
          || (r.site_key && siteKeys.has(String(r.site_key).toLowerCase()))
          || (keyLoc && slugLoc === keyLoc);
        if (!hit) continue;
        const peak = r.peak_ms != null ? `, peak ${Math.round(r.peak_ms)} ms` : '';
        const what = r.kind === 'loss' ? 'Packet loss' : 'Latency';
        const o = parseTs(r.opened_at);
        const p = parseTs(r.promoted_at);
        if (inWindow(o)) { add(o, 'logicmonitor', `${what} episode opened: ${r.subject_label}${peak}`); n += 1; }
        if (inWindow(p)) { add(p, 'logicmonitor', `${what} episode promoted to ${r.state}: ${r.subject_label}${peak}`); n += 1; }
      }
    }

    // 3. Interfaces currently down on the incident's devices: when the down streak began.
    if (hostSet.size) {
      const ph = [...hostSet].map(() => '?').join(',');
      const down = all(dbh, `SELECT d.display_name AS device, i.source_id, i.instance_id, i.display_name AS ifname
        FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
        WHERE i.stale = 0 AND i.status = 2
          AND (lower(d.display_name) IN (${ph}) OR lower(d.name) IN (${ph}) OR lower(d.sysname) IN (${ph}))
        LIMIT 40`, ...hostSet, ...hostSet, ...hostSet);
      let n = 0;
      for (const r of down) {
        if (n >= 6) break;
        const rows = all(dbh, 'SELECT status, captured_at FROM lm_interface_history WHERE source_id = ? AND instance_id = ? ORDER BY captured_at DESC, id DESC LIMIT 400', r.source_id, r.instance_id);
        let since = null;
        for (const h of rows) { if (h.status === 2) since = h.captured_at; else break; }
        const ms = parseTs(since);
        if (!inWindow(ms)) continue;
        n += 1;
        add(ms, 'logicmonitor', `Interface down: ${r.device} ${r.ifname || ''}`);
      }
    }

    // 4. Configuration changes for the hosts, any platform.
    try {
      const ledger = require('./configLedger');
      const names = [...new Set(list.filter((a) => a.host && !String(a.host).includes(' @ ')).map((a) => String(a.host).split(' (')[0].split('.')[0]))].slice(0, 3);
      let n = 0;
      for (const h of names) {
        for (const c of ledger.listChanges({ days: 1, q: h, limit: 20 })) {
          const ms = parseTs(c.detected_at);
          if (!inWindow(ms) || n >= 5) continue;
          n += 1;
          add(ms, c.platform || 'config', `Config ${c.change_type}: ${c.system || ''} ${c.item || ''}`.trim());
        }
      }
    } catch { /* ledger absent */ }

    // 5. vCenter events about the hosts.
    if (hostSet.size) {
      const ph = [...hostSet].map(() => '?').join(',');
      let n = 0;
      for (const r of all(dbh, `SELECT event_type, message, entity_name, created_at FROM vcenter_events
        WHERE lower(entity_name) IN (${ph}) ORDER BY created_at DESC LIMIT 60`, ...hostSet)) {
        const ms = parseTs(r.created_at);
        if (!inWindow(ms) || n >= 5) continue;
        n += 1;
        add(ms, 'vcenter', `${r.event_type || 'Event'} on ${r.entity_name}: ${r.message || ''}`);
      }
    }

    // 6. Failed backup runs already gathered for the incident.
    {
      let n = 0;
      for (const j of (evidence && evidence.failedBackupJobs) || []) {
        const ms = parseTs(j.finished) ?? parseTs(j.started);
        if (!inWindow(ms) || n >= 5) continue;
        n += 1;
        add(ms, j.platform || 'backup', `Backup job failed: ${[j.job, j.source].filter(Boolean).join(' on ')}${j.error ? `: ${j.error}` : ''}`);
      }
    }

    // 7. The incident's own alerts, earliest first, so the model sees onset order.
    {
      const own = list.map((a) => ({ a, ms: parseTs(a.first_seen) })).filter((x) => x.ms != null).sort((x, y) => x.ms - y.ms).slice(0, 5);
      for (const { a, ms } of own) add(ms, a.platform, `Alert (${a.severity}) ${a.host ? `${a.host}: ` : ''}${a.message || ''}`);
    }
  } catch (err) {
    logger.warn(`[OpsAgent] timeline skipped: ${err.message}`);
  }
  const seen = new Set();
  return items
    .filter((x) => { const k = `${x.at}|${x.platform}|${x.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, TIMELINE_CAP);
}

module.exports = { buildTimeline, relatedOtherPlatformEvents, hostCandidates, parseTs, TIMELINE_CAP, WINDOW_BEFORE_MS };
