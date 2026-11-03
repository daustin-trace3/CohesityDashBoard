// Pure Storage scope demo data: pure_arrays rows only (Settings -> Direct
// list). The Pure data pages themselves are served from the in-memory
// pure1Fixtures.js fleet — its name list is the single source of truth so
// Settings shows exactly the arrays the fleet pages render.
const { buildArrayNames, getFleet, buildAlerts, getLifecycle } = require('../pure1Fixtures');
const { randInt, rngFor } = require('./core');

function buildArrayList() {
  return buildArrayNames().map((name) => {
    const [site, , env] = name.split('-');
    return { name, site, env: env.replace(/\d+$/, '') };
  });
}

// Pure1 lifecycle tables (hardware end of life, support contracts, subscriptions,
// licenses) from the same deterministic fixtures the demo Pure1 API serves.
// Assets match arrays by chassis serial SN-<1000+idx>, the serial seeded above.
function seedLifecycle(db, fleet) {
  const { assets, contracts, subscriptions, licenses } = getLifecycle();
  const bySerial = new Map(fleet.map((a, idx) => [`SN-${1000 + idx}`, a]));

  const assetStmt = db.prepare(`
    INSERT OR REPLACE INTO pure1_subscription_assets (asset_id, name, pure1_array_id, array_name,
      chassis_serial, model, version, customer_name, activation_date_ms, end_of_life_date_ms,
      install_address, subscription_id, subscription_name, license_id, license_name,
      upgrade_action_needed, upgrade_commitment_date_ms, upgrade_eligibility_date_ms, as_of_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const a of assets) {
    const serial = a.array.chassisSerialNumber;
    const arr = bySerial.get(serial) || null;
    const up = a.upgradeDetails;
    assetStmt.run(
      a.id, a.name, arr ? arr.id : null, arr ? arr.name : null, serial, a.array.model, a.array.version,
      a.customerName, a.activationDate, a.endOfLifeDate, JSON.stringify(a.installAddress),
      a.subscription.id, a.subscription.name, a.license.id, a.license.name,
      up ? up.actionNeeded : null, up ? up.commitmentDate : null, up ? up.eligibilityDate : null, a.asOf
    );
  }

  const contractStmt = db.prepare(`
    INSERT OR REPLACE INTO pure1_support_contracts (resource_id, resource_name, fqdn, start_date_ms, end_date_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const c of contracts) contractStmt.run(c.resourceId, c.resourceName, c.fqdn, c.startDate, c.endDate);

  const subStmt = db.prepare(`
    INSERT OR REPLACE INTO pure1_subscriptions (subscription_id, name, initial_name, customer_name,
      partner_name, service, service_tier, service_sla, status, start_date_ms, expiration_date_ms,
      subscription_term, last_updated_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const s of subscriptions) {
    subStmt.run(s.id, s.name, s.initialName, s.customerName, s.partnerName, s.service, s.serviceTier,
      s.serviceSla, s.status, s.startDate, s.expirationDate, s.subscriptionTerm, s.lastUpdated);
  }

  const licStmt = db.prepare(`
    INSERT OR REPLACE INTO pure1_subscription_licenses (license_id, name, subscription_id, subscription_name,
      service_tier, start_date_ms, expiration_date_ms, last_updated_ms, site_address, resources, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const l of licenses) {
    licStmt.run(l.id, l.name, l.subscriptionId, l.subscriptionName, l.serviceTier, l.startDate,
      l.expirationDate, l.lastUpdated, l.siteAddress ? JSON.stringify(l.siteAddress) : null, JSON.stringify(l.resources));
  }
}

function seedPure(db, { now, encrypt }) {
  const arrayDefs = buildArrayList();

  const insertArray = db.prepare(`
    INSERT INTO pure_arrays (name, mgmt_host, client_id, key_id, username, issuer, encrypted_credentials, polling_interval_minutes, ssl_verify, auth_method, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'demo', 'demo-issuer', ?, 15, 0, 'client', ?, ?)
  `);

  const nowIso = new Date(now).toISOString();
  arrayDefs.forEach((def, idx) => {
    const credentials = encrypt(JSON.stringify({ privateKey: 'demo-not-real' }));
    const mgmtHost = `10.${80 + idx}.1.10`;
    insertArray.run(
      def.name,
      mgmtHost,
      `demo-client-${idx}`,
      `demo-key-${idx}`,
      credentials,
      nowIso,
      nowIso
    );
  });

  // Pure1 SaaS: page data flows from pure1Fixtures via the isDemo() branches
  // in routes/pure1.js, but the AI Advisor gatherers read the pure1_* TABLES
  // directly — so seed the fleet (with plausible perf values) and alerts into
  // the DB too, plus one metrics_history snapshot for the health bubble.
  const fleet = getFleet();
  const alerts = buildAlerts();

  const p1Stmt = db.prepare(`
    INSERT INTO pure1_arrays (pure1_id, name, fqdn, model, os, version,
      capacity_bytes, used_bytes, data_reduction, effective_used_bytes,
      volume_bytes, shared_bytes, snapshots_bytes, provisioned_bytes,
      health, health_detail, chassis_serial, controller_serials, tags,
      read_iops, write_iops, read_latency_us, write_latency_us,
      read_bw_bytes, write_bw_bytes, perf_captured_at, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  fleet.forEach((a, idx) => {
    const rng = rngFor(`${a.name}-perf`);
    // One deliberately hot array so the performance advisor has a finding.
    const hot = idx === 3;
    p1Stmt.run(
      a.id, a.name, a.fqdn, a.model, a.os, a.version,
      a.total, a.used, a.dataReduction, a.effectiveUsed,
      a.volumeSpace, a.sharedSpace, a.snapshotSpace, Math.round(a.used * 1.2),
      idx === 5 ? 'warn' : 'ok', JSON.stringify({ unhealthy: idx === 5 ? 1 : 0 }),
      `SN-${1000 + idx}`, JSON.stringify([`CT0-${idx}`, `CT1-${idx}`]), JSON.stringify(a.tags || []),
      Math.round(randInt(rng, 8000, 60000)), Math.round(randInt(rng, 4000, 30000)),
      hot ? randInt(rng, 2500, 4000) : randInt(rng, 150, 700),
      hot ? randInt(rng, 3000, 5000) : randInt(rng, 200, 900),
      randInt(rng, 200, 900) * 1e6, randInt(rng, 100, 500) * 1e6,
      new Date(Date.now() - randInt(rng, 1, 20) * 60000).toISOString()
    );
  });

  const alStmt = db.prepare(`
    INSERT OR IGNORE INTO pure1_alerts (pure1_alert_id, array_name, severity, category,
      component_type, component_name, summary, state, flagged, created_at_ms, updated_at_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const al of alerts) {
    alStmt.run(String(al.id), al.arrayName || null, al.severity || null, al.category || null,
      al.componentType || null, al.component || null, al.summary || null, al.state || null,
      al.flagged ? 1 : 0, al.created || null, al.updated || null);
  }
  seedLifecycle(db, fleet);

  db.prepare(`
    INSERT INTO pure1_metrics_history (captured_at, array_count, arrays_warn, arrays_crit,
      total_capacity_bytes, total_used_bytes, open_alerts)
    VALUES (datetime('now'), ?, 0, 0, ?, ?, ?)
  `).run(
    fleet.length,
    fleet.reduce((s, a) => s + (a.total || 0), 0),
    fleet.reduce((s, a) => s + (a.used || 0), 0),
    alerts.filter((a) => a.state === 'open').length
  );

  return { arrays: arrayDefs.length };
}

module.exports = { seedPure, buildArrayList };
