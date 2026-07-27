// Pure Storage scope demo data: pure_arrays rows only (Settings -> Direct
// list). The Pure data pages themselves are served from the in-memory
// pure1Fixtures.js fleet — its name list is the single source of truth so
// Settings shows exactly the arrays the fleet pages render.
const { buildArrayNames, getFleet, buildAlerts } = require('../pure1Fixtures');
const { randInt, rngFor } = require('./core');

function buildArrayList() {
  return buildArrayNames().map((name) => {
    const [site, , env] = name.split('-');
    return { name, site, env: env.replace(/\d+$/, '') };
  });
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
