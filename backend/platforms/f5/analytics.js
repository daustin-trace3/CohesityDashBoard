// F5 analytics builders (derived platform). Every read goes through the LogicMonitor connector's feeds via
// the q(name, params) function the caller passes in; nothing here touches an lm_* table. A feed that does not
// exist yet (FEED_UNKNOWN) answers as "unavailable" so pages render an empty state instead of an error; any
// other failure propagates. Forecasts always carry their basis; days is null ("insufficient data") when the
// trend engine could not fit.
const { pairUnits } = require('./haPairs');

const VENDOR = 'f5';
const DAY_MS = 86400000;

const num = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const rowsOf = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const k of keys.concat(['items', 'rows'])) if (Array.isArray(v[k])) return v[k];
  return [];
};
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/** Run a feed; { ok: false, value: fallback } when the feed is not registered yet. */
function tryFeed(q, name, params, fallback) {
  try {
    return { ok: true, value: q(name, params) };
  } catch (err) {
    if (err && err.code === 'FEED_UNKNOWN') return { ok: false, value: fallback };
    throw err;
  }
}
const listFeed = (q, name, params, ...keys) => {
  const r = tryFeed(q, name, params, []);
  return { ok: r.ok, rows: rowsOf(r.value, ...keys) };
};

// ---- HA pairs ------------------------------------------------------------------------------------------

function buildHa(q, { now } = {}) {
  const { ok, rows } = listFeed(q, 'haState', { vendorKey: VENDOR });
  const pairs = pairUnits(rows, { now });
  const summary = {
    pairs: pairs.length,
    atRisk: pairs.filter((p) => p.severity === 'critical' || p.headroom.ok === false || p.partnerMissing).length,
    bothActive: pairs.filter((p) => p.bothActive).length,
    neitherActive: pairs.filter((p) => p.neitherActive).length,
    noHeadroom: pairs.filter((p) => p.headroom.ok === false).length,
    asymmetric: pairs.filter((p) => p.asymmetry).length,
    unpaired: pairs.filter((p) => p.partnerMissing).length,
  };
  return { available: ok, summary, pairs, units: rows.length };
}

// ---- certificates --------------------------------------------------------------------------------------

/** Instance-name stem: lowercase, partition path and file suffix removed. */
function certStem(r) {
  let s = String(r.instanceName || r.vip || '').trim().toLowerCase();
  s = s.replace(/^\/[^/]+\//, '').replace(/\.(crt|cer|pem)$/, '');
  return s;
}

/** Collapse the same certificate (same stem, days left within 1) seen on both HA units or several VIPs. */
function dedupeCerts(rows) {
  const byStem = new Map();
  for (const r of rows) {
    const days = num(r.daysLeft);
    if (days == null) continue;
    const stem = certStem(r);
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push({ ...r, daysLeft: days });
  }
  const unique = [];
  for (const [stem, list] of byStem) {
    list.sort((a, b) => a.daysLeft - b.daysLeft);
    let cluster = null;
    for (const r of list) {
      if (cluster && r.daysLeft - cluster.daysLeft <= 1) {
        cluster.copies += 1;
        if (r.device && !cluster.devices.includes(r.device)) cluster.devices.push(r.device);
        continue;
      }
      cluster = { stem, instanceName: r.instanceName || r.vip || stem, vip: r.vip || null, daysLeft: r.daysLeft, devices: r.device ? [r.device] : [], copies: 1, sampledAt: r.sampledAt || null };
      unique.push(cluster);
    }
  }
  return unique.sort((a, b) => a.daysLeft - b.daysLeft);
}

const bucketOf = (d) => (d < 0 ? 'expired' : d < 7 ? 'lt7' : d < 30 ? 'lt30' : d < 60 ? 'lt60' : d < 90 ? 'lt90' : 'gt90');

function weekStart(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

function buildCertificates(q, { now = Date.now() } = {}) {
  const { ok, rows } = listFeed(q, 'certificates', { vendorKey: VENDOR });
  const unique = dedupeCerts(rows);
  const buckets = { expired: 0, lt7: 0, lt30: 0, lt60: 0, lt90: 0, gt90: 0 };
  for (const c of unique) buckets[bucketOf(c.daysLeft)] += 1;
  const weeks = new Map();
  for (const c of unique.filter((x) => x.daysLeft >= 0 && x.daysLeft < 90)) {
    const wk = weekStart(now + c.daysLeft * DAY_MS);
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk).push({ ...c, expiresOn: new Date(now + c.daysLeft * DAY_MS).toISOString().slice(0, 10) });
  }
  const perDevice = new Map();
  for (const r of rows) {
    const d = num(r.daysLeft);
    if (d == null) continue;
    const k = r.device || 'unknown';
    const e = perDevice.get(k) || { device: k, certs: 0, expired: 0, lt30: 0 };
    e.certs += 1;
    if (d < 0) e.expired += 1;
    if (d < 30) e.lt30 += 1;
    perDevice.set(k, e);
  }
  return {
    available: ok,
    rawTotal: rows.filter((r) => num(r.daysLeft) != null).length,
    uniqueTotal: unique.length,
    duplicatesCollapsed: rows.filter((r) => num(r.daysLeft) != null).length - unique.length,
    dedupeRule: 'Same instance name stem with days left within 1 counts once (the same certificate on both HA units or several VIPs).',
    buckets,
    expiring30: buckets.expired + buckets.lt7 + buckets.lt30,
    expiring90: buckets.expired + buckets.lt7 + buckets.lt30 + buckets.lt60 + buckets.lt90,
    certs: unique,
    weeks: [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, certs]) => ({ week, certs })),
    perDevice: [...perDevice.values()].sort((a, b) => b.expired - a.expired || b.lt30 - a.lt30 || a.device.localeCompare(b.device)),
  };
}

// ---- trends ----------------------------------------------------------------------------------------------

const keyOf = (r) => `${r.sourceId ?? ''}:${r.deviceId ?? r.id ?? ''}`;

/** Forecast block from a trend finding or a deviceResources sub-object: days null = insufficient data. */
function forecastOf(f) {
  if (!f) return { days: null, basis: null, insufficient: true };
  const days = num(f.daysToThreshold != null ? f.daysToThreshold : f.days);
  const b = f.basis || {};
  const r2 = num(f.r2 != null ? f.r2 : b.r2);
  const n = num(f.n != null ? f.n : b.n);
  const windowDays = num(b.windowDays);
  const basis = days == null
    ? (b.reason ? String(b.reason).replace(/_/g, ' ') : 'insufficient data')
    : `linear fit over ${windowDays != null ? windowDays : (n != null ? n : '?')} days${r2 != null ? `, R2 ${Math.round(r2 * 100) / 100}` : ''}`;
  return { days, basis, insufficient: days == null, slopePerDay: num(f.slopePerDay), r2, n, severity: f.severity || null };
}

function buildTrends(q, { deviceId, sourceId, days = 30 } = {}) {
  const res = listFeed(q, 'deviceResources', { vendorKey: VENDOR, deviceId, sourceId, days });
  const tr = listFeed(q, 'trends', { vendorKey: VENDOR, deviceId, sourceId, limit: 500 });
  const lbs = listFeed(q, 'loadBalancers', { vendorKey: VENDOR });
  const byDevKind = new Map();
  for (const t of tr.rows) {
    const k = `${keyOf(t)}|${t.kind}`;
    if (!byDevKind.has(k)) byDevKind.set(k, []);
    byDevKind.get(k).push(t);
  }
  const lbBy = new Map(lbs.rows.map((r) => [keyOf({ sourceId: r.sourceId, deviceId: r.deviceId ?? r.id }), r]));
  const devices = res.rows.map((r) => {
    const k = keyOf(r);
    const lb = lbBy.get(k) || {};
    const cpuFinding = (byDevKind.get(`${k}|cpu_forecast`) || [])[0] || r.cpu?.forecast || null;
    const creep = (byDevKind.get(`${k}|mem_creep`) || [])[0] || r.mem?.creep || null;
    const fs = (byDevKind.get(`${k}|fs_forecast`) || []).map((f) => ({ fs: f.subject, usedPct: num(f.value), threshold: num(f.threshold), forecast: forecastOf(f) }));
    const cpu = r.cpu || {};
    const mem = r.mem || {};
    const conns = r.connections || {};
    const cNow = num(lb.clientConnections);
    const sNow = num(lb.serverConnections);
    return {
      sourceId: r.sourceId ?? null, deviceId: r.deviceId ?? r.id ?? null, device: r.device || r.displayName || lb.deviceName || '', site: r.site || r.siteName || lb.siteName || null,
      cpu: { now: num(cpu.now ?? lb.cpuPct), p95: num(cpu.p95), slopePerDay: num(cpu.slope), forecast: forecastOf(cpuFinding) },
      mem: { now: num(mem.now ?? lb.memPct), p95: num(mem.p95), slopePerDay: num(mem.slope), creep: creep ? { ...forecastOf(creep), note: 'Rising memory with no reboot in the window; an estimate, review the TMOS version.' } : null },
      connections: { clientNow: cNow, serverNow: sNow, peak: num(conns.peak), ratio: cNow != null && sNow ? round1((cNow / sNow) * 100) / 100 : null },
      filesystems: fs.length ? fs : rowsOf(r.flash).map((f) => ({ fs: f.fs, usedPct: num(f.usedPct), threshold: 90, forecast: { days: num(f.daysTo90 != null ? f.daysTo90 : f.daysTo95), basis: 'feed', insufficient: num(f.daysTo90 != null ? f.daysTo90 : f.daysTo95) == null } })),
    };
  }).sort((a, b) => (a.cpu.forecast.days == null) - (b.cpu.forecast.days == null) || (a.cpu.forecast.days ?? 0) - (b.cpu.forecast.days ?? 0) || (b.cpu.p95 ?? -1) - (a.cpu.p95 ?? -1));
  const anomalies = tr.rows.filter((t) => t.kind === 'conn_anomaly').map((t) => ({
    sourceId: t.sourceId ?? null, deviceId: t.deviceId ?? null, device: t.device, value: num(t.value), direction: (t.detail && t.detail.direction) || null, severity: t.severity, computedAt: t.computedAt,
  }));
  // Optional hour x weekday profile (feed 'hourlyProfile'); absent until the feed lands.
  const hp = tryFeed(q, 'hourlyProfile', { vendorKey: VENDOR, deviceId, sourceId, metric: 'client_connections', days: 14 }, null);
  return {
    available: res.ok, days, devices, anomalies,
    heatmap: hp.ok && hp.value ? { cells: rowsOf(hp.value, 'cells'), basis: hp.value.basis || 'hour-of-day median over 14 days' } : null,
    notes: ['Forecasts are linear-fit estimates and show their basis; "insufficient data" means the trend engine had too few days or a weak fit.'],
  };
}

// ---- pools -----------------------------------------------------------------------------------------------

function cvOf(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!mean) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
const IMBALANCE_CV = 0.75;

function poolsFromRows(rows) {
  const byPool = new Map();
  for (const r of rows) {
    const k = `${r.sourceId ?? ''}|${r.device || ''}|${r.pool || ''}`;
    if (!byPool.has(k)) byPool.set(k, { sourceId: r.sourceId ?? null, deviceId: r.deviceId ?? null, device: r.device || '', pool: r.pool || '', members: [] });
    byPool.get(k).members.push({ member: r.member, connections: num(r.connections), bitsIn: num(r.bitsIn), bitsOut: num(r.bitsOut), sessions: num(r.sessions) });
  }
  const carries = (m) => (m.connections || 0) > 0 || (m.bitsIn || 0) > 0 || (m.bitsOut || 0) > 0;
  return [...byPool.values()].map((p) => {
    const conns = p.members.map((m) => m.connections ?? 0);
    const totalConns = conns.reduce((a, b) => a + b, 0);
    const bits = p.members.reduce((a, m) => a + (m.bitsIn || 0) + (m.bitsOut || 0), 0);
    const carrying = p.members.filter(carries);
    const cv = cvOf(conns);
    const zero = totalConns > 0 ? p.members.filter((m) => (m.connections || 0) === 0 && !carries(m)).map((m) => m.member) : [];
    const spof = (p.members.length === 1 && carrying.length === 1) || (p.members.length > 1 && carrying.length === 1);
    return {
      ...p, memberCount: p.members.length, totalConnections: totalConns, totalBits: bits,
      cv: cv == null ? null : Math.round(cv * 100) / 100,
      imbalanced: cv != null && cv > IMBALANCE_CV && carrying.length > 1,
      zeroMembers: zero, spof,
      spofReason: spof ? (p.members.length === 1 ? 'Single member pool carrying traffic.' : `One of ${p.members.length} members carries all the traffic.`) : null,
    };
  });
}

function buildPools(q, { deviceId, sourceId } = {}) {
  const { ok, rows } = listFeed(q, 'poolMembers', { deviceId, sourceId });
  const pools = poolsFromRows(rows);
  const talkers = rows.map((r) => ({ device: r.device, pool: r.pool, member: r.member, bits: (num(r.bitsIn) || 0) + (num(r.bitsOut) || 0), connections: num(r.connections) }))
    .sort((a, b) => b.bits - a.bits).slice(0, 10);
  const poolTalkers = pools.slice().sort((a, b) => b.totalBits - a.totalBits).slice(0, 10).map((p) => ({ device: p.device, pool: p.pool, bits: p.totalBits, connections: p.totalConnections, members: p.memberCount }));
  const rank = (p) => (p.spof ? 0 : p.zeroMembers.length ? 1 : p.imbalanced ? 2 : 3);
  return {
    available: ok,
    summary: { pools: pools.length, spof: pools.filter((p) => p.spof).length, imbalanced: pools.filter((p) => p.imbalanced).length, withIdleMembers: pools.filter((p) => p.zeroMembers.length).length },
    rules: `SPOF: exactly one member carries traffic. Imbalance: coefficient of variation of member connections above ${IMBALANCE_CV} with more than one member carrying traffic (a heuristic). Pool name is the instance name before the first / or : (an assumption until the live poll confirms it). Member availability has no datapoint, so carrying traffic stands in for up.`,
    pools: pools.sort((a, b) => rank(a) - rank(b) || b.totalConnections - a.totalConnections),
    topMembers: talkers, topPools: poolTalkers,
  };
}

// ---- GTM -------------------------------------------------------------------------------------------------

function buildGtm(q, { days = 30 } = {}) {
  const dev = listFeed(q, 'devices', { vendorKey: VENDOR, vendorKind: 'gtm' });
  const g = tryFeed(q, 'gtm', { vendorKey: VENDOR, days }, null);
  const v = g.value || {};
  // A GTM device (vendor_kind gtm or combined gltm) or any wide IP data makes the section real.
  const present = dev.rows.some((d) => /gtm|gltm/i.test(String(d.vendorKind || '')))
    || rowsOf(v.wideIpAvailability, 'events').length > 0 || rowsOf(v.topWideIps).length > 0;
  const series = (x) => rowsOf(x).map((p) => ({ day: p.day || p.date, value: num(p.value) }));
  const req = series(v.requestsPerDay);
  const res = series(v.resolutionsPerDay);
  let ratio = series(v.ratio);
  if (!ratio.length && req.length) {
    const rmap = new Map(res.map((p) => [p.day, p.value]));
    ratio = req.map((p) => ({ day: p.day, value: p.value > 0 && rmap.get(p.day) != null ? Math.round((rmap.get(p.day) / p.value) * 1000) / 1000 : null }));
  }
  const events = rowsOf(v.wideIpAvailability, 'events').map((e) => ({ wideIp: e.wideIp || e.subject || e.name, day: e.day, min: num(e.min), max: num(e.max) }));
  const dcEvents = rowsOf(v.datacenterAvailability, 'events').map((e) => ({ datacenter: e.datacenter || e.subject || e.name, day: e.day, min: num(e.min), max: num(e.max) }));
  const correlated = dcEvents.length
    ? events.map((e) => ({ ...e, datacenters: dcEvents.filter((d) => d.day === e.day).map((d) => d.datacenter) }))
    : events.map((e) => ({ ...e, datacenters: null }));
  return {
    available: g.ok, present, days, requestsPerDay: req, resolutionsPerDay: res, ratio,
    wideIpAvailability: correlated,
    correlationNote: dcEvents.length ? 'A wide IP change is listed with the data centers whose availability also changed that day.' : 'Data center availability history is not in the feed, so same-day correlation is not shown.',
    topWideIps: rowsOf(v.perWideIp).slice(0, 15),
  };
}

// ---- stability ---------------------------------------------------------------------------------------------

function buildStability(q, { days = 30 } = {}) {
  const daemons = listFeed(q, 'daemonFlaps', { vendorKey: VENDOR, days });
  const hw = tryFeed(q, 'hardware', { vendorKey: VENDOR }, { components: [], derived: {} });
  const errs = listFeed(q, 'interfacesAnalytics', { vendorKey: VENDOR, tab: 'errors', days, limit: 20 });
  const hot = listFeed(q, 'interfacesAnalytics', { vendorKey: VENDOR, tab: 'hot', days, limit: 20 });
  const reb = listFeed(q, 'trends', { vendorKey: VENDOR, kind: 'reboot', limit: 200 });
  const hv = hw.value || {};
  return {
    available: { daemons: daemons.ok, hardware: hw.ok, interfaces: errs.ok || hot.ok },
    days,
    daemons: daemons.rows.sort((a, b) => (b.nonZeroDays || 0) - (a.nonZeroDays || 0)),
    hardware: { components: rowsOf(hv.components), derived: hv.derived || {} },
    interfaces: { errors: errs.rows, hot: hot.rows },
    reboots: reb.rows.map((r) => ({ device: r.device, events: rowsOf(r.detail && r.detail.events), computedAt: r.computedAt })),
  };
}

// ---- fleet hygiene -------------------------------------------------------------------------------------------

function buildFleet(q, { days = 30 } = {}) {
  const v = listFeed(q, 'fleetVersions', { vendorKey: VENDOR });
  const a = tryFeed(q, 'availability', { vendorKey: VENDOR, days }, null);
  const n = tryFeed(q, 'alertNoise', { vendorKey: VENDOR, days }, null);
  return { available: v.ok || a.ok || n.ok, days, versions: v.rows, availability: a.value, alertNoise: n.value };
}

// ---- overview tiles ----------------------------------------------------------------------------------------------

/** Each tile is null when its feed is not available, so the page shows a dash instead of a false zero. */
function buildTiles(q, { now } = {}) {
  const tiles = { haPairsAtRisk: null, certs30dDeduped: null, cpuForecast30d: null, poolsSpof: null, daemonFlaps7d: null };
  const ha = buildHa(q, { now });
  if (ha.available) tiles.haPairsAtRisk = ha.summary.atRisk;
  const certs = buildCertificates(q, { now });
  if (certs.available) tiles.certs30dDeduped = certs.expiring30;
  const tr = tryFeed(q, 'trends', { vendorKey: VENDOR, kind: 'cpu_forecast', limit: 500 }, []);
  if (tr.ok) tiles.cpuForecast30d = rowsOf(tr.value).filter((t) => num(t.daysToThreshold) != null && num(t.daysToThreshold) <= 30).length;
  const pools = buildPools(q);
  if (pools.available) tiles.poolsSpof = pools.summary.spof;
  const dm = listFeed(q, 'daemonFlaps', { vendorKey: VENDOR, days: 7 });
  if (dm.ok) tiles.daemonFlaps7d = dm.rows.filter((d) => (d.nonZeroDays || 0) > 0).length;
  return { tiles, certs };
}

module.exports = {
  buildHa, buildCertificates, buildTrends, buildPools, buildGtm, buildStability, buildFleet, buildTiles,
  dedupeCerts, forecastOf, poolsFromRows, tryFeed, listFeed, rowsOf,
};
