// Zerto Analytics poller — one account-wide global task (the SaaS API returns
// everything in a handful of calls; there are no per-source connections to
// schedule). Current-state tables are replaced wholesale per poll; an
// account-level snapshot is appended to zerto_metrics_history for trends.
//
// Ported from backend/services/zertoPoller.js.
//
// DEVIATION FROM THE BUILT-IN: the original schedules itself directly via
// core/pollerFramework's createGlobalTask (node-cron on a single task, no
// per-row source). coreApi only exposes the per-source `createPoller`
// (backend/core/coreApi.js), not createGlobalTask, so the account is modeled
// as a single fixed "source" ({ id: 0, name: 'account' }) fed to
// coreApi.createPoller — the same reconcile/schedule/trigger machinery, just
// with exactly one row that never changes. pollerStatus records against
// entity_id 0, matching the built-in's global-task bucket.
//
// Module-scoped singleton: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first and needs to reach the same poller instance for schedule/
// trigger on account-settings PUT. getPoller() lazily builds it if not yet
// created (dell poller.js pattern).
const api = require('./api');

const ACCOUNT_SOURCE = { id: 0, name: 'account' };

let pollerInstance = null;

const replaceSites = (db) => db.transaction((sites) => {
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
      JSON.stringify((s.zorgs || []).map((z) => z.name).filter(Boolean))
    );
  }
  for (const row of db.prepare('SELECT id, site_identifier FROM zerto_sites').all()) {
    if (!keep.has(row.site_identifier)) db.prepare('DELETE FROM zerto_sites WHERE id = ?').run(row.id);
  }
});

const replaceVpgs = (db) => db.transaction((vpgs) => {
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

const replaceAlerts = (db) => db.transaction((alerts) => {
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

const replaceVms = (db) => db.transaction((vms) => {
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
      JSON.stringify(vpgs.map((v) => v.name).filter(Boolean)),
      JSON.stringify(vpgs.map((v) => v.status).filter(Boolean)),
      vpgs[0]?.protectedSite?.name || null, vpgs[0]?.recoverySite?.name || null,
      vm.zorg?.name || null
    );
  }
});

const replaceVras = (db) => db.transaction((topology) => {
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

const replaceLicenses = (db) => db.transaction((licenses) => {
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

function appendSnapshot(db, { sites, vpgData, alerts, vms }) {
  const vpgs = vpgData.vpgs || [];
  const rpoVals = vpgs.map((v) => v.actualRpo).filter((v) => typeof v === 'number' && v >= 0);
  db.prepare(`
    INSERT INTO zerto_metrics_history (sites_count, connected_sites_count,
      vpgs_count, healthy_vpgs, warned_vpgs, erroneous_vpgs, vms_count,
      alerts_count, avg_actual_rpo, provisioned_storage_mb, used_storage_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sites.length,
    sites.filter((s) => s.connectionStatus === 'Connected' || s.isConnected).length,
    vpgs.length,
    vpgData.healthyVpgsCount ?? vpgs.filter((v) => v.health === 'Healthy').length,
    vpgData.warnedVpgsCount ?? vpgs.filter((v) => v.health === 'Warning').length,
    vpgData.erroneousVpgsCount ?? vpgs.filter((v) => v.health === 'Error').length,
    vms.length,
    alerts.length,
    rpoVals.length ? rpoVals.reduce((a, b) => a + b, 0) / rpoVals.length : null,
    vms.reduce((n, v) => n + (v.provisionedStorageMb || 0), 0),
    vms.reduce((n, v) => n + (v.usedStorageMb || 0), 0)
  );
  db.prepare("DELETE FROM zerto_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
}

async function refreshAll(coreApi) {
  const db = coreApi.db;
  const logger = coreApi.logger;
  if (!api.zertoConfigured(coreApi)) {
    logger.debug('[ZertoPoller] Skipping poll — credentials not configured');
    return;
  }
  const [sites, vpgData, alerts, vms, topology, licenses] = await Promise.all([
    api.fetchSites(coreApi), api.fetchVpgs(coreApi), api.fetchAlerts(coreApi), api.fetchProtectedVms(coreApi),
    // null (not []) on failure — keep previous rows instead of wiping VRAs/licenses.
    api.fetchSitesTopology(coreApi).catch((err) => { logger.warn(`[ZertoPoller] topology fetch failed, keeping existing VRA rows: ${err.message}`); return null; }),
    api.fetchLicenses(coreApi).catch(() => null), // v3 endpoint — keep previous rows if it fails
  ]);
  replaceSites(db)(sites);
  replaceVpgs(db)(vpgData.vpgs || []);
  replaceAlerts(db)(alerts);
  replaceVms(db)(vms);
  if (topology) replaceVras(db)(topology);
  if (licenses) replaceLicenses(db)(licenses);
  appendSnapshot(db, { sites, vpgData, alerts, vms });
  logger.info(`[ZertoPoller] Refreshed ${sites.length} site(s), ${(vpgData.vpgs || []).length} VPG(s), ${alerts.length} alert(s), ${vms.length} VM(s)`);
}

function buildPoller(coreApi) {
  return coreApi.createPoller({
    id: 'zerto',
    loadSources: () => [ACCOUNT_SOURCE],
    intervalMinutes: () => Number(coreApi.settings.getSetting('zerto_poll_interval_minutes')) || 15,
    poll: () => refreshAll(coreApi),
  });
}

/** Shared singleton poller instance, built lazily on first access regardless
 *  of whether createRouter or manifest.createPoller reaches it first. */
function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js), so demo timestamps
 *  stay relative to boot. Real instances never seed. Returns a handle
 *  mirroring the built-in's createPoller() shape. */
function createZertoPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    const seedDemo = () => {
      try {
        const { seedZertoDemo } = require('./demoSeed');
        const r = seedZertoDemo(coreApi);
        coreApi.logger.info(`[ZertoPoller] demo estate seeded: ${r.sites} sites, ${r.vpgs} VPGs, ${r.vms} VMs, ${r.alerts} alerts`);
        return r;
      } catch (err) {
        coreApi.logger.warn(`[ZertoPoller] demo seed failed: ${err.message}`);
        return null;
      }
    };
    seedDemo();
    // Demo instances seed fixtures but NEVER poll them: the seeded myZerto
    // credential is fictitious, but polling for real would just fail every
    // cycle and eventually flip the pristine demo estate to error state.
    // trigger() re-seeds instead, matching the demo Refresh button semantics.
    return {
      init: () => { coreApi.logger.info('[ZertoPoller] demo mode — polling disabled, fixtures only'); return []; },
      stopAll: () => {},
      trigger: () => { seedDemo(); return Promise.resolve(); },
      schedule: () => {},
      cancel: () => {},
      taskCount: () => 0,
    };
  }

  const zertoPoller = getPoller(coreApi);

  return {
    init: () => {
      const sources = zertoPoller.init();
      coreApi.logger.info('[ZertoPoller] Initialized');
      return sources;
    },
    stopAll: () => zertoPoller.stopAll(),
    trigger: () => zertoPoller.trigger(ACCOUNT_SOURCE),
    schedule: () => zertoPoller.schedule(ACCOUNT_SOURCE),
    cancel: () => zertoPoller.cancel(ACCOUNT_SOURCE.id),
    taskCount: () => zertoPoller.taskCount(),
  };
}

module.exports = { createZertoPoller, getPoller, refreshAll, ACCOUNT_SOURCE };
