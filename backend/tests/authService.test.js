/**
 * authService (contract C8.3): argon2id hash/verify round trip, hand-rolled
 * session lifecycle (create/validate/expiry/destroy/sliding refresh — time
 * is simulated by writing expires_at directly into the DB), and the
 * first-run claim token's visibility while the users table is empty.
 *
 * Runs against the real temp DB from tests/setup.js (each test file gets
 * its own process per vitest.config.mjs, so authService's module-level
 * claim-token state is fresh here).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import db from '../db/database.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
  pruneExpired,
  getClaimToken,
} from '../services/authService.js';

function insertUser(username) {
  const now = new Date().toISOString();
  const info = db
    .prepare(`
      INSERT INTO users (username, password_hash, display_name, created_at, updated_at)
      VALUES (?, 'placeholder-hash', ?, ?, ?)
    `)
    .run(username, username, now, now);
  return info.lastInsertRowid;
}

describe('claim token — before any user exists', () => {
  it('is a 32-char (16-byte) hex string while the users table is empty', () => {
    const token = getClaimToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns the SAME token on repeated calls (generated once per process)', () => {
    const a = getClaimToken();
    const b = getClaimToken();
    expect(a).toBe(b);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round trips correctly', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });

  it('rejects a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
  });
});

describe('session lifecycle', () => {
  let userId;

  beforeAll(() => {
    userId = insertUser('session-user');
  });

  it('createSession returns 32-byte hex id and csrf token, persisted to auth_sessions', () => {
    const session = createSession(userId);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    expect(session.csrfToken).toMatch(/^[0-9a-f]{64}$/);

    const row = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(session.id);
    expect(row).toBeTruthy();
    expect(row.user_id).toBe(userId);
    expect(row.csrf_token).toBe(session.csrfToken);
  });

  it('validateSession returns the user + resolved grants + csrf token for a fresh session', () => {
    const session = createSession(userId);
    const result = validateSession(session.id);
    expect(result).not.toBeNull();
    expect(result.user.id).toBe(userId);
    expect(result.user.username).toBe('session-user');
    expect(result.csrfToken).toBe(session.csrfToken);
    expect(Array.isArray(result.grants)).toBe(true);
  });

  it('validateSession returns null for an unknown session id', () => {
    expect(validateSession('0'.repeat(64))).toBeNull();
  });

  it('expired sessions are lazily deleted and validate to null', () => {
    const session = createSession(userId);
    const past = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(past, session.id);

    expect(validateSession(session.id)).toBeNull();
    expect(db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(session.id)).toBeUndefined();
  });

  it('destroySession removes the session; subsequent validate returns null', () => {
    const session = createSession(userId);
    expect(validateSession(session.id)).not.toBeNull();

    destroySession(session.id);

    expect(validateSession(session.id)).toBeNull();
    expect(db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(session.id)).toBeUndefined();
  });

  it('slides expiry forward when less than 6 days remain', () => {
    const session = createSession(userId);
    // 5 days left — inside the <6d refresh window.
    const nearExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(nearExpiry, session.id);

    const before = db.prepare('SELECT expires_at FROM auth_sessions WHERE id = ?').get(session.id);
    expect(before.expires_at).toBe(nearExpiry);

    expect(validateSession(session.id)).not.toBeNull();

    const after = db.prepare('SELECT expires_at FROM auth_sessions WHERE id = ?').get(session.id);
    const remainingMs = new Date(after.expires_at).getTime() - Date.now();
    // Refreshed back out to ~7 days (allow a little slack for test runtime).
    expect(remainingMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
  });

  it('does NOT slide expiry when 6 or more days remain', () => {
    const session = createSession(userId);
    // ~6.5 days left — outside the <6d refresh window.
    const farExpiry = new Date(Date.now() + 6.5 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(farExpiry, session.id);

    expect(validateSession(session.id)).not.toBeNull();

    const after = db.prepare('SELECT expires_at FROM auth_sessions WHERE id = ?').get(session.id);
    expect(after.expires_at).toBe(farExpiry);
  });

  it('validateSession returns null and deletes the session if the user was deactivated', () => {
    const otherUserId = insertUser('to-be-deactivated');
    const session = createSession(otherUserId);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(otherUserId);

    expect(validateSession(session.id)).toBeNull();
    expect(db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(session.id)).toBeUndefined();
  });

  it('pruneExpired removes only expired sessions', () => {
    const live = createSession(userId);
    const dead = createSession(userId);
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(past, dead.id);

    pruneExpired();

    expect(db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(dead.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM auth_sessions WHERE id = ?').get(live.id)).toBeTruthy();
  });
});

describe('claim token — after a user exists', () => {
  it('becomes null once the users table is non-empty', () => {
    expect(getClaimToken()).toBeNull();
  });
});
