// Tenant lifecycle beyond create (docs/MULTI-TENANT-DESIGN.md, decisions 15
// and 16): the per-tenant audit log, retention of polled history inside a
// live tenant, export on request, close into an archive, restore, and the
// deletion of archives past their own retention.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');
const registry = require('./tenantRegistry');
const { runAsTenant, currentTenantId } = require('./tenantContext');
const accounts = require('./accounts');
const logger = require('../utils/logger');

const ARCHIVE_DIR = path.join(path.dirname(registry.tenantDbPath(registry.DEFAULT_TENANT)), 'archive');
const RETENTION_SETTING = 'tenant_retention_days';
const ARCHIVE_RETENTION_SETTING = 'archive_retention_days';
const ARCHIVE_RETENTION_DEFAULT_DAYS = 365;

// --- per-tenant audit log -------------------------------------------------------

function tdb() { return require('../db/database'); }

function auditTenant(action, { actor = null, detail = null } = {}) {
  try {
    tdb().prepare('INSERT INTO tenant_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), actor ? actor.username : null, action, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  } catch (err) {
    logger.error(`[tenants] tenant audit write failed: ${err.message}`);
  }
}

function listTenantAudit(limit = 200) {
  const cap = Math.min(Math.max(1, Number(limit) || 200), 1000);
  return tdb().prepare('SELECT * FROM tenant_audit ORDER BY id DESC LIMIT ?').all(cap);
}

// --- retention inside a live tenant ----------------------------------------------

// History-style tables and the column that dates a row. Current inventory is
// never aged out; only rows that are history by nature, and only resolved or
// cleared ones where the table tracks state.
const TIME_COLUMNS = ['captured_at', 'resolved_at', 'cleared_at', 'fetched_at', 'finished_at', 'last_updated', 'end_time', 'start_time', 'at', 'created_at', 'timestamp'];
const HISTORY_TABLE = /(_history|_events|_timeline|_log|_runs)$/;
const STATE_FILTER = {
  _issue_history: "status = 'resolved'",
  alerts: 'resolved = 1',
  service_alert_events: 'cleared_at IS NOT NULL',
};

function retentionDays() {
  const { getSetting } = require('../services/settings');
  const n = Number(getSetting(RETENTION_SETTING));
  return n >= 1 && n <= 3650 ? Math.round(n) : 0; // 0 = each platform's own default window
}

/** One pass over the current tenant. Returns { table: deleted } for the log. */
function runRetention() {
  const days = retentionDays();
  if (!days) return null;
  const db = tdb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    .filter((n) => HISTORY_TABLE.test(n) || n in STATE_FILTER)
    .filter((n) => !/^(tenant_audit|schema_migrations|global_)/.test(n));
  const removed = {};
  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const col = TIME_COLUMNS.find((c) => cols.includes(c));
    if (!col) continue;
    const stateKey = Object.keys(STATE_FILTER).find((k) => (k.startsWith('_') ? table.endsWith(k) : table === k));
    const extra = stateKey ? ` AND ${STATE_FILTER[stateKey]}` : '';
    try {
      const n = db.prepare(`DELETE FROM ${table} WHERE ${col} IS NOT NULL AND ${col} < datetime('now', '-${days} days')${extra}`).run().changes;
      if (n) removed[table] = n;
    } catch (err) {
      logger.warn(`[retention] ${table}: ${err.message}`);
    }
  }
  if (Object.keys(removed).length) auditTenant('retention.run', { detail: { days, removed } });
  return removed;
}

// --- export ------------------------------------------------------------------------

// Columns and setting keys that never leave the install.
const SECRET_COLUMNS = ['encrypted_credentials', 'api_key', 'password_hash', 'key_hash', 'secret'];
const SECRET_SETTING = /(password|api_key|apikey|token|secret|client_secret|license_key)/i;

/** A copy of the tenant database with every stored secret blanked, written
 *  to `dest`. Uses VACUUM INTO so the live file is untouched. */
function copyWithoutSecrets(tenantId, dest) {
  const handle = registry.getHandle(tenantId);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  handle.prepare('VACUUM INTO ?').run(dest);
  const Database = require('better-sqlite3');
  const copy = new Database(dest);
  try {
    for (const { name } of copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      const cols = copy.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
      for (const col of cols) {
        if (SECRET_COLUMNS.includes(col)) copy.prepare(`UPDATE ${name} SET ${col} = '' WHERE ${col} IS NOT NULL`).run();
      }
    }
    try {
      for (const { key } of copy.prepare('SELECT key FROM app_settings').all()) {
        if (SECRET_SETTING.test(key)) copy.prepare("UPDATE app_settings SET value = '' WHERE key = ?").run(key);
      }
    } catch { /* no app_settings */ }
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
}

function csvOf(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

const EXPORT_TABLES = ['clusters', 'cohesity_objects', 'netapp_arrays', 'netapp_volumes', 'pure_arrays', 'pure_volumes', 'vcenter_vcenters', 'vcenter_hosts', 'vcenter_vms', 'dell_ome_instances', 'dell_devices', 'zerto_vpgs', 'zerto_vms', 'brocade_switches', 'unifi_devices', 'bluecat_networks', 'alerts', 'app_service_watch'];

/** Writes <tenant>-export-<stamp>.zip into dir: the database without
 *  secrets plus a CSV per main inventory table. Returns the path. */
async function exportTenant(tenantId, dir, actor = null) {
  if (!registry.getTenant(tenantId)) throw new Error(`Unknown tenant: ${tenantId}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dbCopy = path.join(dir, `${tenantId}-export-${stamp}.db`);
  const zipPath = path.join(dir, `${tenantId}-export-${stamp}.zip`);
  copyWithoutSecrets(tenantId, dbCopy);
  const Database = require('better-sqlite3');
  const copy = new Database(dbCopy, { readonly: true });
  const zip = new yazl.ZipFile();
  try {
    zip.addFile(dbCopy, 'tenant.db');
    for (const table of EXPORT_TABLES) {
      let rows;
      try { rows = copy.prepare(`SELECT * FROM ${table}`).all(); } catch { continue; }
      if (rows.length) zip.addBuffer(Buffer.from(csvOf(rows), 'utf8'), `csv/${table}.csv`);
    }
    zip.addBuffer(Buffer.from(JSON.stringify({ tenant: tenantId, exportedAt: new Date().toISOString(), secretsRemoved: true }, null, 2)), 'export.json');
    zip.end();
    await new Promise((resolve, reject) => {
      zip.outputStream.pipe(fs.createWriteStream(zipPath)).on('close', resolve).on('error', reject);
    });
  } finally {
    copy.close();
    try { fs.unlinkSync(dbCopy); } catch { /* best effort */ }
  }
  accounts.audit('tenant.exported', { actor, tenantId, detail: { file: path.basename(zipPath) } });
  runAsTenant(tenantId, () => auditTenant('tenant.exported', { actor, detail: { file: path.basename(zipPath) } }));
  return zipPath;
}

// --- close into an archive, restore, archive retention -----------------------------

function masterKey() {
  return Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
}

/** AES-256-GCM with the install's master key: iv | tag | ciphertext. */
function sealFile(src, dest) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const body = Buffer.concat([cipher.update(fs.readFileSync(src)), cipher.final()]);
  fs.writeFileSync(dest, Buffer.concat([iv, cipher.getAuthTag(), body]));
}

function openSealed(src, dest) {
  const buf = fs.readFileSync(src);
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  fs.writeFileSync(dest, Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]));
}

function archivePath(tenantId) {
  return path.join(ARCHIVE_DIR, `${tenantId}.db.sealed`);
}

/** Closes a tenant: status closed, workers stop at the next rescan, the
 *  database is sealed into data/archive/<id>.db.sealed with the master key
 *  and the live file is removed, so the tenant stops costing size and open
 *  handles. Never for the default tenant. */
function closeTenant(tenantId, actor = null) {
  const tenant = registry.getTenant(tenantId);
  if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);
  if (tenantId === registry.DEFAULT_TENANT) throw new Error('The default tenant cannot be closed.');
  if (tenant.status === 'closed') throw new Error('Tenant is already closed.');
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  runAsTenant(tenantId, () => auditTenant('tenant.closed', { actor }));
  const handle = registry.getHandle(tenantId);
  const live = registry.tenantDbPath(tenantId);
  const flat = path.join(ARCHIVE_DIR, `${tenantId}.closing.db`);
  if (fs.existsSync(flat)) fs.unlinkSync(flat);
  handle.prepare('VACUUM INTO ?').run(flat);
  registry.closeHandle(tenantId);
  sealFile(flat, archivePath(tenantId));
  fs.unlinkSync(flat);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(live + suffix); } catch { /* absent */ }
  }
  registry.globalDb.prepare("UPDATE tenants SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), tenantId);
  accounts.audit('tenant.closed', { actor, tenantId, detail: { archive: path.basename(archivePath(tenantId)) } });
  return { archive: archivePath(tenantId) };
}

function restoreTenant(tenantId, actor = null) {
  const tenant = registry.getTenant(tenantId);
  if (!tenant) throw new Error(`Unknown tenant: ${tenantId}`);
  if (tenant.status !== 'closed') throw new Error('Tenant is not closed.');
  const sealed = archivePath(tenantId);
  if (!fs.existsSync(sealed)) throw new Error('The archive for this tenant no longer exists.');
  const live = registry.tenantDbPath(tenantId);
  fs.mkdirSync(path.dirname(live), { recursive: true });
  openSealed(sealed, live);
  registry.globalDb.prepare("UPDATE tenants SET status = 'active', closed_at = NULL WHERE id = ?").run(tenantId);
  fs.unlinkSync(sealed);
  accounts.audit('tenant.restored', { actor, tenantId });
  runAsTenant(tenantId, () => auditTenant('tenant.restored', { actor }));
  return registry.getTenant(tenantId);
}

function archiveRetentionDays() {
  const row = registry.globalDb.prepare('SELECT value FROM global_settings WHERE key = ?').get(ARCHIVE_RETENTION_SETTING);
  const n = Number(row ? row.value : NaN);
  return n >= 1 && n <= 3650 ? Math.round(n) : ARCHIVE_RETENTION_DEFAULT_DAYS;
}

function setArchiveRetentionDays(days) {
  registry.globalDb.prepare('INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(ARCHIVE_RETENTION_SETTING, String(Math.round(Number(days))));
}

/** Deletes archives of tenants closed longer ago than the archive retention
 *  and removes those tenants from the list. Written to the global audit log. */
function purgeArchives(now = Date.now()) {
  const days = archiveRetentionDays();
  const purged = [];
  for (const t of registry.globalDb.prepare("SELECT id, closed_at FROM tenants WHERE status = 'closed'").all()) {
    if (!t.closed_at || now - Date.parse(t.closed_at) < days * 86400000) continue;
    try { fs.unlinkSync(archivePath(t.id)); } catch { /* already gone */ }
    registry.globalDb.prepare('DELETE FROM tenants WHERE id = ?').run(t.id);
    accounts.audit('tenant.purged', { tenantId: t.id, detail: { closedAt: t.closed_at, retentionDays: days } });
    purged.push(t.id);
  }
  return purged;
}

let timer = null;
/** Daily: retention inside every active tenant, then archive purge. */
function initRetention() {
  if (timer) return;
  const tick = () => {
    registry.forEachTenant(() => { const r = runRetention(); if (r && Object.keys(r).length) logger.info(`[retention] ${currentTenantId()}: ${JSON.stringify(r)}`); });
    if (!process.env.ICC_TENANT) {
      try { const p = purgeArchives(); if (p.length) logger.info(`[retention] purged archives: ${p.join(', ')}`); } catch (err) { logger.error(`[retention] archive purge failed: ${err.message}`); }
    }
  };
  timer = setInterval(tick, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 5 * 60 * 1000).unref();
}

module.exports = {
  auditTenant, listTenantAudit, runRetention, retentionDays, RETENTION_SETTING,
  exportTenant, copyWithoutSecrets, closeTenant, restoreTenant, purgeArchives,
  archiveRetentionDays, setArchiveRetentionDays, initRetention, ARCHIVE_DIR,
};
