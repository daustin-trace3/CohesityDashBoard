// Aria Operations poller — one scheduled task per registered instance
// (framework per-source model, like Aria Automation/vCenter/Dell). Every
// section is fetched and stored independently: a failing section returns
// null and the conditional-replace guard below keeps whatever rows are
// already in the DB (null = section unavailable this poll, [] = genuinely
// empty). The poll as a whole only fails — and only then does it throw, so
// the framework marks the instance in error — when token acquisition itself
// fails.
//
// Ported from backend/services/ariaopsPoller.js. db/logger now come from
// coreApi rather than direct host requires.
//
// Module-scoped singleton: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first and needs to reach the same poller instance for
// schedule/cancel/trigger on instance CRUD. getPoller() lazily builds it if
// not yet created, and createAriaOpsPoller() (the manifest.createPoller entry
// point) reuses it if router.js got there first (dell/unifi poller.js pattern).
const api = require('./api');

let pollerInstance = null;

const safeMsg = (e) => api.errMsg(e);

async function safe(label, row, coreApi, fn) {
  try {
    return await fn();
  } catch (err) {
    coreApi.logger.debug(`[AriaOpsPoller] ${row.name}: ${label} failed (skipping): ${safeMsg(err)}`);
    return null;
  }
}

const RESOURCE_KINDS = ['VirtualMachine', 'HostSystem', 'Datastore'];

function resourceIdentifier(r) {
  return r?.identifier != null ? String(r.identifier) : null;
}
function resourceName(r) {
  return r?.resourceKey?.name ?? null;
}
function resourceAdapterKind(r) {
  return r?.resourceKey?.adapterKindKey ?? null;
}
function resourceStatusJson(r) {
  return JSON.stringify({
    resourceStatusStates: r?.resourceStatusStates ?? null,
    resourceHealth: r?.resourceHealth ?? null,
  });
}

async function collect(row, coreApi) {
  // Token acquisition is the only thing allowed to fail the whole poll.
  await api.getToken(row, coreApi);

  const version = await safe('version', row, coreApi, () => api.fetchVersion(row, coreApi));
  const nodeStatus = await safe('node status', row, coreApi, () => api.fetchNodeStatus(row, coreApi));
  const alerts = await safe('alerts', row, coreApi, () => api.fetchAlerts(row, coreApi));

  const resourcesByKind = {};
  for (const kind of RESOURCE_KINDS) {
    resourcesByKind[kind] = await safe(`resources:${kind}`, row, coreApi, () => api.fetchResourcesByKind(row, coreApi, kind));
  }

  let statsById = null;
  const vms = resourcesByKind.VirtualMachine;
  if (vms) {
    const ids = vms.map(resourceIdentifier).filter(Boolean);
    statsById = ids.length ? await safe('latest stats', row, coreApi, () => api.fetchLatestStats(row, coreApi, ids)) : new Map();
  }

  return { version, nodeStatus, resourcesByKind, alerts, statsById };
}

function buildStore(coreApi) {
  const db = coreApi.db;
  return db.transaction((instanceId, data) => {
    const { version, resourcesByKind, alerts, statsById } = data;

    db.prepare(`
      UPDATE ariaops_instances SET version = COALESCE(?, version) WHERE id = ?
    `).run(
      version?.releaseName || version?.apiVersion || version?.humanReadable
        ? String(version.releaseName || version.apiVersion || version.humanReadable) : null,
      instanceId
    );

    for (const [kind, items] of Object.entries(resourcesByKind)) {
      if (items === null) continue; // section unavailable this poll — keep last-good rows
      db.prepare('DELETE FROM ariaops_resources WHERE instance_id = ? AND kind = ?').run(instanceId, kind);
      const stmt = db.prepare(`
        INSERT INTO ariaops_resources (instance_id, resource_id, name, kind, adapter_kind, health,
          status_json, cpu_pct, mem_pct, stats_captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of items) {
        const rid = resourceIdentifier(r);
        const stats = kind === 'VirtualMachine' && statsById ? statsById.get(rid) : null;
        stmt.run(
          instanceId, rid, resourceName(r), kind, resourceAdapterKind(r), r?.resourceHealth ?? null,
          resourceStatusJson(r),
          stats?.cpuPct != null && Number.isFinite(stats.cpuPct) ? stats.cpuPct : null,
          stats?.memPct != null && Number.isFinite(stats.memPct) ? stats.memPct : null,
          stats?.capturedAt != null ? new Date(Number(stats.capturedAt)).toISOString() : null
        );
      }
    }

    if (alerts !== null) {
      const seen = new Set();
      const stmt = db.prepare(`
        INSERT INTO ariaops_alerts (instance_id, alert_id, level, status, resource_name,
          definition_name, impact, started_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, alert_id) DO UPDATE SET
          level = excluded.level, status = excluded.status, resource_name = excluded.resource_name,
          definition_name = excluded.definition_name, impact = excluded.impact,
          started_at_ms = excluded.started_at_ms, updated_at_ms = excluded.updated_at_ms,
          captured_at = CURRENT_TIMESTAMP
      `);
      for (const a of alerts) {
        const alertId = a?.alertId != null ? String(a.alertId) : null;
        if (!alertId) continue;
        seen.add(alertId);
        stmt.run(
          instanceId, alertId, a?.alertLevel ?? null, a?.status ?? null,
          a?.resourceName ?? a?.resourceId ?? null, a?.alertDefinitionName ?? null,
          a?.alertImpact ?? null,
          a?.startTimeUTC != null ? Number(a.startTimeUTC) : null,
          a?.updateTimeUTC != null ? Number(a.updateTimeUTC) : null
        );
      }
      // Only prune when the fetch succeeded — delete alerts no longer reported active.
      const placeholders = [...seen].map(() => '?').join(',');
      if (seen.size) {
        db.prepare(`DELETE FROM ariaops_alerts WHERE instance_id = ? AND alert_id NOT IN (${placeholders})`)
          .run(instanceId, ...seen);
      } else {
        db.prepare('DELETE FROM ariaops_alerts WHERE instance_id = ?').run(instanceId);
      }
    }

    const resAgg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN kind = 'VirtualMachine' THEN 1 ELSE 0 END) AS vms,
        SUM(CASE WHEN health = 'RED' THEN 1 ELSE 0 END) AS red,
        SUM(CASE WHEN health = 'YELLOW' THEN 1 ELSE 0 END) AS yellow
      FROM ariaops_resources WHERE instance_id = ?
    `).get(instanceId);
    const alertAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN level = 'CRITICAL' THEN 1 ELSE 0 END) AS crit
      FROM ariaops_alerts WHERE instance_id = ?
    `).get(instanceId);

    db.prepare(`
      INSERT INTO ariaops_metrics_history (instance_id, resources_total, vms_total,
        resources_red, resources_yellow, alerts_critical, alerts_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(instanceId, resAgg.total, resAgg.vms, resAgg.red, resAgg.yellow, alertAgg.crit, alertAgg.total);
    db.prepare("DELETE FROM ariaops_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
  });
}

async function pollAriaOps(row, coreApi) {
  const db = coreApi.db;
  const store = buildStore(coreApi);
  try {
    const data = await collect(row, coreApi);
    store(row.id, data);
    db.prepare(`
      UPDATE ariaops_instances SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(row.id);
    const vmCount = (data.resourcesByKind.VirtualMachine || []).length;
    coreApi.logger.info(`[AriaOpsPoller] ${row.name}: ${vmCount} VM resource(s), ${(data.alerts || []).length} active alert(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE ariaops_instances SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), row.id);
    throw err;
  }
}

function buildPoller(coreApi) {
  return coreApi.createPoller({
    id: 'ariaops',
    loadSources: () => coreApi.db.prepare('SELECT * FROM ariaops_instances').all(),
    intervalMinutes: (row) => row.polling_interval_minutes,
    poll: (row) => pollAriaOps(row, coreApi),
  });
}

/** Shared singleton instance poller (schedule/cancel/trigger/init/stopAll),
 *  built lazily on first access regardless of whether createRouter or
 *  manifest.createPoller reaches it first. */
function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js), so demo timestamps
 *  stay relative to boot. Real instances never seed. Returns a handle
 *  mirroring the built-in's createPoller() shape. */
function createAriaOpsPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    const seedDemo = () => {
      try {
        const { seedAriaOpsDemo } = require('./demoSeed');
        const r = seedAriaOpsDemo(coreApi);
        coreApi.logger.info(`[AriaOpsPoller] demo estate seeded: ${r.instances} instances, ${r.resources} resources, ${r.alerts} alerts`);
        return r;
      } catch (err) {
        coreApi.logger.warn(`[AriaOpsPoller] demo seed failed: ${err.message}`);
        return null;
      }
    };
    seedDemo();
    // Demo instances seed fixtures but NEVER poll them: the seeded vROps
    // hosts are fictitious internal names, but polling them for real would
    // still hammer DNS/connect failures every cycle and eventually flip the
    // pristine demo estate to error state — exactly the failure unifi's demo
    // mode was built to avoid. trigger() re-seeds instead, matching the demo
    // Refresh button semantics.
    return {
      init: () => { coreApi.logger.info('[AriaOpsPoller] demo mode — polling disabled, fixtures only'); return []; },
      stopAll: () => {},
      trigger: () => { seedDemo(); return Promise.resolve(); },
      schedule: () => {},
      cancel: () => {},
      taskCount: () => 0,
    };
  }

  const ariaOpsPoller = getPoller(coreApi);

  return {
    init: () => {
      const sources = ariaOpsPoller.init();
      coreApi.logger.info(`[AriaOpsPoller] Initialized ${sources.length} Aria Operations instance(s)`);
      return sources;
    },
    stopAll: () => ariaOpsPoller.stopAll(),
    trigger: (rowOrId) => {
      const row = typeof rowOrId === 'object' ? rowOrId : coreApi.db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(rowOrId);
      return row ? ariaOpsPoller.trigger(row) : Promise.resolve();
    },
    schedule: (row) => ariaOpsPoller.schedule(row),
    cancel: (id) => ariaOpsPoller.cancel(id),
    taskCount: () => ariaOpsPoller.taskCount(),
  };
}

module.exports = { createAriaOpsPoller, getPoller, pollAriaOps };
