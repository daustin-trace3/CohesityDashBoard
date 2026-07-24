// Seed the system groups + grants (ported from icc-phase1's core migrations,
// collapsed into one idempotent pass since Fable-dev runs schema.sql instead
// of versioned migrations). Safe to call on every boot: INSERT OR IGNORE.
const db = require('../db/database');

const PLATFORMS = ['cohesity', 'pure', 'netapp', 'zerto', 'vcenter', 'dell'];

function seedRbac() {
  const now = new Date().toISOString();

  const insertGroup = db.prepare(
    'INSERT OR IGNORE INTO groups (name, description, is_system, created_at) VALUES (?, ?, 1, ?)'
  );
  insertGroup.run('Admin', 'Full access to every platform and admin function.', now);
  insertGroup.run('Operator', 'Manage access to platform data (no admin functions).', now);
  insertGroup.run('Viewer', 'Read-only access to platform data.', now);

  const insertGrant = db.prepare(
    'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
  );
  const groupId = (name) => db.prepare('SELECT id FROM groups WHERE name = ?').get(name)?.id;

  const grants = {
    Admin: ['*:*:*'],
    Operator: PLATFORMS.map((p) => `${p}:*:*`),
    Viewer: PLATFORMS.map((p) => `${p}:*:view`),
  };
  for (const [name, perms] of Object.entries(grants)) {
    const id = groupId(name);
    if (!id) continue;
    for (const perm of perms) insertGrant.run('group', id, perm, now);
  }
}

module.exports = { seedRbac };
