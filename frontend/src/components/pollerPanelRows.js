// Pure helpers for the poller status panel: flatten GET /poller/status into
// one row per source for the platform being viewed (or every platform on Ops
// pages), classify each with the same precedence the header chip uses
// (syncing, delayed, error, stale, live) and sort worst first.

export const STATE_RANK = { error: 0, delayed: 1, stale: 2, syncing: 3, live: 4 };

// Account-global sections have no source rows. Only Zerto has an on-demand
// poll ICC can trigger for them (its global task ignores the source id).
const GLOBAL_LABELS = { licensing: 'Licensing', views: 'Views', pure: 'Pure1', zerto: 'Zerto' };
const GLOBAL_POLLABLE = new Set(['zerto']);

export function rowState(r, now = Date.now()) {
  if (r.isSyncing) return 'syncing';
  if (r.backoffUntil && new Date(r.backoffUntil).getTime() > now) return 'delayed';
  if (r.lastPollStatus === 'error') return 'error';
  if (r.isStale) return 'stale';
  return 'live';
}

function entityRow(platform, e, now) {
  return {
    key: `${platform}:${e.id}`,
    platform,
    id: e.id,
    name: e.name || `Source ${e.id}`,
    state: rowState(e, now),
    ageMinutes: e.ageMinutes ?? null,
    staleAfterMinutes: e.staleAfterMinutes ?? null,
    lastPollEnd: e.lastPollEnd || null,
    lastPollStatus: e.lastPollStatus || null,
    backoffUntil: e.backoffUntil || null,
    // A cleared failure leaves its old text in the source table; only a source
    // whose last poll failed shows it.
    error: e.lastPollStatus === 'error' ? (e.lastPollError || null) : null,
    pollable: true,
  };
}

function globalRow(platform, section, p, now) {
  const failed = (p.failedSources || []).map((s) => s.name || String(s));
  const base = {
    isSyncing: p.isSyncing,
    isStale: p.isStale,
    lastPollStatus: failed.length ? 'error' : null,
  };
  return {
    key: `${platform}:${section}`,
    platform,
    id: GLOBAL_POLLABLE.has(section) ? 0 : null,
    name: GLOBAL_LABELS[section] || section,
    state: rowState(base, now),
    ageMinutes: p.ageMinutes ?? null,
    staleAfterMinutes: p.staleAfterMinutes ?? null,
    lastPollEnd: p.lastRefreshEnd || null,
    lastPollStatus: base.lastPollStatus,
    backoffUntil: null,
    error: failed.length ? `Failed: ${failed.join(', ')}` : null,
    pollable: GLOBAL_POLLABLE.has(section),
  };
}

function sectionRows(platform, p, now) {
  if (!p || p.enabled === false) return [];
  if (Array.isArray(p.entities)) return p.entities.map((e) => entityRow(platform, e, now));
  if (p.lastDataCapture || p.failedSources?.length) return [globalRow(platform, platform, p, now)];
  return [];
}

/** scope: a platform id, or 'all' (Ops pages). Returns rows sorted worst first. */
export function buildSourceRows(status, scope, now = Date.now()) {
  if (!status) return [];
  const rows = [];
  if (scope === 'all') {
    for (const [id, p] of Object.entries(status)) {
      if (id === 'licensing' || id === 'views') continue;
      if (p && typeof p === 'object') rows.push(...sectionRows(id, p, now));
    }
  } else {
    rows.push(...sectionRows(scope, status[scope], now));
    if (scope === 'cohesity') {
      const lic = status.licensing;
      if (lic && lic.enabled) rows.push(globalRow('cohesity', 'licensing', lic, now));
    }
  }
  return sortRows(rows);
}

export function sortRows(rows) {
  return [...rows].sort((a, b) =>
    (STATE_RANK[a.state] - STATE_RANK[b.state])
    || a.platform.localeCompare(b.platform)
    || String(a.name).localeCompare(String(b.name)));
}

/** The permission a Poll now button needs (mirrors the backend route). */
export function pollPermission(platform) {
  return platform === 'cohesity' ? 'cohesity:poller:manage' : `${platform}:settings:manage`;
}

export function settingsRoute(platform) {
  return platform === 'cohesity' ? '/settings' : `/${platform}/settings`;
}

export function fmtAge(min) {
  if (min == null) return 'No data yet';
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}
