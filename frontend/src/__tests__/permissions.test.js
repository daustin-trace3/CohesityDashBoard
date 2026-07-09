import { describe, it, expect } from 'vitest';
import { matches, hasPermission } from '../auth/permissions';

describe('matches', () => {
  it('matches an exact permission', () => {
    expect(matches('cohesity:alerts:view', 'cohesity:alerts:view')).toBe(true);
  });

  it('rejects a different namespace', () => {
    expect(matches('pure:alerts:view', 'cohesity:alerts:view')).toBe(false);
  });

  it('rejects a different section', () => {
    expect(matches('cohesity:settings:view', 'cohesity:alerts:view')).toBe(false);
  });

  it('wildcard namespace matches any namespace', () => {
    expect(matches('*:alerts:view', 'cohesity:alerts:view')).toBe(true);
    expect(matches('*:alerts:view', 'pure:alerts:view')).toBe(true);
  });

  it('wildcard section matches any section', () => {
    expect(matches('cohesity:*:view', 'cohesity:alerts:view')).toBe(true);
    expect(matches('cohesity:*:view', 'cohesity:settings:view')).toBe(true);
  });

  it('wildcard level matches any level', () => {
    expect(matches('cohesity:alerts:*', 'cohesity:alerts:view')).toBe(true);
    expect(matches('cohesity:alerts:*', 'cohesity:alerts:manage')).toBe(true);
  });

  it('full wildcard (admin) matches everything', () => {
    expect(matches('*:*:*', 'cohesity:alerts:view')).toBe(true);
    expect(matches('*:*:*', 'admin:settings:manage')).toBe(true);
  });

  it('level hierarchy: manage grant satisfies view requirement', () => {
    expect(matches('cohesity:alerts:manage', 'cohesity:alerts:view')).toBe(true);
  });

  it('level hierarchy: view grant does NOT satisfy manage requirement', () => {
    expect(matches('cohesity:alerts:view', 'cohesity:alerts:manage')).toBe(false);
  });

  it('malformed grant (too few segments) returns false', () => {
    expect(matches('cohesity:alerts', 'cohesity:alerts:view')).toBe(false);
  });

  it('malformed grant (too many segments) returns false', () => {
    expect(matches('cohesity:alerts:view:extra', 'cohesity:alerts:view')).toBe(false);
  });

  it('malformed grant (empty segment) returns false', () => {
    expect(matches('cohesity::view', 'cohesity:alerts:view')).toBe(false);
  });

  it('malformed required permission returns false', () => {
    expect(matches('cohesity:alerts:view', 'cohesity:alerts')).toBe(false);
  });

  it('non-string grant returns false', () => {
    expect(matches(null, 'cohesity:alerts:view')).toBe(false);
    expect(matches(undefined, 'cohesity:alerts:view')).toBe(false);
  });

  it('unrecognized level string with no wildcard returns false unless exact match', () => {
    expect(matches('cohesity:alerts:owner', 'cohesity:alerts:view')).toBe(false);
    expect(matches('cohesity:alerts:owner', 'cohesity:alerts:owner')).toBe(true);
  });
});

describe('hasPermission', () => {
  it('returns true when any grant in the list matches', () => {
    const grants = ['pure:*:view', 'cohesity:alerts:manage'];
    expect(hasPermission(grants, 'cohesity:alerts:view')).toBe(true);
  });

  it('returns false when no grant matches', () => {
    const grants = ['pure:*:view', 'netapp:*:view'];
    expect(hasPermission(grants, 'cohesity:alerts:view')).toBe(false);
  });

  it('returns false for an empty grant list (deny by default)', () => {
    expect(hasPermission([], 'cohesity:alerts:view')).toBe(false);
  });

  it('returns false for a non-array grant list', () => {
    expect(hasPermission(null, 'cohesity:alerts:view')).toBe(false);
    expect(hasPermission(undefined, 'cohesity:alerts:view')).toBe(false);
  });

  it('returns false for a malformed required permission', () => {
    expect(hasPermission(['*:*:*'], 'cohesity:alerts')).toBe(false);
  });

  it('group union: admin group wildcard satisfies any platform permission', () => {
    const grants = ['*:*:*'];
    expect(hasPermission(grants, 'netapp:volumes:manage')).toBe(true);
  });

  it('operator group grants satisfy manage on covered namespaces but not admin', () => {
    const grants = ['cohesity:*:*', 'pure:*:*', 'netapp:*:*'];
    expect(hasPermission(grants, 'cohesity:poller:manage')).toBe(true);
    expect(hasPermission(grants, 'admin:settings:view')).toBe(false);
  });

  it('viewer group grants satisfy view but not manage', () => {
    const grants = ['cohesity:*:view', 'pure:*:view', 'netapp:*:view'];
    expect(hasPermission(grants, 'cohesity:alerts:view')).toBe(true);
    expect(hasPermission(grants, 'cohesity:alerts:manage')).toBe(false);
  });
});
