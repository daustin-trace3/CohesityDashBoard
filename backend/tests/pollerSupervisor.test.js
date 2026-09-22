/**
 * Multi-tenant phase 3: one poller worker per active tenant, restarted when it
 * dies, stopped when its tenant is suspended, started for a tenant created
 * after boot. The spawn is faked; nothing forks here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

const require = createRequire(import.meta.url);
const tenants = require('../core/tenantRegistry');
const { createSupervisor } = require('../core/pollerSupervisor');

class FakeChild extends EventEmitter {
  constructor(tenantId) { super(); this.tenantId = tenantId; this.pid = 1000 + Math.floor(Math.random() * 1000); this.killed = false; }
  kill() { this.killed = true; this.emit('exit', null, 'SIGTERM'); }
}

beforeAll(() => {
  tenants.createTenant({ id: 'north', name: 'North' });
  tenants.createTenant({ id: 'south', name: 'South' });
});

describe('poller supervisor', () => {
  it('starts one worker per active tenant and follows the tenant list', async () => {
    const spawned = [];
    const spawn = (script, tenantId) => { const c = new FakeChild(tenantId); spawned.push(c); return c; };
    const sup = createSupervisor({ spawn, rescanMs: 60 * 60 * 1000, isLicensed: () => true });
    const running = sup.run();
    expect(running.workers().sort()).toEqual(['default', 'north', 'south']);
    expect(spawned.map((c) => c.tenantId).sort()).toEqual(['default', 'north', 'south']);

    // A worker that dies is restarted after a delay.
    const north = spawned.find((c) => c.tenantId === 'north');
    north.emit('exit', 1, null);
    expect(running.workers().sort()).toEqual(['default', 'south']);
    await new Promise((r) => setTimeout(r, 5200));
    expect(running.workers().sort()).toEqual(['default', 'north', 'south']);
    expect(spawned.filter((c) => c.tenantId === 'north')).toHaveLength(2);

    // A suspended tenant loses its worker; a new tenant gets one.
    tenants.globalDb.prepare("UPDATE tenants SET status = 'suspended' WHERE id = 'south'").run();
    tenants.createTenant({ id: 'east', name: 'East' });
    running.reconcile();
    expect(running.workers().sort()).toEqual(['default', 'east', 'north']);
    expect(spawned.find((c) => c.tenantId === 'south').killed).toBe(true);

    running.stopAll();
    expect(running.workers()).toEqual([]);
    tenants.globalDb.prepare("UPDATE tenants SET status = 'active' WHERE id = 'south'").run();
  }, 15000);

  it('a pinned worker only ever sees its own tenant in forEachTenant', () => {
    process.env.ICC_TENANT = 'north';
    const seen = [];
    tenants.forEachTenant((id) => seen.push(id));
    delete process.env.ICC_TENANT;
    expect(seen).toEqual(['north']);
    const all = [];
    tenants.forEachTenant((id) => all.push(id));
    expect(all.sort()).toEqual(['default', 'east', 'north', 'south']);
  });
});
