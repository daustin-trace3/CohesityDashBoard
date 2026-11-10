// A caller sees only the platforms it holds a view grant on: the rail flags
// route is open to every signed-in user, and the Ops Monitor tiles and the
// Service Status board drop platforms the caller cannot view.
import { describe, it, expect } from 'vitest';
import { canViewPlatform, filterByGrants, grantsOf } from '../services/platformAccess';

describe('platformAccess', () => {
  it('a whole-platform view grant, a manage grant or a wildcard admits the platform', () => {
    expect(canViewPlatform(['cohesity:*:view'], 'cohesity')).toBe(true);
    expect(canViewPlatform(['cohesity:*:manage'], 'cohesity')).toBe(true);
    expect(canViewPlatform(['cohesity:*:*'], 'cohesity')).toBe(true);
    expect(canViewPlatform(['*:*:view'], 'netapp')).toBe(true);
    expect(canViewPlatform(['*:*:*'], 'f5')).toBe(true);
  });

  it('no grant, a different platform or a single-section grant does not', () => {
    expect(canViewPlatform([], 'cohesity')).toBe(false);
    expect(canViewPlatform(['pure:*:view'], 'cohesity')).toBe(false);
    expect(canViewPlatform(['cohesity:clusters:view'], 'cohesity')).toBe(false);
    expect(canViewPlatform(undefined, 'cohesity')).toBe(false);
  });

  it('filterByGrants keeps only viewable rows and reads the id through idOf', () => {
    const rows = [{ id: 'cohesity' }, { id: 'pure' }, { id: 'netapp' }];
    expect(filterByGrants(rows, ['pure:*:view', 'netapp:*:manage']).map((r) => r.id)).toEqual(['pure', 'netapp']);
    expect(filterByGrants(rows, ['*:*:*']).length).toBe(3);
    expect(filterByGrants(rows, []).length).toBe(0);
    expect(filterByGrants([{ platform: 'pure' }, { platform: 'dell' }], ['dell:*:view'], (r) => r.platform)).toEqual([{ platform: 'dell' }]);
  });

  it('grantsOf reads req.auth.grants and tolerates a missing auth', () => {
    expect(grantsOf({ auth: { grants: ['a:*:view'] } })).toEqual(['a:*:view']);
    expect(grantsOf({})).toEqual([]);
    expect(grantsOf(null)).toEqual([]);
  });
});
