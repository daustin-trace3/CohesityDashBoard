// Pure1 lifecycle evaluation: hardware end of life, support contract end,
// subscription expiry and Purity code end of life, per array. Reads only the
// tables the Pure1 poller fills (no Pure1 call). Shared by GET
// /api/pure1/governance and the alert notifier so both agree.
const db = require('../db/database');
const pure1Api = require('./pure1Api');
const { lookup: purityLookup, tableInfo: purityTableInfo } = require('./puritySupportDates');

const DAY_MS = 86400000;

function utcDayMs(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysUntil(dateMs, todayMs) {
  return dateMs == null ? null : Math.round((dateMs - todayMs) / DAY_MS);
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const normSerial = (s) => String(s || '').trim().toUpperCase();
const normName = (s) => String(s || '').trim().toLowerCase();

/**
 * Match Pure1 subscription assets to fleet arrays. Chassis serial wins; the
 * array name (case-insensitive) is the fallback. Unmatched assets are kept.
 * assets: pure1Api.fetchSubscriptionAssets() items.
 * arrays: [{ id | pure1Id, name, chassisSerial | chassis_serial }].
 * Returns one entry per asset, in order: { asset, array, by } where array is
 * the matched input object (or null) and by is 'serial', 'name' or null.
 */
function matchAssetsToArrays(assets, arrays) {
  const bySerial = new Map();
  const byName = new Map();
  for (const a of arrays || []) {
    const serial = normSerial(a.chassisSerial || a.chassis_serial);
    if (serial && !bySerial.has(serial)) bySerial.set(serial, a);
    const name = normName(a.name);
    if (name && !byName.has(name)) byName.set(name, a);
  }
  return (assets || []).map((asset) => {
    const serial = normSerial(asset.array && asset.array.chassisSerialNumber);
    if (serial && bySerial.has(serial)) return { asset, array: bySerial.get(serial), by: 'serial' };
    const name = normName(asset.name);
    if (name && byName.has(name)) return { asset, array: byName.get(name), by: 'name' };
    return { asset, array: null, by: null };
  });
}

function hardwareState(daysToEol, warnDays) {
  if (daysToEol == null) return 'unknown';
  if (daysToEol < 0) return 'past';
  if (daysToEol <= warnDays) return 'approaching';
  return 'ok';
}

// Contract and subscription share the rule: past the end date is expired.
function endState(daysLeft, warnDays) {
  if (daysLeft == null) return 'unknown';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= warnDays) return 'expiring';
  return 'ok';
}

function compareVersionsDesc(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function newestCapture(rowsList) {
  let newest = null;
  for (const rows of rowsList) {
    for (const r of rows) {
      if (r.captured_at && (!newest || r.captured_at > newest)) newest = r.captured_at;
    }
  }
  if (!newest) return null;
  const d = new Date(newest.endsWith('Z') ? newest : `${newest.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function worstOf(states) {
  const known = states.filter((s) => s !== 'unknown');
  if (!known.length) return 'unknown';
  if (known.some((s) => s === 'past' || s === 'expired' || s === 'eol')) return 'crit';
  if (known.some((s) => s === 'approaching' || s === 'expiring')) return 'warn';
  return 'ok';
}

/**
 * Evaluate the whole fleet. `now` is a Date or epoch ms. Returns
 * { asOf, thresholds, purityTable, summary, arrays, versions, models,
 *   subscriptions, assetsUnmatched } (shape documented in the lifecycle contract).
 */
function evaluate(now = new Date(), opts = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const nowDate = new Date(nowMs);
  const today = utcDayMs(nowMs);
  const thresholds = opts.thresholds || pure1Api.getLifecycleThresholds();
  const { hwEolWarnDays, contractWarnDays, purityEolWarnDays } = thresholds;

  const arrayRows = db.prepare('SELECT * FROM pure1_arrays ORDER BY name').all();
  const assetRows = db.prepare('SELECT * FROM pure1_subscription_assets').all();
  const contractRows = db.prepare('SELECT * FROM pure1_support_contracts').all();
  const subRows = db.prepare('SELECT * FROM pure1_subscriptions').all();
  const licRows = db.prepare('SELECT * FROM pure1_subscription_licenses').all();

  const assetByArray = new Map();
  for (const a of assetRows) {
    if (!a.pure1_array_id) continue;
    const cur = assetByArray.get(a.pure1_array_id);
    // Several assets on one array: prefer one that carries an end of life date.
    if (!cur || (cur.end_of_life_date_ms == null && a.end_of_life_date_ms != null)) assetByArray.set(a.pure1_array_id, a);
  }
  // Contracts key on the Pure1 array id; the array name and fqdn are
  // fallbacks in case a tenant reports a resource id in another form.
  const contractByResource = new Map();
  const contractByName = new Map();
  const keepNewest = (map, key, c) => {
    if (!key) return;
    const cur = map.get(key);
    if (!cur || (c.end_date_ms || 0) > (cur.end_date_ms || 0)) map.set(key, c);
  };
  for (const c of contractRows) {
    keepNewest(contractByResource, c.resource_id, c);
    keepNewest(contractByName, normName(c.resource_name), c);
    keepNewest(contractByName, normName(c.fqdn), c);
  }
  const subById = new Map(subRows.map((s) => [s.subscription_id, s]));
  // Assets reference their subscription by id and name; the name (the
  // subscription number on real tenants) is the fallback join.
  const subByName = new Map();
  for (const s of subRows) { if (s.name && !subByName.has(normName(s.name))) subByName.set(normName(s.name), s); }
  const licById = new Map(licRows.map((l) => [l.license_id, l]));
  const licByResource = new Map();
  for (const l of licRows) {
    for (const r of parseJson(l.resources) || []) {
      if (r && r.id && !licByResource.has(r.id)) licByResource.set(r.id, l);
    }
  }

  const subscriptionView = (s) => {
    const daysLeft = daysUntil(s.expiration_date_ms, today);
    return {
      id: s.subscription_id,
      name: s.name,
      service: s.service,
      serviceTier: s.service_tier,
      serviceSla: s.service_sla,
      status: s.status,
      startDate: s.start_date_ms,
      expirationDate: s.expiration_date_ms,
      daysLeft,
      term: s.subscription_term,
      state: endState(daysLeft, contractWarnDays),
    };
  };

  const arrays = arrayRows.map((r) => {
    const asset = assetByArray.get(r.pure1_id) || null;
    const eol = asset ? asset.end_of_life_date_ms : null;
    const daysToEol = daysUntil(eol, today);
    const upgrade = asset && (asset.upgrade_action_needed != null
      || asset.upgrade_commitment_date_ms != null || asset.upgrade_eligibility_date_ms != null)
      ? {
        actionNeeded: asset.upgrade_action_needed,
        commitmentDate: asset.upgrade_commitment_date_ms,
        eligibilityDate: asset.upgrade_eligibility_date_ms,
      } : null;
    const hardware = {
      assetId: asset ? asset.asset_id : null,
      assetName: asset ? asset.name : null,
      endOfLifeDate: eol == null ? null : eol,
      daysToEol,
      state: hardwareState(daysToEol, hwEolWarnDays),
      activationDate: asset ? asset.activation_date_ms : null,
      customerName: asset ? asset.customer_name : null,
      installAddress: asset ? parseJson(asset.install_address) : null,
      upgrade,
    };

    const c = contractByResource.get(r.pure1_id) || contractByName.get(normName(r.name))
      || contractByName.get(normName(r.fqdn)) || null;
    const cDays = c ? daysUntil(c.end_date_ms, today) : null;
    const contract = {
      startDate: c ? c.start_date_ms : null,
      endDate: c ? c.end_date_ms : null,
      daysLeft: cDays,
      state: endState(cDays, contractWarnDays),
    };

    let subRow = asset && asset.subscription_id ? subById.get(asset.subscription_id) : null;
    if (!subRow && asset && asset.subscription_name) subRow = subByName.get(normName(asset.subscription_name)) || null;
    let subscription = null;
    if (subRow) subscription = subscriptionView(subRow);
    else if (asset && (asset.subscription_id || asset.subscription_name)) {
      subscription = {
        id: asset.subscription_id, name: asset.subscription_name, service: null, serviceTier: null,
        serviceSla: null, status: null, startDate: null, expirationDate: null, daysLeft: null, term: null, state: 'unknown',
      };
    }

    const licRow = (asset && asset.license_id && licById.get(asset.license_id)) || licByResource.get(r.pure1_id) || null;
    const license = licRow ? {
      id: licRow.license_id,
      name: licRow.name,
      serviceTier: licRow.service_tier,
      startDate: licRow.start_date_ms,
      expirationDate: licRow.expiration_date_ms,
      daysLeft: daysUntil(licRow.expiration_date_ms, today),
    } : null;

    const purity = purityLookup(r.version, nowDate, purityEolWarnDays);
    return {
      id: r.pure1_id,
      name: r.name,
      fqdn: r.fqdn,
      model: r.model,
      os: r.os,
      version: r.version,
      chassisSerial: r.chassis_serial,
      health: r.health,
      purity,
      hardware,
      contract,
      subscription,
      license,
      worst: worstOf([hardware.state, contract.state, purity.phase, subscription ? subscription.state : 'unknown']),
    };
  });

  const count = (fn) => arrays.filter(fn).length;
  const subscriptions = subRows.map((s) => {
    const v = subscriptionView(s);
    return {
      id: v.id,
      name: v.name,
      service: v.service,
      serviceTier: v.serviceTier,
      serviceSla: v.serviceSla,
      status: v.status,
      startDate: v.startDate,
      expirationDate: v.expirationDate,
      daysLeft: v.daysLeft,
      term: v.term,
      state: v.state,
      customerName: s.customer_name,
      partnerName: s.partner_name,
      arrayCount: count((a) => a.subscription && a.subscription.id === s.subscription_id),
      licenseCount: licRows.filter((l) => l.subscription_id === s.subscription_id).length,
    };
  }).sort((a, b) => (a.expirationDate ?? Infinity) - (b.expirationDate ?? Infinity));

  const versionMap = new Map();
  for (const a of arrays) {
    const key = a.version || '';
    if (!versionMap.has(key)) versionMap.set(key, { version: a.version, count: 0, purity: a.purity });
    versionMap.get(key).count += 1;
  }
  const versions = [...versionMap.values()].sort((a, b) => compareVersionsDesc(a.version, b.version));

  const modelMap = new Map();
  for (const a of arrays) {
    const key = a.model || '';
    if (!modelMap.has(key)) modelMap.set(key, { model: a.model, count: 0, earliestEol: null, pastEol: 0, approaching: 0 });
    const m = modelMap.get(key);
    m.count += 1;
    const eol = a.hardware.endOfLifeDate;
    if (eol != null && (m.earliestEol == null || eol < m.earliestEol)) m.earliestEol = eol;
    if (a.hardware.state === 'past') m.pastEol += 1;
    if (a.hardware.state === 'approaching') m.approaching += 1;
  }
  const models = [...modelMap.values()].sort((a, b) => b.count - a.count || String(a.model).localeCompare(String(b.model)));

  const assetsUnmatched = assetRows.filter((a) => !a.pure1_array_id).map((a) => ({
    assetId: a.asset_id,
    name: a.name,
    model: a.model,
    version: a.version,
    chassisSerial: a.chassis_serial,
    endOfLifeDate: a.end_of_life_date_ms,
    subscriptionName: a.subscription_name,
  }));

  return {
    asOf: newestCapture([assetRows, contractRows, subRows, licRows]),
    // Row counts per Pure1 list as stored by the last successful fetch, so the
    // page can say when a list came back empty instead of showing dashes.
    fetched: { assets: assetRows.length, contracts: contractRows.length, subscriptions: subRows.length, licenses: licRows.length },
    thresholds,
    purityTable: purityTableInfo(),
    summary: {
      arrays: arrays.length,
      hwEolPast: count((a) => a.hardware.state === 'past'),
      hwEolApproaching: count((a) => a.hardware.state === 'approaching'),
      hwEolUnknown: count((a) => a.hardware.state === 'unknown'),
      contractsExpired: count((a) => a.contract.state === 'expired'),
      contractsExpiring: count((a) => a.contract.state === 'expiring'),
      contractsUnknown: count((a) => a.contract.state === 'unknown'),
      purityEol: count((a) => a.purity.phase === 'eol'),
      purityApproaching: count((a) => a.purity.phase === 'approaching'),
      puritySupported: count((a) => a.purity.phase === 'supported'),
      purityUnknown: count((a) => a.purity.phase === 'unknown'),
      subscriptions: subscriptions.length,
      subscriptionsExpiring: subscriptions.filter((s) => s.state === 'expiring').length,
      assetsUnmatched: assetsUnmatched.length,
    },
    arrays,
    versions,
    models,
    subscriptions,
    assetsUnmatched,
  };
}

module.exports = { evaluate, matchAssetsToArrays, hardwareState, endState };
