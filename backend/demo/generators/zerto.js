// Zerto scope demo data: ZVM sites (3 replicating prd→dr pairs), VRAs per
// site, VPGs with a healthy/warning/error mix (including RPO and journal
// breaches so the Overview breach counters are non-zero), member VMs, active
// alerts, and 30 days of account snapshots for the trends chart. The SaaS
// credential is seeded encrypted so the platform reports "configured".
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

// Protected site → recovery site, matching the C11.2 site scheme.
const SITE_PAIRS = [
  { prd: 'nyc', dr: 'lon' },
  { prd: 'fra', dr: 'sgp' },
  { prd: 'chi', dr: 'dal' },
];
const ZVM_VERSION = '10.0 U3';
const VRA_VERSION = '10.0.30';
const VPG_APPS = ['SQL', 'SAP', 'Exchange', 'Web', 'App', 'File', 'Oracle', 'AD'];

function siteName(site, env) {
  return `${site}-zvm-${env}-01`;
}

function seedZerto(db, { now, encrypt }) {
  const nowIso = new Date(now).toISOString();

  // ── Credential + platform flag (page renders "configured") ──────────────
  const setSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  setSetting.run('platform_zerto_enabled', '1');
  setSetting.run('zerto_username', 'demo@icc.local');
  setSetting.run('zerto_password', encrypt('demo-not-real'));

  // ── Sites ───────────────────────────────────────────────────────────────
  const insertSite = db.prepare(`
    INSERT INTO zerto_sites (site_identifier, name, site_type, version, zvm_ip,
      connection_status, last_connection_time, is_transmission_enabled, zorgs, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sites = [];
  SITE_PAIRS.forEach((pair, pairIdx) => {
    for (const [env, site] of [['prd', pair.prd], ['dr', pair.dr]]) {
      const name = siteName(site, env);
      const rng = rngFor(name);
      // One temporarily disconnected site so the status filter has variety.
      const status = name === 'dal-zvm-dr-01' ? 'TemporaryDisconnected' : 'Connected';
      sites.push({ identifier: `demo-site-${pairIdx}-${env}`, name, site, env, rng, status });
      insertSite.run(
        `demo-site-${pairIdx}-${env}`, name, 'vCenter', ZVM_VERSION,
        `10.${60 + pairIdx * 2 + (env === 'dr' ? 1 : 0)}.0.20`,
        status,
        new Date(now - randInt(rng, 1, 30) * 60000).toISOString(),
        1, JSON.stringify(['ICC Demo Org']), nowIso
      );
    }
  });

  // ── VRAs: 2-4 per site, one degraded ────────────────────────────────────
  const insertVra = db.prepare(`
    INSERT INTO zerto_vras (site_identifier, site_name, name, version, status, progress, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let vraCount = 0;
  for (const site of sites) {
    const count = randInt(site.rng, 2, 4);
    for (let i = 1; i <= count; i++) {
      const degraded = site.name === 'fra-zvm-prd-01' && i === count;
      insertVra.run(
        site.identifier, site.name, `Z-VRA-${site.site}-esx${String(i).padStart(2, '0')}`,
        VRA_VERSION, degraded ? 'Installing' : 'Installed', degraded ? 62 : null, nowIso
      );
      vraCount++;
    }
  }

  // ── VPGs: ~14 per site pair, health mix + breaches ──────────────────────
  const insertVpg = db.prepare(`
    INSERT INTO zerto_vpgs (vpg_identifier, name, vms_count,
      protected_site, protected_site_type, recovery_site, recovery_site_type,
      actual_rpo, configured_rpo, health, status, sub_status,
      actual_journal_history, configured_journal_history, zorg_name, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVm = db.prepare(`
    INSERT INTO zerto_vms (vm_identifier, name, provisioned_storage_mb, used_storage_mb,
      vpg_names, vpg_statuses, protected_site, recovery_site, zorg_name, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const vpgs = [];
  let vmCount = 0;
  SITE_PAIRS.forEach((pair, pairIdx) => {
    const from = siteName(pair.prd, 'prd');
    const to = siteName(pair.dr, 'dr');
    const rng = rngFor(`vpgs-${pair.prd}`);
    const count = randInt(rng, 12, 16);
    for (let i = 1; i <= count; i++) {
      const app = pick(rng, VPG_APPS);
      const name = `${pair.prd.toUpperCase()}-${app}-VPG-${String(i).padStart(2, '0')}`;
      const roll = rng();
      const health = roll < 0.78 ? 'Healthy' : roll < 0.92 ? 'Warning' : 'Error';
      const configuredRpo = pick(rng, [300, 300, 600, 900]);
      // Warnings are mostly RPO breaches; errors sit well past the target.
      const actualRpo = health === 'Healthy'
        ? randInt(rng, 6, 45)
        : health === 'Warning' ? randInt(rng, configuredRpo + 30, configuredRpo * 2) : randInt(rng, configuredRpo * 2, configuredRpo * 6);
      const configuredJournal = 24;
      const journalShort = health !== 'Healthy' && chance(rng, 0.4);
      const status = health === 'Error' ? 'NotMeetingSLA' : health === 'Warning' ? 'HistoryNotMeetingSLA' : 'MeetingSLA';
      const vms = randInt(rng, 1, 8);
      insertVpg.run(
        `demo-vpg-${pairIdx}-${i}`, name, vms, from, 'vCenter', to, 'vCenter',
        actualRpo, configuredRpo, health, status, health === 'Healthy' ? 'None' : 'NeedsAttention',
        journalShort ? randInt(rng, 4, 20) : randInt(rng, 24, 30), configuredJournal,
        'ICC Demo Org', nowIso
      );
      vpgs.push({ name, health, status, from, to, vms });
      for (let v = 1; v <= vms; v++) {
        const provisionedMb = randInt(rng, 40, 800) * 1024;
        insertVm.run(
          `demo-vm-${pairIdx}-${i}-${v}`,
          `${pair.prd}-${app.toLowerCase()}-${String(i).padStart(2, '0')}${String(v).padStart(2, '0')}`,
          provisionedMb, Math.round(provisionedMb * randFloat(rng, 0.35, 0.85, 2)),
          JSON.stringify([name]), JSON.stringify([status]),
          from, to, 'ICC Demo Org', nowIso
        );
        vmCount++;
      }
    }
  });

  // ── Alerts: one per non-healthy VPG plus a couple of site-level ones ────
  const insertAlert = db.prepare(`
    INSERT INTO zerto_alerts (alert_identifier, alert_type, severity, description,
      site_name, entity_type, collection_time, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let alertCount = 0;
  const alertRng = rngFor('zerto-alerts');
  for (const vpg of vpgs) {
    if (vpg.health === 'Healthy') continue;
    const isError = vpg.health === 'Error';
    insertAlert.run(
      `demo-alert-${alertCount}`, isError ? 'VPG0014' : 'VPG0021',
      isError ? 'Error' : 'Warning',
      isError
        ? `VPG ${vpg.name} RPO is not meeting the configured SLA`
        : `VPG ${vpg.name} journal history is below the configured target`,
      vpg.from, 'VPG',
      new Date(now - randInt(alertRng, 1, 48) * 3600000).toISOString(), nowIso
    );
    alertCount++;
  }
  insertAlert.run('demo-alert-site-0', 'ZVM0004', 'Warning',
    'Site dal-zvm-dr-01 has temporarily disconnected from Zerto Analytics',
    'dal-zvm-dr-01', 'Site', new Date(now - 2 * 3600000).toISOString(), nowIso);
  alertCount++;

  // ── Account snapshots: 30 days @ 6h for the trends chart ────────────────
  const insertSnap = db.prepare(`
    INSERT INTO zerto_metrics_history (captured_at, sites_count, connected_sites_count,
      vpgs_count, healthy_vpgs, warned_vpgs, erroneous_vpgs, vms_count, alerts_count,
      avg_actual_rpo, provisioned_storage_mb, used_storage_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const healthy = vpgs.filter(v => v.health === 'Healthy').length;
  const warned = vpgs.filter(v => v.health === 'Warning').length;
  const errored = vpgs.filter(v => v.health === 'Error').length;
  const provisionedMbTotal = db.prepare('SELECT SUM(provisioned_storage_mb) s FROM zerto_vms').get().s;
  const usedMbTotal = db.prepare('SELECT SUM(used_storage_mb) s FROM zerto_vms').get().s;
  const snapRng = rngFor('zerto-snapshots');
  let snapCount = 0;
  for (let i = 30 * 4; i >= 0; i--) {
    const capturedAt = new Date(now - i * 6 * 3600000).toISOString();
    const wiggle = () => randInt(snapRng, -2, 2);
    const growth = (30 * 4 - i) / (30 * 4); // storage grows ~8% over the window
    insertSnap.run(
      capturedAt, sites.length, sites.length - (i < 4 ? 1 : 0),
      vpgs.length, Math.max(0, healthy + wiggle()), Math.max(0, warned + wiggle()), errored,
      vmCount, Math.max(0, alertCount + wiggle()),
      randFloat(snapRng, 15, 60, 1),
      Math.round(provisionedMbTotal * (0.92 + growth * 0.08)),
      Math.round(usedMbTotal * (0.92 + growth * 0.08))
    );
    snapCount++;
  }

  return { sites: sites.length, vras: vraCount, vpgs: vpgs.length, vms: vmCount, alerts: alertCount, snapshots: snapCount };
}

module.exports = { seedZerto };
