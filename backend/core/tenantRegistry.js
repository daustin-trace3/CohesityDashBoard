// Tenant list, the global database that holds it, and the pool of open tenant
// database handles. One SQLite file per tenant; the global file holds only what
// spans tenants (docs/MULTI-TENANT-DESIGN.md). A single-tenant install is an
// install whose only tenant is "default", and its file is the one the install
// has always used.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { openTenantDb } = require('../db/openTenantDb');

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
globalDb.prepare("INSERT OR IGNORE INTO tenants (id, name) VALUES (?, 'Default')").run(DEFAULT_TENANT);

const handles = new Map();

function tenantDbPath(tenantId) {
  if (tenantId === DEFAULT_TENANT) return DEFAULT_DB_PATH;
  return path.join(DATA_DIR, 'tenants', tenantId, 'tenant.db');
}

function getTenant(tenantId) {
  return globalDb.prepare('SELECT id, name, status, created_at AS createdAt FROM tenants WHERE id = ?').get(tenantId) || null;
}

function listTenants() {
  return globalDb.prepare('SELECT id, name, status, created_at AS createdAt FROM tenants ORDER BY name').all();
}

/** Open (once) and return the database handle of a tenant that exists. */
function getHandle(tenantId) {
  let handle = handles.get(tenantId);
  if (handle) return handle;
  // The id becomes part of a file path, so it is checked against the tenant
  // list before it is ever joined to one.
  if (!getTenant(tenantId)) throw new Error(`Unknown tenant: ${tenantId}`);
  handle = openTenantDb(tenantDbPath(tenantId));
  handles.set(tenantId, handle);
  return handle;
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
};
