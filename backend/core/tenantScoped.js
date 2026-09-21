// In-memory state kept per tenant. Module-level caches of sessions, tokens and
// report data are keyed by row ids or hold one estate's data; both would leak
// across tenants in a shared process, because row ids restart in every tenant
// database. These helpers keep one value per tenant behind the same interface
// the caches already use, so the call sites do not change.
//
//   const sessions = tenantMap();          // Map methods, resolved per call
//   const token = tenantCell(null);        // token.get() / token.set(v)
//
// The tenant is resolved with the same rule as db/database.js: the current
// tenant, else the default tenant while the install has only one, else throw.
const { currentTenantId } = require('./tenantContext');
const registry = require('./tenantRegistry');

function resolveTenantId() {
  const id = currentTenantId();
  if (id) return id;
  if (registry.isStrict()) {
    throw new Error('Database or tenant state used outside a tenant context. Wrap the work in runAsTenant(tenantId, ...).');
  }
  return registry.DEFAULT_TENANT;
}

class TenantMap {
  constructor() { this._byTenant = new Map(); }
  _map() {
    const id = resolveTenantId();
    let m = this._byTenant.get(id);
    if (!m) { m = new Map(); this._byTenant.set(id, m); }
    return m;
  }
  get(k) { return this._map().get(k); }
  set(k, v) { this._map().set(k, v); return this; }
  has(k) { return this._map().has(k); }
  delete(k) { return this._map().delete(k); }
  clear() { this._map().clear(); }
  get size() { return this._map().size; }
  keys() { return this._map().keys(); }
  values() { return this._map().values(); }
  entries() { return this._map().entries(); }
  forEach(fn, thisArg) { this._map().forEach(fn, thisArg); }
  [Symbol.iterator]() { return this._map()[Symbol.iterator](); }
}

class TenantSet {
  constructor() { this._byTenant = new Map(); }
  _set() {
    const id = resolveTenantId();
    let s = this._byTenant.get(id);
    if (!s) { s = new Set(); this._byTenant.set(id, s); }
    return s;
  }
  add(v) { this._set().add(v); return this; }
  has(v) { return this._set().has(v); }
  delete(v) { return this._set().delete(v); }
  clear() { this._set().clear(); }
  get size() { return this._set().size; }
  [Symbol.iterator]() { return this._set()[Symbol.iterator](); }
}

class TenantCell {
  constructor(initial) { this._initial = initial; this._byTenant = new Map(); }
  get() {
    const id = resolveTenantId();
    return this._byTenant.has(id) ? this._byTenant.get(id) : this._initial;
  }
  set(v) { this._byTenant.set(resolveTenantId(), v); return v; }
}

module.exports = {
  resolveTenantId,
  tenantMap: () => new TenantMap(),
  tenantSet: () => new TenantSet(),
  tenantCell: (initial = null) => new TenantCell(initial),
};
