// Pure Storage scope demo data: pure_arrays rows only (Settings -> Direct
// list). The Pure data pages themselves are served from the in-memory
// pure1Fixtures.js fleet — its name list is the single source of truth so
// Settings shows exactly the arrays the fleet pages render.
const { buildArrayNames, getFleet, buildAlerts } = require('../pure1Fixtures');

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

  // Pure1 SaaS: one current-timestamp pure1_metrics_history snapshot so the
  // demo switcher's Pure health bubble shows green (contract C11 — the
  // page data itself flows from pure1Fixtures via the isDemo() branches in
  // routes/pure1.js, not from this table).
  const fleet = getFleet();
  const alerts = buildAlerts();
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
