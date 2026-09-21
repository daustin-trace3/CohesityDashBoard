// What every module gets from require('../db/database'): an object with the
// surface of a better-sqlite3 handle that always acts on the CURRENT tenant's
// database (core/tenantContext.js). The ~200 files that call db.prepare(...)
// and friends stay as they are.
//
// Rules:
// - The tenant is resolved on every call, never when a module loads.
// - db.transaction(fn) is commonly created once at module load (102 places on
//   2026-09-21). The function it returns resolves the tenant when it RUNS, so a
//   transaction defined once works for whichever tenant is current.
// - Work that names no tenant fails once the install has more than one tenant.
//   It never falls back to some tenant's data.
const { currentTenantId } = require('../core/tenantContext');
const registry = require('../core/tenantRegistry');

function currentHandle() {
  const tenantId = currentTenantId();
  if (tenantId) return registry.getHandle(tenantId);
  if (registry.isStrict()) {
    throw new Error('Database used outside a tenant context. Wrap the work in runAsTenant(tenantId, ...).');
  }
  return registry.getHandle(registry.DEFAULT_TENANT);
}

function tenantTransaction(fn) {
  const perHandle = new WeakMap();
  const resolve = () => {
    const handle = currentHandle();
    let txn = perHandle.get(handle);
    if (!txn) {
      txn = handle.transaction(fn);
      perHandle.set(handle, txn);
    }
    return txn;
  };
  const run = (...args) => resolve()(...args);
  for (const mode of ['default', 'deferred', 'immediate', 'exclusive']) {
    run[mode] = (...args) => resolve()[mode](...args);
  }
  return run;
}

module.exports = new Proxy({}, {
  get(target, prop) {
    if (prop === 'transaction') return tenantTransaction;
    const handle = currentHandle();
    // The real handle of the current tenant, for db/perTenant.js only.
    if (prop === '$handle') return handle;
    const value = handle[prop];
    return typeof value === 'function' ? value.bind(handle) : value;
  },
  set(target, prop, value) {
    currentHandle()[prop] = value;
    return true;
  },
  has(target, prop) {
    return prop in currentHandle();
  },
});
