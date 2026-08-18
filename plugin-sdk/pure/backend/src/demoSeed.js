// Pure Storage demo data: 20 direct-connect array registrations (Settings ->
// Direct list; pure_arrays rows only — the built-in never seeded per-array
// telemetry for direct connections in demo mode either, since the Pure data
// pages are powered by the Pure1 SaaS fleet fixtures) + the Pure1 fleet
// (pure1_arrays/pure1_alerts/pure1_metrics_history), whose array-name list is
// pure1Fixtures.js's buildArrayNames() — the single source of truth so
// Settings shows exactly the arrays the fleet pages render.
//
// Ported from backend/demo/generators/pure.js. ALL inserts here run ONLY
// behind the DASHBOARD_DEMO==='1' gate — see seedPureDemo() below, called
// from poller.js's manifest createPoller(coreApi) entry point on every boot
// in demo mode. Only the seeded-random helpers were copied from the host's
// demo/generators/core.js (./demoRng.js) — no seedCore/encryption requires.
// Credential encryption uses coreApi.encryption.encrypt (dell/zerto plugin
// demoSeed.js precedent) instead of requiring the host's encryption service
// directly.
//
// DEVIATION FROM THE BUILT-IN's wipe strategy: pure_arrays itself is NEVER
// wiped/deleted (it is the user-facing connection table — an admin could
// register a real array on a demo instance and that must survive a reseed).
// Instead the 20 fixture arrays are upserted by name so their id stays
// stable across boots. pure1_* tables carry no user-created state at all
// (Pure1 is a single account-wide fleet with credentials in app_settings,
// not a per-row connection table) — they are fully wiped and reseeded each
// boot, matching the poller's own wholesale-replace convention.
const { buildArrayNames, getFleet, buildAlerts } = require('./pure1Fixtures');
const { randInt, rngFor } = require('./demoRng');

function buildArrayList() {
  return buildArrayNames().map((name) => {
    const [site, , env] = name.split('-');
    return { name, site, env: env.replace(/\d+$/, '') };
  });
}

function seedPure(db, { now, encrypt }) {
  const arrayDefs = buildArrayList();
  const nowIso = new Date(now).toISOString();

  const upsertArray = db.prepare(`
    INSERT INTO pure_arrays
      (name, mgmt_host, client_id, key_id, username, issuer, encrypted_credentials,
       polling_interval_minutes, ssl_verify, auth_method, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'demo', 'demo-issuer', ?, 15, 0, 'client', ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      mgmt_host = excluded.mgmt_host, encrypted_credentials = excluded.encrypted_credentials,
      updated_at = excluded.updated_at
  `);
  arrayDefs.forEach((def, idx) => {
    const credentials = encrypt(JSON.stringify({ privateKey: 'demo-not-real' }));
    const mgmtHost = `10.${80 + idx}.1.10`;
    upsertArray.run(def.name, mgmtHost, `demo-client-${idx}`, `demo-key-${idx}`, credentials, nowIso, nowIso);
  });

  // Pure1 SaaS: page data flows from pure1Fixtures via the isDemo() branches
  // in router.js, but the AI Advisor gatherers read the pure1_* TABLES
  // directly — so seed the fleet (with plausible perf values) and alerts
  // into the DB too, plus one metrics_history snapshot for the health
  // bubble. No per-row connection state here to preserve — full wipe+reseed.
  db.prepare('DELETE FROM pure1_alerts').run();
  db.prepare('DELETE FROM pure1_metrics_history').run();
  db.prepare('DELETE FROM pure1_arrays').run();

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

  return { arrays: arrayDefs.length, pure1Arrays: fleet.length, pure1Alerts: alerts.length };
}

/** Demo-only entry point. Upserts the 20 fixture direct-connect array
 *  registrations (id stable across boots) and fully wipes+reseeds the
 *  Pure1 fleet tables with fresh relative timestamps, so a demo box
 *  refreshes on every boot instead of aging into a stale-looking estate.
 *  NEVER runs outside demo mode — see the DASHBOARD_DEMO gate in poller.js. */
function seedPureDemo(coreApi) {
  const db = coreApi.db;
  return db.transaction(() => seedPure(db, { now: Date.now(), encrypt: coreApi.encryption.encrypt }))();
}

module.exports = { seedPure, seedPureDemo, buildArrayList };
