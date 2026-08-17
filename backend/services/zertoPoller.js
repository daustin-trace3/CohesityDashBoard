// Zerto Analytics poller — one account-wide global task (the SaaS API returns
// everything in a handful of calls; there are no per-source connections to
// schedule). Current-state tables are replaced wholesale per poll; an
// account-level snapshot is appended to zerto_metrics_history for trends.
const db = require('../db/database');
const cron = require('node-cron');
const { createGlobalTask } = require('../core/pollerFramework');
const { getSetting } = require('./settings');
const {
  zertoConfigured, fetchSites, fetchSitesTopology, fetchVpgs, fetchAlerts, fetchProtectedVms,
  fetchLicenses,
} = require('./zertoApi');
const logger = require('../utils/logger');

const replaceSites = db.transaction((sites) => {
  const keep = new Set();
  const upsert = db.prepare(`
    INSERT INTO zerto_sites (site_identifier, name, site_type, version, zvm_ip,
      connection_status, last_connection_time, is_transmission_enabled, zorgs, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(site_identifier) DO UPDATE SET
      name = excluded.name, site_type = excluded.site_type, version = excluded.version,
      zvm_ip = excluded.zvm_ip, connection_status = excluded.connection_status,
      last_connection_time = excluded.last_connection_time,
      is_transmission_enabled = excluded.is_transmission_enabled,
      zorgs = excluded.zorgs, updated_at = datetime('now')
  `);
  for (const s of sites) {
    if (!s.identifier) continue;
    keep.add(s.identifier);
    upsert.run(
      s.identifier, s.name || null, s.type || null, s.vesrion || s.version || null,
      s.zvmpIp || s.zvmIp || null, s.connectionStatus || null, s.lastConnetionTime || s.lastConnectionTime || null,
      s.isTransmissionEnabled ? 1 : 0,
      JSON.stringify((s.zorgs || []).map(z => z.name).filter(Boolean))
    );
  }
  for (const row of db.prepare('SELECT id, site_identifier FROM zerto_sites').all()) {
    if (!keep.has(row.site_identifier)) db.prepare('DELETE FROM zerto_sites WHERE id = ?').run(row.id);
  }
});

const replaceVpgs = db.transaction((vpgs) => {
  db.prepare('DELETE FROM zerto_vpgs').run();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO zerto_vpgs (vpg_identifier, name, vms_count,
      protected_site, protected_site_type, recovery_site, recovery_site_type,
      actual_rpo, configured_rpo, health, status, sub_status,
      actual_journal_history, configured_journal_history, zorg_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of vpgs) {
    if (!v.identifier) continue;
    stmt.run(
      v.identifier, v.name || null, v.vmsCount ?? null,
      v.protectedSite?.name || null, v.protectedSite?.type || null,
      v.recoverySite?.name || null, v.recoverySite?.type || null,
      v.actualRpo ?? null, v.configuredRpo ?? null,
      v.health || null, v.status || null, v.subStatus || null,
      v.actualJournalHistory ?? null, v.configuredJournalHistory ?? null,
      v.zorgName || null
    );
  }
});

const replaceAlerts = db.transaction((alerts) => {
  db.prepare('DELETE FROM zerto_alerts').run();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO zerto_alerts (alert_identifier, alert_type, severity,
      description, site_name, entity_type, collection_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of alerts) {
    if (!a.identifier) continue;
    stmt.run(a.identifier, a.type || null, a.severity || null, a.description || null,
      a.site?.name || null, a.entityType || null, a.collectionTime || null);
  }
  // Keep the per-type notification catalog aware of every code seen live —
  // unknown codes (not in the shipped reference) get inserted enabled.
  const catStmt = db.prepare(`
    INSERT INTO zerto_alert_catalog (alert_type, entity, severity, description, first_seen, last_seen)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(alert_type) DO UPDATE SET
      last_seen = CURRENT_TIMESTAMP,
      first_seen = COALESCE(first_seen, CURRENT_TIMESTAMP)
  `);
  for (const a of alerts) {
    if (a.type) catStmt.run(a.type, a.entityType || null, a.severity || null, a.description || null);
  }
});

const replaceVms = db.transaction((vms) => {
  db.prepare('DELETE FROM zerto_vms').run();
  const stmt = db.prepare(`
    INSERT INTO zerto_vms (vm_identifier, name, provisioned_storage_mb,
      used_storage_mb, vpg_names, vpg_statuses, protected_site, recovery_site, zorg_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const vm of vms) {
    if (!vm.identifier) continue;
    const vpgs = vm.vpgs || [];
    stmt.run(
      vm.identifier, vm.name || null,
      vm.provisionedStorageMb ?? null, vm.usedStorageMb ?? null,
      JSON.stringify(vpgs.map(v => v.name).filter(Boolean)),
      JSON.stringify(vpgs.map(v => v.status).filter(Boolean)),
      vpgs[0]?.protectedSite?.name || null, vpgs[0]?.recoverySite?.name || null,
      vm.zorg?.name || null
    );
  }
});

const replaceVras = db.transaction((topology) => {
  db.prepare('DELETE FROM zerto_vras').run();
  const stmt = db.prepare(`
    INSERT INTO zerto_vras (site_identifier, site_name, name, version, status, progress)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const site of topology) {
    for (const vra of (site.vras || [])) {
      stmt.run(site.identifier || null, site.name || null, vra.name || null,
        vra.version || null, vra.status || null, vra.progress ?? null);
    }
  }
});

const replaceLicenses = db.transaction((licenses) => {
  db.prepare('DELETE FROM zerto_licenses').run();
  const stmt = db.prepare(`
    INSERT INTO zerto_licenses (license_key, license_package, available_vms,
      used_vms, is_shared, expiration_date, alerts, site_usage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const l of licenses) {
    if (!l.licenseKey) continue;
    stmt.run(
      l.licenseKey, l.licensePackage || null,
      l.availableVMsCount ?? null, l.licenseUsage?.usedVMsCount ?? null,
      l.licenseUsage?.isShared ? 1 : 0,
      l.expirationDate || null,
      JSON.stringify(l.alerts || []),
      JSON.stringify(l.siteUsage || [])
    );
  }
});

function appendSnapshot({ sites, vpgData, alerts, vms }) {
  const vpgs = vpgData.vpgs || [];
  const rpoVals = vpgs.map(v => v.actualRpo).filter(v => typeof v === 'number' && v >= 0);
  db.prepare(`
    INSERT INTO zerto_metrics_history (sites_count, connected_sites_count,
      vpgs_count, healthy_vpgs, warned_vpgs, erroneous_vpgs, vms_count,
      alerts_count, avg_actual_rpo, provisioned_storage_mb, used_storage_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sites.length,
    sites.filter(s => s.connectionStatus === 'Connected' || s.isConnected).length,
    vpgs.length,
    vpgData.healthyVpgsCount ?? vpgs.filter(v => v.health === 'Healthy').length,
    vpgData.warnedVpgsCount ?? vpgs.filter(v => v.health === 'Warning').length,
    vpgData.erroneousVpgsCount ?? vpgs.filter(v => v.health === 'Error').length,
    vms.length,
    alerts.length,
    rpoVals.length ? rpoVals.reduce((a, b) => a + b, 0) / rpoVals.length : null,
    vms.reduce((n, v) => n + (v.provisionedStorageMb || 0), 0),
    vms.reduce((n, v) => n + (v.usedStorageMb || 0), 0)
  );
  db.prepare("DELETE FROM zerto_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
}

async function refreshAll() {
  if (!zertoConfigured()) {
    logger.debug('[ZertoPoller] Skipping poll — credentials not configured');
    return;
  }
  const [sites, vpgData, alerts, vms, topology, licenses] = await Promise.all([
    fetchSites(), fetchVpgs(), fetchAlerts(), fetchProtectedVms(),
    fetchSitesTopology().catch(() => []),
    fetchLicenses().catch(() => null), // v3 endpoint — keep previous rows if it fails
  ]);
  replaceSites(sites);
  replaceVpgs(vpgData.vpgs || []);
  replaceAlerts(alerts);
  replaceVms(vms);
  replaceVras(topology);
  if (licenses) replaceLicenses(licenses);
  appendSnapshot({ sites, vpgData, alerts, vms });
  logger.info(`[ZertoPoller] Refreshed ${sites.length} site(s), ${(vpgData.vpgs || []).length} VPG(s), ${alerts.length} alert(s), ${vms.length} VM(s)`);
}

const zertoTask = createGlobalTask({
  id: 'zerto',
  intervalMinutes: () => Number(getSetting('zerto_poll_interval_minutes')) || 15,
  run: refreshAll,
  defaultIntervalMinutes: 15,
  cronLib: cron,
});

function initZertoPoller() {
  if (zertoConfigured()) {
    zertoTask.reschedule();
    setTimeout(() => { zertoTask.trigger(); }, 4000);
  }
  return zertoTask;
}

function stopAll() {
  if (zertoTask.isRunning()) zertoTask.stop();
}

module.exports = { initZertoPoller, refreshAll, zertoTask, stopAll };
