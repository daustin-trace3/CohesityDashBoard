/**
 * Exhaustive coverage of the RBAC matcher (contract C8.2): wildcard
 * positions, level hierarchy, group-grant union via resolveGrants against
 * a real temp DB, empty grants, malformed strings, and case sensitivity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { matches, hasPermission, resolveGrants } from '../services/rbac.js';

describe('matches', () => {
  it('matches an identical permission exactly', () => {
    expect(matches('cohesity:clusters:view', 'cohesity:clusters:view')).toBe(true);
  });

  it('does not match a different namespace/section', () => {
    expect(matches('cohesity:clusters:view', 'pure:clusters:view')).toBe(false);
    expect(matches('cohesity:clusters:view', 'cohesity:alerts:view')).toBe(false);
  });

  describe('wildcard in each position', () => {
    it('namespace wildcard', () => {
      expect(matches('*:clusters:view', 'cohesity:clusters:view')).toBe(true);
      expect(matches('*:clusters:view', 'pure:clusters:view')).toBe(true);
      expect(matches('*:clusters:view', 'pure:alerts:view')).toBe(false);
    });

    it('section wildcard', () => {
      expect(matches('cohesity:*:view', 'cohesity:clusters:view')).toBe(true);
      expect(matches('cohesity:*:view', 'cohesity:alerts:view')).toBe(true);
      expect(matches('cohesity:*:view', 'pure:clusters:view')).toBe(false);
    });

    it('level wildcard', () => {
      expect(matches('cohesity:clusters:*', 'cohesity:clusters:view')).toBe(true);
      expect(matches('cohesity:clusters:*', 'cohesity:clusters:manage')).toBe(true);
    });

    it('all wildcards (full admin grant)', () => {
      expect(matches('*:*:*', 'cohesity:clusters:view')).toBe(true);
      expect(matches('*:*:*', 'admin:users:manage')).toBe(true);
    });

    it('combinations of two wildcards', () => {
      expect(matches('*:*:view', 'cohesity:clusters:view')).toBe(true);
      expect(matches('*:*:view', 'cohesity:clusters:manage')).toBe(false);
      expect(matches('*:clusters:*', 'pure:clusters:manage')).toBe(true);
      expect(matches('cohesity:*:*', 'cohesity:anything:manage')).toBe(true);
      expect(matches('cohesity:*:*', 'pure:anything:manage')).toBe(false);
    });
  });

  describe('level hierarchy', () => {
    it('manage grant satisfies a view requirement', () => {
      expect(matches('cohesity:clusters:manage', 'cohesity:clusters:view')).toBe(true);
    });

    it('view grant does NOT satisfy a manage requirement (wrong direction)', () => {
      expect(matches('cohesity:clusters:view', 'cohesity:clusters:manage')).toBe(false);
    });

    it('manage grant satisfies a manage requirement', () => {
      expect(matches('cohesity:clusters:manage', 'cohesity:clusters:manage')).toBe(true);
    });

    it('view grant satisfies a view requirement', () => {
      expect(matches('cohesity:clusters:view', 'cohesity:clusters:view')).toBe(true);
    });

    it('* level satisfies both view and manage', () => {
      expect(matches('cohesity:clusters:*', 'cohesity:clusters:view')).toBe(true);
      expect(matches('cohesity:clusters:*', 'cohesity:clusters:manage')).toBe(true);
    });
  });

  describe('malformed strings deny by default', () => {
    it('grant with wrong segment count', () => {
      expect(matches('cohesity:clusters', 'cohesity:clusters:view')).toBe(false);
      expect(matches('cohesity:clusters:view:extra', 'cohesity:clusters:view')).toBe(false);
      expect(matches('cohesity', 'cohesity:clusters:view')).toBe(false);
    });

    it('required with wrong segment count', () => {
      expect(matches('cohesity:clusters:view', 'cohesity:clusters')).toBe(false);
      expect(matches('cohesity:clusters:view', 'cohesity:clusters:view:extra')).toBe(false);
    });

    it('empty segments', () => {
      expect(matches('cohesity::view', 'cohesity:clusters:view')).toBe(false);
      expect(matches(':clusters:view', 'cohesity:clusters:view')).toBe(false);
      expect(matches('cohesity:clusters:', 'cohesity:clusters:view')).toBe(false);
    });

    it('non-string / null / undefined inputs', () => {
      expect(matches(null, 'cohesity:clusters:view')).toBe(false);
      expect(matches(undefined, 'cohesity:clusters:view')).toBe(false);
      expect(matches('cohesity:clusters:view', null)).toBe(false);
      expect(matches(123, 'cohesity:clusters:view')).toBe(false);
    });

    it('unrecognized level segment (not view/manage/*) never matches a real requirement', () => {
      expect(matches('cohesity:clusters:delete', 'cohesity:clusters:view')).toBe(false);
      expect(matches('cohesity:clusters:delete', 'cohesity:clusters:manage')).toBe(false);
    });
  });

  describe('case sensitivity — exact lowercase match is the chosen behavior', () => {
    it('uppercase namespace does not match lowercase requirement', () => {
      expect(matches('Cohesity:clusters:view', 'cohesity:clusters:view')).toBe(false);
    });

    it('uppercase level does not match lowercase requirement', () => {
      expect(matches('cohesity:clusters:VIEW', 'cohesity:clusters:view')).toBe(false);
      expect(matches('cohesity:clusters:Manage', 'cohesity:clusters:view')).toBe(false);
    });

    it('wildcard is unaffected by case (only segments are compared for equality)', () => {
      expect(matches('*:*:*', 'Cohesity:Clusters:View')).toBe(true);
    });
  });
});

describe('hasPermission', () => {
  it('true when any grant in the list matches', () => {
    const grants = ['pure:*:view', 'cohesity:clusters:manage'];
    expect(hasPermission(grants, 'cohesity:clusters:view')).toBe(true);
  });

  it('false when no grant matches', () => {
    const grants = ['pure:*:view', 'cohesity:alerts:view'];
    expect(hasPermission(grants, 'cohesity:clusters:manage')).toBe(false);
  });

  it('empty grant list denies by default', () => {
    expect(hasPermission([], 'cohesity:clusters:view')).toBe(false);
  });

  it('non-array grant list denies by default', () => {
    expect(hasPermission(null, 'cohesity:clusters:view')).toBe(false);
    expect(hasPermission(undefined, 'cohesity:clusters:view')).toBe(false);
  });
});

describe('resolveGrants (real temp DB)', () => {
  let db;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE user_groups (
        user_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, group_id)
      );
      CREATE TABLE role_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        permission TEXT NOT NULL
      );
    `);

    db.prepare('INSERT INTO users (id) VALUES (1), (2), (3)').run();
    db.prepare("INSERT INTO groups (id, name) VALUES (1, 'Operator'), (2, 'Viewer')").run();

    // user 1 is in Operator; user 2 is in both Operator and Viewer; user 3 has no groups.
    db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (1, 1), (2, 1), (2, 2)').run();

    const grant = db.prepare(
      'INSERT INTO role_grants (subject_type, subject_id, permission) VALUES (?, ?, ?)'
    );
    grant.run('group', 1, 'cohesity:*:manage'); // Operator
    grant.run('group', 2, 'cohesity:*:view'); // Viewer
    grant.run('user', 1, 'admin:settings:view'); // direct grant on user 1
  });

  afterAll(() => db.close());

  it('unions a user\'s direct grants with their group grants', () => {
    const grants = resolveGrants(db, 1);
    expect(grants).toEqual(expect.arrayContaining(['cohesity:*:manage', 'admin:settings:view']));
    expect(grants).toHaveLength(2);
  });

  it('unions grants across multiple groups for the same user', () => {
    const grants = resolveGrants(db, 2);
    expect(grants).toEqual(expect.arrayContaining(['cohesity:*:manage', 'cohesity:*:view']));
    expect(grants).toHaveLength(2);
  });

  it('returns an empty array for a user with no direct or group grants', () => {
    expect(resolveGrants(db, 3)).toEqual([]);
  });

  it('returns an empty array for a nonexistent user id', () => {
    expect(resolveGrants(db, 999)).toEqual([]);
  });

  it('resolved grants work end-to-end with hasPermission', () => {
    const grants = resolveGrants(db, 1);
    expect(hasPermission(grants, 'cohesity:clusters:view')).toBe(true);
    expect(hasPermission(grants, 'admin:settings:view')).toBe(true);
    expect(hasPermission(grants, 'admin:settings:manage')).toBe(false);
    expect(hasPermission(grants, 'pure:clusters:view')).toBe(false);
  });
});
