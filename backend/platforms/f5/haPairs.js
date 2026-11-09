// Pure HA pairing for BIG-IP units (no db, no feeds). Input rows come from the haState feed:
//   { sourceId, deviceId, device, site, deviceGroup?, failoverState, failoverText?, syncState,
//     cpuP95_7d, cpuBaseline, clientConnections, lastFailoverDay, failovers90d }
// Pairing rule: units sharing a device group (when the feed carries one) form a pair; otherwise units at
// the same site whose names share a stem once the trailing -01/-02, -1/-2, -a/-b, -primary/-secondary
// (and -pri/-sec) marker is stripped. More than two units in one key are chunked into pairs by name.
// A unit with no partner is returned alone (partnerMissing). Failover enum fallback when no text is
// present: 4 = active, 3 = standby, 1 and 2 = offline (the F5 MIB sysCmFailoverStatusId; UNVERIFIED on
// the live portal, WP-F0), text always wins over the number.

const CPU_LIMIT_PCT = 80;
const ASYMMETRY_SHARE = 0.2;

const num = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const nameOf = (r) => String(r.device || r.displayName || r.deviceName || r.name || '');

/** Role of one unit: 'active' | 'standby' | 'offline' | 'unknown'. */
function roleOf(row) {
  let text = row.failoverText;
  const fs = row.failoverState;
  if (text == null && fs && typeof fs === 'object') text = fs.text != null ? fs.text : fs.label;
  if (text == null && typeof fs === 'string' && !/^\d+$/.test(fs.trim())) text = fs;
  if (text != null && String(text).trim() !== '') {
    const t = String(text).toLowerCase();
    if (/standby/.test(t)) return 'standby';
    if (/active/.test(t)) return 'active';
    if (/offline|forced|down|fail/.test(t)) return 'offline';
    return 'unknown';
  }
  const raw = num(fs && typeof fs === 'object' ? (fs.raw != null ? fs.raw : fs.value) : fs);
  if (raw === 4) return 'active';
  if (raw === 3) return 'standby';
  if (raw === 1 || raw === 2) return 'offline';
  return 'unknown';
}

// Marker at the end of a name: a separator plus 01/02/1/2/a/b/pri/sec/primary/secondary, or a bare 1/2/01/02
// glued to the name ("lb1", "lb2"). A bare a/b glued to a word ("lbdata", "lbb") is NOT a marker.
const MARKER_SEP = /[-_](?:0?[12]|a|b|primary|secondary|pri|sec)$/;
const MARKER_DIGIT = /(?<=[a-z])0?[12]$/;

/** Name stem with the HA marker stripped, lowercased; a trailing domain is dropped unless the name is an IP. */
function stemOf(name) {
  let s = String(name || '').trim().toLowerCase();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) s = s.split('.')[0];
  const a = s.replace(MARKER_SEP, '');
  if (a !== s) return a || s;
  const b = s.replace(MARKER_DIGIT, '');
  return b || s;
}

function syncOk(text) {
  if (text == null || text === '') return null;
  return /in sync|synced|standalone|^0$/.test(String(text).toLowerCase());
}

function daysSince(day, now) {
  if (!day) return null;
  const t = Date.parse(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86400000));
}

const unitOf = (r) => ({
  sourceId: r.sourceId ?? null,
  deviceId: r.deviceId ?? r.id ?? null,
  device: nameOf(r),
  site: r.site || r.siteName || null,
  role: roleOf(r),
  syncState: r.syncState ?? null,
  clientConnections: num(r.clientConnections),
  cpuP95: num(r.cpuP95_7d),
  cpuBaseline: num(r.cpuBaseline),
});

const RANK = { critical: 0, warning: 1, info: 2, ok: 3 };

function buildPair(key, members, now) {
  const [a, b] = members;
  const units = [unitOf(a), b ? unitOf(b) : null];
  const known = units.filter(Boolean);
  const roles = units.map((u) => (u ? u.role : null));
  const active = known.filter((u) => u.role === 'active');
  const standby = known.filter((u) => u.role === 'standby');
  const partnerMissing = known.length < 2;
  const bothActive = known.length === 2 && active.length === 2;
  const neitherActive = known.length === 2 && active.length === 0;
  const syncs = known.map((u) => u.syncState).filter((s) => s != null && s !== '');
  const syncState = syncs.find((s) => syncOk(s) === false) ?? syncs[0] ?? null;
  const lastDay = members.map((m) => m.lastFailoverDay).filter(Boolean).sort().pop() || null;
  const failovers90d = Math.max(0, ...members.map((m) => num(m.failovers90d) ?? 0));

  // Headroom: can the standby absorb the active unit? Needs one active and one standby with numbers.
  let headroom = { activeCpuP95: null, standbyCpuBaseline: null, sum: null, limit: CPU_LIMIT_PCT, ok: null, note: 'Needs one active and one standby unit with CPU history.' };
  if (active.length === 1 && standby.length === 1) {
    const cpuA = active[0].cpuP95;
    const cpuS = standby[0].cpuBaseline != null ? standby[0].cpuBaseline : standby[0].cpuP95;
    if (cpuA != null && cpuS != null) {
      headroom = {
        activeCpuP95: cpuA, standbyCpuBaseline: cpuS, sum: cpuA + cpuS, limit: CPU_LIMIT_PCT, ok: cpuA + cpuS < CPU_LIMIT_PCT,
        note: 'Active p95 CPU over 7 days plus the standby baseline CPU, against an 80 percent limit. An estimate.',
      };
    }
  }
  // Asymmetry: the standby carries more than 20 percent of the active unit's client connections.
  let standbyShare = null;
  if (active.length === 1 && standby.length === 1 && active[0].clientConnections > 0 && standby[0].clientConnections != null) {
    standbyShare = standby[0].clientConnections / active[0].clientConnections;
  }
  const asymmetry = standbyShare != null && standbyShare > ASYMMETRY_SHARE;

  const reasons = [];
  let severity = 'ok';
  const raise = (sev, text) => { reasons.push(text); if (RANK[sev] < RANK[severity]) severity = sev; };
  if (bothActive) raise('critical', 'Both units report active (split brain).');
  if (neitherActive) raise('critical', 'Neither unit reports active.');
  if (partnerMissing) raise('warning', 'No partner unit was found for this device.');
  if (headroom.ok === false) raise('warning', `Standby cannot absorb the active unit: ${Math.round(headroom.sum)} percent combined CPU against ${CPU_LIMIT_PCT}.`);
  if (syncOk(syncState) === false) raise('warning', `Sync state is ${syncState}.`);
  if (asymmetry) raise('info', `Standby carries ${Math.round(standbyShare * 100)} percent of the active unit's client connections.`);

  return {
    pairKey: key, units, roles, bothActive, neitherActive, partnerMissing, syncState,
    daysSinceFailover: daysSince(lastDay, now), lastFailoverDay: lastDay, failovers90d,
    headroom, standbyShare, asymmetry, severity, reasons,
  };
}

/** Pair the rows. now (ms) is injectable for tests. Returns pairs, worst first. */
function pairUnits(rows, { now = Date.now() } = {}) {
  const groups = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const group = r.deviceGroup || r.syncGroup || null;
    const key = group
      ? `g:${r.sourceId ?? ''}:${String(group).toLowerCase()}`
      : `s:${String(r.site || r.siteName || '').toLowerCase()}:${stemOf(nameOf(r))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const pairs = [];
  for (const [key, list] of groups) {
    list.sort((x, y) => nameOf(x).localeCompare(nameOf(y)));
    for (let i = 0; i < list.length; i += 2) {
      pairs.push(buildPair(list.length > 2 ? `${key}#${i / 2 + 1}` : key, list.slice(i, i + 2), now));
    }
  }
  return pairs.sort((x, y) => RANK[x.severity] - RANK[y.severity] || String(x.units[0].device).localeCompare(String(y.units[0].device)));
}

module.exports = { pairUnits, stemOf, roleOf, CPU_LIMIT_PCT, ASYMMETRY_SHARE };
