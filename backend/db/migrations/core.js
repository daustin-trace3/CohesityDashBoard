// Core scope: app_settings + the plugin registry's own bookkeeping table.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key                   TEXT PRIMARY KEY,
          value                 TEXT,
          updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS plugins (
          id              TEXT PRIMARY KEY,
          version         TEXT,
          schema_version  INTEGER NOT NULL DEFAULT 0,
          enabled         INTEGER NOT NULL DEFAULT 1,
          status          TEXT NOT NULL DEFAULT 'active',
          error           TEXT,
          installed_at    TEXT,
          updated_at      TEXT
        );
      `);
    },
  },

  // Auth + RBAC (contract C8.1): users/groups/grants/sessions/service accounts,
  // seeded with the three system groups and their default grants. No seed
  // user — the first-run wizard creates the first admin via a claim token.
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash   TEXT NOT NULL,
          display_name    TEXT,
          auth_provider   TEXT NOT NULL DEFAULT 'local',
          is_active       INTEGER NOT NULL DEFAULT 1,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          last_login_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS groups (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT NOT NULL UNIQUE,
          description     TEXT,
          is_system       INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_groups (
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          group_id        INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, group_id)
        );

        CREATE TABLE IF NOT EXISTS role_grants (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          subject_type    TEXT NOT NULL CHECK(subject_type IN ('user','group')),
          subject_id      INTEGER NOT NULL,
          permission      TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          UNIQUE(subject_type, subject_id, permission)
        );

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id              TEXT PRIMARY KEY,
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_token      TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          expires_at      TEXT NOT NULL,
          last_seen_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS service_accounts (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT NOT NULL UNIQUE,
          key_hash        TEXT NOT NULL,
          key_prefix      TEXT NOT NULL,
          permissions     TEXT NOT NULL,
          is_active       INTEGER NOT NULL DEFAULT 1,
          created_at      TEXT NOT NULL,
          last_used_at    TEXT
        );
      `);

      const now = new Date().toISOString();

      const insertGroup = db.prepare(
        'INSERT OR IGNORE INTO groups (name, description, is_system, created_at) VALUES (?, ?, 1, ?)'
      );
      const seedGroups = {
        Admin: 'Full access to every platform and admin function.',
        Operator: 'Manage access to platform data (no admin functions).',
        Viewer: 'Read-only access to platform data.',
      };
      for (const [name, description] of Object.entries(seedGroups)) {
        insertGroup.run(name, description, now);
      }

      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const seedGrants = {
        Admin: ['*:*:*'],
        Operator: ['cohesity:*:*', 'pure:*:*', 'netapp:*:*'],
        Viewer: ['cohesity:*:view', 'pure:*:view', 'netapp:*:view'],
      };
      for (const [groupName, permissions] of Object.entries(seedGrants)) {
        const groupId = getGroupId.get(groupName).id;
        for (const permission of permissions) {
          insertGrant.run('group', groupId, permission, now);
        }
      }
    },
  },

  // SMTP alert notifications (contract C10.3): tracks which active alerts
  // have already been emailed, and when, so we send once per new alert plus
  // periodic reminders instead of re-sending every poll.
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alert_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          source_key TEXT NOT NULL,
          severity TEXT NOT NULL,
          notify_count INTEGER NOT NULL DEFAULT 1,
          first_notified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_notified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source, source_key)
        );
      `);
    },
  },
  // Zerto platform grants for the seeded Operator/Viewer groups (Admin's
  // *:*:* already covers it). Mirrors the v2 seed's intent: Operator manages
  // every platform, Viewer views every platform.
  {
    version: 4,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'zerto:*:*', Viewer: 'zerto:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
  // vCenter platform grants — same shape as v4.
  {
    version: 5,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'vcenter:*:*', Viewer: 'vcenter:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
  // Dell OME platform grants — same shape as v4/v5.
  {
    version: 6,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'ome:*:*', Viewer: 'ome:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
  // v6 granted Dell under namespace 'ome', but the plugin id (and therefore
  // the namespace the middleware enforces) is 'dell' — those grants matched
  // nothing, so Operator/Viewer members couldn't see the Dell platform.
  {
    version: 7,
    up(db) {
      db.prepare(
        "UPDATE OR IGNORE role_grants SET permission = replace(permission, 'ome:', 'dell:') WHERE permission LIKE 'ome:%'"
      ).run();
      // Any leftovers were duplicates of an existing dell:* grant.
      db.prepare("DELETE FROM role_grants WHERE permission LIKE 'ome:%'").run();
    },
  },
  // Aria Automation platform grants — same shape as v4/v5.
  {
    version: 8,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'aria:*:*', Viewer: 'aria:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
  // Persistent AI audit trail (was in-memory, last 20, cleared on restart).
  // Rows are pruned after 30 days by services/aiAudit.js on insert.
  {
    version: 9,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_audit_exchanges (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          platform      TEXT NOT NULL DEFAULT 'cohesity',
          feature       TEXT,
          label         TEXT,
          model         TEXT,
          sent_at       TEXT NOT NULL,
          messages      TEXT NOT NULL,
          mappings      TEXT NOT NULL DEFAULT '[]',
          mapped_count  INTEGER NOT NULL DEFAULT 0,
          response      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_audit_platform_sent
          ON ai_audit_exchanges (platform, sent_at DESC);
      `);
    },
  },
  // Aria Operations platform grants — same shape as v8's Aria Automation grants.
  {
    version: 10,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'ariaops:*:*', Viewer: 'ariaops:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
];
