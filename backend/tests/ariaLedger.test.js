/**
 * Aria deployment ledger: append-only record beside the live tables.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const ledger = require('../services/ariaLedger');

let inst;
beforeEach(() => {
  db.exec('DELETE FROM aria_deployment_resource_ledger; DELETE FROM aria_deployment_ledger; DELETE FROM aria_instances;');
  inst = db.prepare("INSERT INTO aria_instances (name, host, username, encrypted_credentials) VALUES ('led1', 'led1.lab', 'u', 'x')").run().lastInsertRowid;
});

const dep = (id, extra = {}) => ({ id, name: `dep-${id}`, status: 'CREATE_SUCCESSFUL', createdAt: '2026-01-01T00:00:00.000Z', ...extra });
const res = (depId, rid, name) => ({ deploymentId: depId, resourceId: rid, name, type: 'Cloud.vSphere.Machine', state: 'OK', ipAddresses: ['10.0.0.1'] });
const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';
const row = (id) => db.prepare('SELECT * FROM aria_deployment_ledger WHERE instance_id = ? AND deployment_id = ?').get(inst, id);
const rrow = (id, rid) => db.prepare('SELECT * FROM aria_deployment_resource_ledger WHERE instance_id = ? AND deployment_id = ? AND resource_id = ?').get(inst, id, rid);

describe('ariaLedger.recordPoll', () => {
  it('records first/last seen, marks a dropped deployment removed and follows with its resources', () => {
    const r1 = ledger.recordPoll(db, {
      instanceId: inst, nowIso: T1, deployments: [dep('a'), dep('b')], deploymentsCapped: false,
      deploymentResources: [res('a', 'ra', 'a-vm-01'), res('b', 'rb', 'b-vm-01')], resourcesFetchedFor: new Set(['a', 'b']),
    });
    expect(r1).toMatchObject({ inserted: 2, removed: 0, resourcesInserted: 2 });
    expect(row('a')).toMatchObject({ first_seen_at: T1, last_seen_at: T1, removed_at: null, resources_at: T1, resource_count: 1 });

    const r2 = ledger.recordPoll(db, {
      instanceId: inst, nowIso: T2, deployments: [dep('a'), dep('c')], deploymentsCapped: false,
      deploymentResources: [res('a', 'ra', 'a-vm-01'), res('c', 'rc', 'c-vm-01')], resourcesFetchedFor: new Set(['a', 'c']),
    });
    expect(r2).toMatchObject({ inserted: 1, updated: 1, removed: 1 });
    expect(row('a')).toMatchObject({ first_seen_at: T1, last_seen_at: T2, removed_at: null });
    expect(row('b')).toMatchObject({ first_seen_at: T1, last_seen_at: T1, removed_at: T2 });
    expect(row('c')).toMatchObject({ first_seen_at: T2, removed_at: null });
    expect(rrow('b', 'rb').removed_at).toBe(T2);
    expect(rrow('a', 'ra').removed_at).toBeNull();
    expect(rrow('c', 'rc').first_seen_at).toBe(T2);
  });

  it('marks nothing removed when the fetch hit the cap', () => {
    ledger.recordPoll(db, { instanceId: inst, nowIso: T1, deployments: [dep('a'), dep('b')], deploymentsCapped: false });
    const r = ledger.recordPoll(db, { instanceId: inst, nowIso: T2, deployments: [dep('a')], deploymentsCapped: true });
    expect(r.removed).toBe(0);
    expect(row('b').removed_at).toBeNull();
  });

  it('clears removed_at when a deployment returns and keeps first_seen_at and created_at_src', () => {
    ledger.recordPoll(db, { instanceId: inst, nowIso: T1, deployments: [dep('a')], deploymentsCapped: false });
    ledger.recordPoll(db, { instanceId: inst, nowIso: T2, deployments: [], deploymentsCapped: false });
    expect(row('a').removed_at).toBe(T2);
    ledger.recordPoll(db, { instanceId: inst, nowIso: T3, deployments: [dep('a', { createdAt: '2026-05-05T00:00:00.000Z' })], deploymentsCapped: false });
    expect(row('a')).toMatchObject({ first_seen_at: T1, last_seen_at: T3, removed_at: null, created_at_src: '2026-01-01T00:00:00.000Z' });
  });

  it('fills a missing created_at_src later but never overwrites it', () => {
    ledger.recordPoll(db, { instanceId: inst, nowIso: T1, deployments: [dep('a', { createdAt: null })], deploymentsCapped: false });
    expect(row('a').created_at_src).toBeNull();
    ledger.recordPoll(db, { instanceId: inst, nowIso: T2, deployments: [dep('a', { createdAt: '2026-02-02T00:00:00.000Z' })], deploymentsCapped: false });
    expect(row('a').created_at_src).toBe('2026-02-02T00:00:00.000Z');
  });

  it('does not touch resource ledger rows of deployments the resources call did not visit', () => {
    ledger.recordPoll(db, {
      instanceId: inst, nowIso: T1, deployments: [dep('a'), dep('b')], deploymentsCapped: false,
      deploymentResources: [res('a', 'ra', 'a-vm'), res('b', 'rb', 'b-vm')], resourcesFetchedFor: new Set(['a', 'b']),
    });
    ledger.recordPoll(db, {
      instanceId: inst, nowIso: T2, deployments: [dep('a'), dep('b')], deploymentsCapped: false,
      deploymentResources: [res('a', 'ra', 'a-vm')], resourcesFetchedFor: new Set(['a']),
    });
    expect(rrow('b', 'rb').removed_at).toBeNull();
    expect(row('b').resources_at).toBe(T1);
    expect(row('a').resources_at).toBe(T2);
  });
});

describe('ariaLedger.resourceFetchOrder', () => {
  it('puts unresourced deployments newest first, then the oldest resources_at', () => {
    ledger.recordPoll(db, {
      instanceId: inst, nowIso: T1, deployments: [dep('old'), dep('mid')], deploymentsCapped: false,
      deploymentResources: [res('old', 'r1', 'x')], resourcesFetchedFor: new Set(['old']),
    });
    ledger.recordPoll(db, {
      instanceId: inst, nowIso: T2, deployments: [dep('old'), dep('mid')], deploymentsCapped: false,
      deploymentResources: [res('mid', 'r2', 'y')], resourcesFetchedFor: new Set(['mid']),
    });
    // old: resources_at T1, mid: T2. Two brand new deployments with different created dates.
    const order = ledger.resourceFetchOrder(db, inst, [
      dep('mid'), dep('old'),
      dep('new-a', { createdAt: '2026-09-01T00:00:00.000Z' }),
      dep('new-b', { createdAt: '2026-09-20T00:00:00.000Z' }),
    ]);
    expect(order).toEqual(['new-b', 'new-a', 'old', 'mid']);
  });

  it('treats a ledger row with no resources_at as unresourced', () => {
    ledger.recordPoll(db, { instanceId: inst, nowIso: T1, deployments: [dep('a'), dep('b', { createdAt: '2026-08-01T00:00:00.000Z' })], deploymentsCapped: false });
    expect(ledger.resourceFetchOrder(db, inst, [dep('a'), dep('b', { createdAt: '2026-08-01T00:00:00.000Z' })])).toEqual(['b', 'a']);
  });
});

describe('ariaLedger.pruneRemoved', () => {
  const stamp = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  beforeEach(() => {
    const ins = db.prepare(`INSERT INTO aria_deployment_ledger (instance_id, deployment_id, name, first_seen_at, last_seen_at, removed_at) VALUES (?, ?, ?, ?, ?, ?)`);
    ins.run(inst, 'present', 'present', stamp(300), stamp(0), null);
    ins.run(inst, 'old-gone', 'old-gone', stamp(300), stamp(200), stamp(100));
    ins.run(inst, 'new-gone', 'new-gone', stamp(30), stamp(10), stamp(5));
    db.prepare(`INSERT INTO aria_deployment_resource_ledger (instance_id, deployment_id, resource_id, name, first_seen_at, last_seen_at, removed_at) VALUES (?, 'old-gone', 'r', 'v', ?, ?, ?)`).run(inst, stamp(300), stamp(200), stamp(100));
  });

  it('deletes nothing at 0', () => {
    expect(ledger.pruneRemoved(db, 0).deleted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM aria_deployment_ledger').get().c).toBe(3);
  });

  it('deletes only removed rows older than the cutoff, in both tables', () => {
    expect(ledger.pruneRemoved(db, 60).deleted).toBe(2);
    const names = db.prepare('SELECT deployment_id FROM aria_deployment_ledger ORDER BY deployment_id').all().map((r) => r.deployment_id);
    expect(names).toEqual(['new-gone', 'present']);
    expect(db.prepare('SELECT COUNT(*) c FROM aria_deployment_resource_ledger').get().c).toBe(0);
  });
});
