/**
 * Cohesity object inventory, from shapes verified live on 2026-09-21:
 * - the object search lists one protection info per cluster the object is
 *   known to, so only the polled cluster's own entries count
 * - search/protected-objects answers with at most 500 objects and no cookie,
 *   so backup times are fetched per protection group batch
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { localProtectionInfos, fetchProtectedObjectTimes } = require('../services/cohesityApi');

const group = (id) => ({ name: `g-${id}`, id, lastBackupRunStatus: 'Succeeded' });

describe('localProtectionInfos', () => {
  const object = {
    name: 'w499768',
    objectProtectionInfos: [
      { objectId: 2005, clusterId: 1199424065319596, isDeleted: false, protectionGroups: null },
      { objectId: 2987, clusterId: 7810342275594576, isDeleted: false, protectionGroups: [group('7810342275594576:1:4069')] },
      { objectId: 3501514, clusterId: 2010762144462024, isDeleted: true, protectionGroups: [group('2010762144462024:1:7')] },
    ],
  };

  it('the protecting cluster keeps its own entry', () => {
    expect(localProtectionInfos(object, '7810342275594576').map((i) => i.objectId)).toEqual([2987]);
  });

  it('a cluster that only has the source registered does not inherit the other cluster protection', () => {
    expect(localProtectionInfos(object, '1199424065319596')).toEqual([]);
    expect(localProtectionInfos(object, 1199424065319596)).toEqual([]);
  });

  it('an unknown local id, or entries with no clusterId, fall back to the old rule', () => {
    expect(localProtectionInfos(object, null).map((i) => i.objectId)).toEqual([2987]);
    const old = { objectProtectionInfos: [{ objectId: 5, protectionGroups: [group('x')] }] };
    expect(localProtectionInfos(old, '7810342275594576').map((i) => i.objectId)).toEqual([5]);
  });
});

describe('fetchProtectedObjectTimes', () => {
  const snap = (id, usecs) => ({ id, latestSnapshotsInfo: [{ protectionRunStartTimeUsecs: usecs }] });

  it('asks per protection group batch and halves a batch that fills the 500 cap', async () => {
    const calls = [];
    const client = {
      get: async (url) => {
        const ids = decodeURIComponent(url.split('protectionGroupIds=')[1].split('&')[0]).split(',');
        calls.push(ids);
        // Twelve groups: the first batch of ten comes back capped, halves do not.
        if (ids.length === 10) return { data: { objects: Array.from({ length: 500 }, (_, i) => snap(i, 1000000)) } };
        return { data: { objects: ids.map((g) => snap(Number(g.slice(1)) + 1000, 2000000 + Number(g.slice(1)))) } };
      },
    };
    const groupIds = Array.from({ length: 12 }, (_, i) => `g${i}`);
    const times = await fetchProtectedObjectTimes({}, [...groupIds, 'g0'], client);
    expect(calls.map((c) => c.length)).toEqual([10, 2, 5, 5]);
    // The capped answer is discarded; every group is covered by the narrower calls.
    expect(times.size).toBe(12);
    expect(times.get(1000)).toBe(2000);
    expect(times.has(0)).toBe(false);
  });

  it('keeps the newest snapshot when an object comes back twice', async () => {
    const client = { get: async () => ({ data: { objects: [snap(7, 5000000), snap(7, 9000000), snap(8, 0)] } }) };
    const times = await fetchProtectedObjectTimes({}, ['g1'], client);
    expect(times.get(7)).toBe(9000);
    expect(times.has(8)).toBe(false);
  });
});
