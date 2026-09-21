/**
 * Multi-tenant spike (docs/MULTI-TENANT-DESIGN.md): one database file per
 * tenant behind the shared db module, tenant resolved per call, no fallback to
 * some tenant's data once a second tenant exists.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const registry = require('../core/tenantRegistry');
const { runAsTenant, currentTenantId } = require('../core/tenantContext');
const pollerStatus = require('../services/pollerStatus');
const { setSetting, getSetting } = require('../services/settings');

const insertCluster = (name) => db.prepare(`
  INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
  VALUES (?, '10.0.0.1', 'direct', 'userpass', 'enc')
`).run(name);
const clusterNames = () => db.prepare('SELECT name FROM clusters ORDER BY name').all().map((r) => r.name);

// Defined once at load, the way 102 places in the services do it.
const renameAll = db.transaction((suffix) => {
  for (const row of db.prepare('SELECT id, name FROM clusters').all()) {
    db.prepare('UPDATE clusters SET name = ? WHERE id = ?').run(`${row.name}${suffix}`, row.id);
  }
});

beforeAll(() => {
  // Still one tenant here, so work that names no tenant means the default one.
  insertCluster('default-only');
  registry.createTenant({ id: 'acme', name: 'Acme Corp' });
  registry.createTenant({ id: 'globex', name: 'Globex' });
});

describe('tenant registry', () => {
  it('lists the default tenant and the created ones, each with its own file', () => {
    expect(registry.listTenants().map((t) => t.id).sort()).toEqual(['acme', 'default', 'globex']);
    const paths = ['default', 'acme', 'globex'].map(registry.tenantDbPath);
    expect(new Set(paths).size).toBe(3);
  });

  it('refuses ids that are not plain slugs, duplicates, and unknown tenants', () => {
    for (const id of ['../evil', 'A', 'has space', 'x', '-lead', 'trail-', 'default']) {
      expect(() => registry.createTenant({ id, name: 'x' })).toThrow();
    }
    expect(() => registry.getHandle('../../etc')).toThrow(/Unknown tenant/);
    expect(() => runAsTenant('nobody', () => db.prepare('SELECT 1').get())).toThrow(/Unknown tenant/);
  });
});

describe('data stays in its tenant', () => {
  it('rows written in one tenant are invisible to the others', () => {
    runAsTenant('acme', () => insertCluster('acme-cluster'));
    runAsTenant('globex', () => insertCluster('globex-cluster'));

    expect(runAsTenant('acme', clusterNames)).toEqual(['acme-cluster']);
    expect(runAsTenant('globex', clusterNames)).toEqual(['globex-cluster']);
    expect(runAsTenant('default', clusterNames)).toEqual(['default-only']);
  });

  it('settings and poller status are per tenant too', () => {
    runAsTenant('acme', () => { setSetting('dns_server', '10.1.1.1'); pollerStatus.markEnd('netapp', 7, 'error'); });
    runAsTenant('globex', () => { setSetting('dns_server', '10.2.2.2'); });

    expect(runAsTenant('acme', () => getSetting('dns_server'))).toBe('10.1.1.1');
    expect(runAsTenant('globex', () => getSetting('dns_server'))).toBe('10.2.2.2');
    expect(runAsTenant('acme', () => pollerStatus.getState('netapp', 7).lastPollStatus)).toBe('error');
    expect(runAsTenant('globex', () => pollerStatus.getState('netapp', 7).lastPollStatus)).toBe(null);
  });

  it('a transaction defined at load runs against the tenant that calls it', () => {
    runAsTenant('acme', () => renameAll('-a'));
    expect(runAsTenant('acme', clusterNames)).toEqual(['acme-cluster-a']);
    expect(runAsTenant('globex', clusterNames)).toEqual(['globex-cluster']);

    runAsTenant('globex', () => renameAll.immediate('-g'));
    expect(runAsTenant('globex', clusterNames)).toEqual(['globex-cluster-g']);
    expect(runAsTenant('acme', clusterNames)).toEqual(['acme-cluster-a']);
  });

  it('a transaction that throws rolls back only its own tenant', () => {
    const boom = db.transaction(() => { insertCluster('half-written'); throw new Error('stop'); });
    expect(() => runAsTenant('acme', boom)).toThrow('stop');
    expect(runAsTenant('acme', clusterNames)).toEqual(['acme-cluster-a']);
  });

  it('the tenant follows the work across awaits, timers and interleaving', async () => {
    const seen = await Promise.all(['acme', 'globex', 'acme', 'default'].map((id, i) => runAsTenant(id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5 * (4 - i)));
      await Promise.resolve();
      return `${currentTenantId()}:${clusterNames().join(',')}`;
    })));
    expect(seen).toEqual([
      'acme:acme-cluster-a', 'globex:globex-cluster-g', 'acme:acme-cluster-a', 'default:default-only',
    ]);
  });
});

describe('work that names no tenant', () => {
  it('fails once the install has more than one tenant, and never reads the default tenant', () => {
    expect(registry.isStrict()).toBe(true);
    expect(currentTenantId()).toBe(null);
    expect(() => clusterNames()).toThrow(/outside a tenant context/);
    expect(() => renameAll('-x')).toThrow(/outside a tenant context/);
    expect(() => pollerStatus.getAll()).toThrow(/outside a tenant context/);
    expect(runAsTenant('default', clusterNames)).toEqual(['default-only']);
  });
});
