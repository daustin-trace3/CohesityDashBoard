/**
 * Regression coverage for the delete-then-insert poller bug class: a store
 * transaction must not wipe existing inventory when the upstream fetch
 * FAILED (vs. succeeded and legitimately found nothing). See
 * netbackupApplianceApi.fetchHardware / netbackupPoller.storeApplianceHw
 * (the confirmed production instance) and netbackupApi.tolerantList /
 * netbackupPoller.store (the same pattern across the other 7 sections).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const netbackupMigrations = require('../db/migrations/netbackup');
const { encrypt } = require('../services/encryption');
const logger = require('../utils/logger');

beforeAll(() => {
  runMigrations(db, 'netbackup', netbackupMigrations);
});

function insertApplianceConn(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO netbackup_appliance_conns (name, host, port, username, encrypted_credentials,
      ssl_verify, polling_interval_minutes, last_poll_status, last_poll_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'appl-guard',
    overrides.host ?? 'test-appliance-guard.invalid',
    overrides.port ?? 443,
    overrides.username ?? 'admin',
    encrypt(JSON.stringify({ password: 'p@ss' })),
    0, 30,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
  );
  return db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(info.lastInsertRowid);
}

function insertSource(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username,
      encrypted_credentials, ssl_verify, polling_interval_minutes, last_poll_status, last_poll_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'nb-guard',
    overrides.source_type ?? 'primary',
    overrides.host ?? 'test-netbackup-guard.invalid',
    overrides.port ?? 1556,
    overrides.auth_mode ?? 'password',
    overrides.username ?? 'nbadmin',
    encrypt(JSON.stringify({ password: 'p@ss' })),
    0, 15,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
  );
  return db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(info.lastInsertRowid);
}

describe('netbackupPoller.pollApplianceConn — hardware fetch failure vs. genuine empty', () => {
  const netbackupApplianceApi = require('../services/netbackupApplianceApi');
  const { pollApplianceConn } = require('../services/netbackupPoller');
  const origFetchHardware = netbackupApplianceApi.fetchHardware;

  afterEach(() => {
    netbackupApplianceApi.fetchHardware = origFetchHardware;
    vi.restoreAllMocks();
  });

  it('a failed fetch (null) leaves previously-stored rows intact and logs a warning', async () => {
    const conn = insertApplianceConn({ name: 'appl-guard-fail' });
    db.prepare(`
      INSERT INTO netbackup_appliance_hw (conn_id, component_type, component_name, status, state_raw)
      VALUES (?, 'disk', 'Disk Slot 1', 'ok', 'OK')
    `).run(conn.id);

    netbackupApplianceApi.fetchHardware = vi.fn().mockResolvedValue(null);
    const warnSpy = vi.spyOn(logger, 'warn');

    await pollApplianceConn(conn);

    const rows = db.prepare('SELECT * FROM netbackup_appliance_hw WHERE conn_id = ?').all(conn.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].component_name).toBe('Disk Slot 1');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hardware fetch failed'));

    const row = db.prepare('SELECT last_poll_status, last_poll_error FROM netbackup_appliance_conns WHERE id = ?').get(conn.id);
    expect(row.last_poll_status).toBe('error');
    expect(row.last_poll_error).toBeTruthy();
  });

  it('a successful fetch returning [] clears previously-stored rows', async () => {
    const conn = insertApplianceConn({ name: 'appl-guard-empty' });
    db.prepare(`
      INSERT INTO netbackup_appliance_hw (conn_id, component_type, component_name, status, state_raw)
      VALUES (?, 'disk', 'Disk Slot 1', 'ok', 'OK')
    `).run(conn.id);

    netbackupApplianceApi.fetchHardware = vi.fn().mockResolvedValue([]);

    await pollApplianceConn(conn);

    const rows = db.prepare('SELECT * FROM netbackup_appliance_hw WHERE conn_id = ?').all(conn.id);
    expect(rows).toHaveLength(0);

    const row = db.prepare('SELECT last_poll_status FROM netbackup_appliance_conns WHERE id = ?').get(conn.id);
    expect(row.last_poll_status).toBe('success');
  });

  it('a successful fetch with rows replaces the previous rows', async () => {
    const conn = insertApplianceConn({ name: 'appl-guard-replace' });
    db.prepare(`
      INSERT INTO netbackup_appliance_hw (conn_id, component_type, component_name, status, state_raw)
      VALUES (?, 'disk', 'Old Disk', 'ok', 'OK')
    `).run(conn.id);

    netbackupApplianceApi.fetchHardware = vi.fn().mockResolvedValue([
      { componentType: 'psu', componentName: 'PSU 1', status: 'warning', stateRaw: 'Predictive' },
    ]);

    await pollApplianceConn(conn);

    const rows = db.prepare('SELECT * FROM netbackup_appliance_hw WHERE conn_id = ?').all(conn.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].component_name).toBe('PSU 1');

    const row = db.prepare('SELECT last_poll_status FROM netbackup_appliance_conns WHERE id = ?').get(conn.id);
    expect(row.last_poll_status).toBe('success');
  });
});

describe('netbackupPoller.pollSource — main store() skips failed sections, keeps others', () => {
  const netbackupApi = require('../services/netbackupApi');
  const { pollSource } = require('../services/netbackupPoller');
  const FETCH_NAMES = [
    'fetchJobs', 'fetchPolicies', 'fetchStorageUnits', 'fetchDiskPools',
    'fetchMediaServers', 'fetchHosts', 'fetchAlerts', 'fetchSlps',
  ];
  const originals = {};

  beforeAll(() => {
    for (const name of FETCH_NAMES) originals[name] = netbackupApi[name];
  });

  afterEach(() => {
    for (const name of FETCH_NAMES) netbackupApi[name] = originals[name];
    vi.restoreAllMocks();
  });

  function mockAllEmpty() {
    for (const name of FETCH_NAMES) netbackupApi[name] = vi.fn().mockResolvedValue([]);
  }

  it('a failed policies fetch (null) keeps existing policy rows; other sections still update', async () => {
    const source = insertSource({ name: 'nb-guard-policies-fail' });
    db.prepare(`
      INSERT INTO netbackup_policies (source_id, name, policy_type, active)
      VALUES (?, 'existing-policy', 'Standard', 1)
    `).run(source.id);

    mockAllEmpty();
    netbackupApi.fetchPolicies = vi.fn().mockResolvedValue(null);
    netbackupApi.fetchMediaServers = vi.fn().mockResolvedValue([
      { id: 'm1', name: 'media-new', state: 'ACTIVE', version: '11.0' },
    ]);
    const warnSpy = vi.spyOn(logger, 'warn');

    await pollSource(source);

    const policies = db.prepare('SELECT * FROM netbackup_policies WHERE source_id = ?').all(source.id);
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toBe('existing-policy');

    const mediaServers = db.prepare('SELECT * FROM netbackup_media_servers WHERE source_id = ?').all(source.id);
    expect(mediaServers).toHaveLength(1);
    expect(mediaServers[0].name).toBe('media-new');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('policies fetch failed'));

    const row = db.prepare('SELECT last_poll_status FROM netbackup_sources WHERE id = ?').get(source.id);
    expect(row.last_poll_status).toBe('success'); // one failed section must not fail the whole poll
  });

  it('a successful storageUnits fetch returning [] clears previously-stored storage units', async () => {
    const source = insertSource({ name: 'nb-guard-storage-empty' });
    db.prepare(`
      INSERT INTO netbackup_storage_units (source_id, name) VALUES (?, 'old-su')
    `).run(source.id);

    mockAllEmpty();

    await pollSource(source);

    const units = db.prepare('SELECT * FROM netbackup_storage_units WHERE source_id = ?').all(source.id);
    expect(units).toHaveLength(0);
  });
});
