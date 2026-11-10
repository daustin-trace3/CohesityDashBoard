// A caller sees only the platforms it holds a view grant on: the rail flags
// route is open to every signed-in user, and the Ops Monitor tiles and the
// Service Status board drop platforms the caller cannot view.
import { describe, it, expect } from 'vitest';
import { canViewPlatform, canViewAnyOf, filterByGrants, grantsOf, opsLevel, requireOps } from '../services/platformAccess';

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

  it('opsLevel returns manage, view or null', () => {
    expect(opsLevel(['ops:*:manage'])).toBe('manage');
    expect(opsLevel(['ops:*:view'])).toBe('view');
    expect(opsLevel(['*:*:*'])).toBe('manage');
    expect(opsLevel(['*:*:view'])).toBe('view');
    expect(opsLevel(['pure:*:*'])).toBe(null);
    expect(opsLevel(undefined)).toBe(null);
  });

  it('canViewAnyOf is true when any listed platform is viewable', () => {
    expect(canViewAnyOf(['pure:*:view'], ['cohesity', 'pure'])).toBe(true);
    expect(canViewAnyOf(['pure:*:view'], ['cohesity'])).toBe(false);
    expect(canViewAnyOf(['pure:*:view'], [])).toBe(false);
    expect(canViewAnyOf(['*:*:view'], ['x'])).toBe(true);
  });

  it('requireOps passes with the level and answers 403 without it', () => {
    const run = (level, grants) => {
      let status = null; let body = null; let nexted = false;
      const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
      requireOps(level)({ auth: { grants } }, res, () => { nexted = true; });
      return { status, body, nexted };
    };
    expect(run('view', ['ops:*:view']).nexted).toBe(true);
    expect(run('view', ['ops:*:manage']).nexted).toBe(true);
    expect(run('manage', ['ops:*:view'])).toMatchObject({ status: 403, body: { error: 'forbidden', required: 'ops:*:manage' }, nexted: false });
    expect(run('view', ['pure:*:view']).status).toBe(403);
  });
});
