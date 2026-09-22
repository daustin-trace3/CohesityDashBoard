// Tenant list, the global database that holds it, and the pool of open tenant
// database handles. One SQLite file per tenant; the global file holds only what
// spans tenants (docs/MULTI-TENANT-DESIGN.md). A single-tenant install is an
// install whose only tenant is "default", and its file is the one the install
// has always used.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { openTenantDb } = require('../db/openTenantDb');
const { runAsTenant } = require('./tenantContext');

const DEFAULT_TENANT = 'default';
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const DEFAULT_DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(__dirname, '..', 'data', 'cohesity.db');
const DATA_DIR = path.dirname(DEFAULT_DB_PATH);
const GLOBAL_DB_PATH = process.env.DASHBOARD_GLOBAL_DB_PATH || path.join(DATA_DIR, 'global.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const globalDb = new Database(GLOBAL_DB_PATH);
globalDb.exec('PRAGMA journal_mode = WAL');
globalDb.pragma('busy_timeout = 15000');
globalDb.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
globalDb.exec(`
  CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT);
`);
if (!globalDb.prepare("PRAGMA table_info('tenants')").all().some((c) => c.name === 'closed_at')) {
  globalDb.exec('ALTER TABLE tenants ADD COLUMN closed_at TEXT');
}
globalDb.prepare("INSERT OR IGNORE INTO tenants (id, name) VALUES (?, 'Default')").run(DEFAULT_TENANT);

const handles = new Map();

function tenantDbPath(tenantId) {
  if (tenantId === DEFAULT_TENANT) return DEFAULT_DB_PATH;
  return path.join(DATA_DIR, 'tenants', tenantId, 'tenant.db');
}

function getTenant(tenantId) {
  return globalDb.prepare('SELECT id, name, status, created_at AS createdAt, closed_at AS closedAt FROM tenants WHERE id = ?').get(tenantId) || null;
}

function listTenants() {
  return globalDb.prepare('SELECT id, name, status, created_at AS createdAt, closed_at AS closedAt FROM tenants ORDER BY name').all();
}

/** Closes and forgets the open handle of a tenant (close into archive). */
function closeHandle(tenantId) {
  const handle = handles.get(tenantId);
  if (!handle) return;
  handles.delete(tenantId);
  try { handle.close(); } catch { /* already closed */ }
}

/** Open (once) and return the database handle of a tenant that exists. */
function getHandle(tenantId) {
  let handle = handles.get(tenantId);
  if (handle) return handle;
  // The id becomes part of a file path, so it is checked against the tenant
  // list before it is ever joined to one.
  const tenant = getTenant(tenantId);
  if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);
  if (tenant.status === 'closed') throw new Error(`Tenant is closed: ${tenantId}`);
  handle = openTenantDb(tenantDbPath(tenantId));
  handles.set(tenantId, handle);
  // Installed plugin packs bring their own tables; a tenant database opened
  // after boot gets them here (core/registry.js runs them on every tenant
  // that is already open when a pack registers).
  try {
    require('./registry').migrateHandle(handle);
  } catch (err) {
    console.error(`[tenants] pack migrations failed for ${tenantId}: ${err.message}`);
  }
  return handle;
}

/** Open handles right now, for work that must touch every tenant database. */
function openHandles() {
  return Array.from(handles.entries());
}

/** Runs fn once per active tenant, each inside its own tenant context. Used by
 *  timer-driven work (sweeps, notifier, prewarm) that has no request to take
 *  a tenant from. One tenant's failure does not stop the others. */
function forEachTenant(fn) {
  // A poller worker is pinned to one tenant (ICC_TENANT); it never touches
  // the others even for install-wide timers.
  const pinned = process.env.ICC_TENANT || null;
  for (const t of listTenants()) {
    if (t.status !== 'active') continue;
    if (pinned && t.id !== pinned) continue;
    try {
      const out = runAsTenant(t.id, () => fn(t.id));
      if (out && typeof out.catch === 'function') out.catch((err) => console.error(`[tenants] ${t.id}: ${err.message}`));
    } catch (err) {
      console.error(`[tenants] ${t.id}: ${err.message}`);
    }
  }
}

function createTenant({ id, name }) {
  if (typeof id !== 'string' || !TENANT_ID_RE.test(id)) {
    throw new Error('Tenant id must be 3 to 40 characters: lower case letters, digits and hyphens, not starting or ending with a hyphen');
  }
  if (getTenant(id)) throw new Error(`Tenant already exists: ${id}`);
  const label = String(name || '').trim();
  if (!label) throw new Error('Tenant name is required');
  globalDb.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(id, label);
  getHandle(id);
  return getTenant(id);
}

/** With one tenant, work that names no tenant can only mean that tenant. From
 *  the second tenant on it must fail instead of guessing (design decision 17).
 *  TENANT_STRICT=1 forces the strict rule, which is how tests prove it. */
function isStrict() {
  if (process.env.TENANT_STRICT === '1') return true;
  return globalDb.prepare('SELECT COUNT(*) AS n FROM tenants').get().n > 1;
}

module.exports = {
  DEFAULT_TENANT, globalDb, getTenant, listTenants, getHandle, createTenant, isStrict, tenantDbPath,
  forEachTenant, openHandles, closeHandle,
};
