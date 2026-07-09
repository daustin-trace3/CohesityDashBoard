/**
 * Seam regression: DELETE /api/users/grants must reach the grants handler,
 * not be shadowed by DELETE /api/users/:id matching id='grants' (the :id
 * params are numeric-only for exactly this reason). Uses the x-api-key
 * service lane (full access) to avoid session setup.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const API_KEY = 'test-api-key';
let app, db;

beforeAll(() => {
  db = require('../db/database');
  const { createApp } = require('../app');
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('users router param-shadowing seam', () => {
  it('DELETE /api/users/grants reaches the grants handler (not 404 user-not-found)', async () => {
    const adminGroup = db.prepare("SELECT id FROM groups WHERE name = 'Admin'").get();
    const perm = 'zerto:*:view';
    db.prepare(
      "INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES ('group', ?, ?, ?)"
    ).run(adminGroup.id, perm, new Date().toISOString());

    const res = await request(app)
      .delete('/api/users/grants')
      .set('x-api-key', API_KEY)
      .send({ subjectType: 'group', subjectId: adminGroup.id, permission: perm });

    expect(res.status).toBeLessThan(300);
    const row = db.prepare(
      "SELECT 1 FROM role_grants WHERE subject_type='group' AND subject_id=? AND permission=?"
    ).get(adminGroup.id, perm);
    expect(row).toBeUndefined();
  });

  it('numeric user routes still match (404 for a missing numeric id)', async () => {
    const res = await request(app)
      .delete('/api/users/999999')
      .set('x-api-key', API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found.');
  });
});
