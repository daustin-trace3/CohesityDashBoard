// The tenant the current piece of work belongs to. A web request enters it from
// the URL once the caller's membership is checked; a poller worker enters it
// once at start. Everything that touches the database resolves its handle from
// here (see db/database.js), so code never passes a tenant around by hand.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** Run fn (sync or async) with tenantId as the current tenant. */
function runAsTenant(tenantId, fn) {
  if (typeof tenantId !== 'string' || !tenantId) throw new Error('runAsTenant needs a tenant id');
  return storage.run({ tenantId }, fn);
}

/** Boot only: the rest of this process's start-up, and every timer it
 *  creates, runs as tenantId unless a runAsTenant call says otherwise.
 *  Requests always get an explicit tenant from middleware/tenantScope.js;
 *  timer work that serves every tenant uses tenantRegistry.forEachTenant. */
function enterTenantForBoot(tenantId) {
  storage.enterWith({ tenantId });
}

/** Current tenant id, or null when the caller is outside any tenant. */
function currentTenantId() {
  const store = storage.getStore();
  return store ? store.tenantId : null;
}

module.exports = { runAsTenant, currentTenantId, enterTenantForBoot };
