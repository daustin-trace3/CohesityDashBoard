// One poller worker process per tenant (docs/MULTI-TENANT-DESIGN.md, decision
// 13). The supervisor keeps a child running for every active tenant, restarts
// one that exits (with a growing delay), stops the child of a tenant that is
// suspended or removed, and starts a child for a tenant created after boot.
// A child is this same pollerProcess.js started with ICC_TENANT=<id>; inside
// it every timer and poller runs for that tenant only.
const path = require('path');
const { fork } = require('child_process');
const logger = require('../utils/logger');
const tenants = require('./tenantRegistry');

const RESCAN_MS = 60 * 1000;
const RESTART_MIN_MS = 5 * 1000;
const RESTART_MAX_MS = 5 * 60 * 1000;

function createSupervisor({ spawn = defaultSpawn, script = path.join(__dirname, '..', 'pollerProcess.js'), rescanMs = RESCAN_MS } = {}) {
  const workers = new Map(); // tenantId -> { child, restarts, timer }
  let timer = null;
  let stopped = false;

  function wanted() {
    return tenants.listTenants().filter((t) => t.status === 'active').map((t) => t.id);
  }

  function start(tenantId) {
    if (stopped || workers.has(tenantId)) return;
    const child = spawn(script, tenantId);
    const entry = { child, restarts: 0, timer: null };
    workers.set(tenantId, entry);
    logger.info(`[Poller supervisor] Started worker for tenant ${tenantId} (pid ${child.pid || '?'})`);
    child.on('exit', (code, signal) => {
      if (workers.get(tenantId) !== entry) return;
      workers.delete(tenantId);
      if (stopped || !wanted().includes(tenantId)) return;
      entry.restarts += 1;
      const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** (entry.restarts - 1));
      logger.warn(`[Poller supervisor] Worker for tenant ${tenantId} exited (${signal || code}); restarting in ${Math.round(delay / 1000)}s`);
      const t = setTimeout(() => {
        start(tenantId);
        const again = workers.get(tenantId);
        if (again) again.restarts = entry.restarts;
      }, delay);
      if (t.unref) t.unref();
    });
  }

  function stop(tenantId) {
    const entry = workers.get(tenantId);
    if (!entry) return;
    workers.delete(tenantId);
    logger.info(`[Poller supervisor] Stopping worker for tenant ${tenantId}`);
    try { entry.child.kill(); } catch { /* already gone */ }
  }

  function reconcile() {
    const want = new Set(wanted());
    for (const id of want) if (!workers.has(id)) start(id);
    for (const id of [...workers.keys()]) if (!want.has(id)) stop(id);
  }

  function run() {
    reconcile();
    timer = setInterval(reconcile, rescanMs);
    return { stopAll, workers: () => [...workers.keys()], reconcile };
  }

  function stopAll() {
    stopped = true;
    if (timer) clearInterval(timer);
    for (const id of [...workers.keys()]) stop(id);
  }

  return { run, reconcile, stopAll, workers: () => [...workers.keys()] };
}

function defaultSpawn(script, tenantId) {
  return fork(script, [], {
    env: { ...process.env, ICC_TENANT: tenantId },
    stdio: 'inherit',
  });
}

module.exports = { createSupervisor };
