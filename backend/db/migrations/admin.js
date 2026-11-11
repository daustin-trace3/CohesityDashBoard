// Admin scope: every future change to an admin table (users, groups,
// user_groups, role_grants, auth_sessions, service_accounts, app_settings,
// plugins, user_dashboards, directory_sync_log, idp_*, tenant_audit) goes HERE
// and runs on the admin connection (db/adminSplit.js). core.js must never touch
// an admin table again; tests/adminSplit.test.js enforces it.
const logger = require('../../utils/logger');

// System groups that gain a wildcard-platform grant (step 3).
const SYSTEM_WILDCARDS = { Viewer: '*:*:view', Operator: '*:*:manage' };

module.exports = [
  // v1 (2026-11-11): the wildcard namespace `*` no longer covers `admin`
  // (services/rbac.js). Everyone who held a `*:<s>:<l>` grant keeps today's
  // access by receiving the same grant under the literal admin namespace.
  {
    version: 1,
    up(db) {
      const now = new Date().toISOString();

      // 1. role_grants: copy every `*:<section>:<level>` row to `admin:...`.
      // The Viewer and Operator wildcard rows that step 3 writes are not
      // copied, so a second run changes nothing and those groups never
      // receive administration.
      const wild = db.prepare(
        `SELECT rg.subject_type, rg.subject_id, rg.permission, g.name AS group_name, g.is_system
           FROM role_grants rg
           LEFT JOIN groups g ON rg.subject_type = 'group' AND g.id = rg.subject_id
          WHERE rg.permission LIKE '*:%'`
      ).all();
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      let copied = 0;
      for (const r of wild) {
        if (r.is_system && SYSTEM_WILDCARDS[r.group_name] === r.permission) continue;
        const adminPerm = 'admin:' + r.permission.slice(2);
        if (insertGrant.run(r.subject_type, r.subject_id, adminPerm, now).changes) copied += 1;
      }

      // 2. service_accounts: expand `*:<s>:<l>` entries in the JSON list.
      let expanded = 0;
      const accounts = db.prepare('SELECT id, permissions FROM service_accounts').all();
      const updateAccount = db.prepare('UPDATE service_accounts SET permissions = ? WHERE id = ?');
      for (const a of accounts) {
        let list;
        try { list = JSON.parse(a.permissions); } catch { continue; }
        if (!Array.isArray(list)) continue;
        const next = list.slice();
        for (const p of list) {
          if (typeof p !== 'string' || !p.startsWith('*:')) continue;
          const adminPerm = 'admin:' + p.slice(2);
          if (!next.includes(adminPerm)) next.push(adminPerm);
        }
        if (next.length !== list.length) {
          updateAccount.run(JSON.stringify(next), a.id);
          expanded += 1;
        }
      }

      // 3. System Viewer and Operator: read or manage every platform, no admin.
      let seeded = 0;
      const findGroup = db.prepare('SELECT id FROM groups WHERE name = ? AND is_system = 1');
      for (const [name, permission] of Object.entries(SYSTEM_WILDCARDS)) {
        const g = findGroup.get(name);
        if (g && insertGrant.run('group', g.id, permission, now).changes) seeded += 1;
      }

      logger.info(`[admin-migrations] v1: copied ${copied} wildcard grant(s) to admin:, expanded ${expanded} service account(s), seeded ${seeded} system group wildcard(s)`);
    },
  },

  // v2 (2026-11-11): per-user UI preferences (platform switcher style), saved
  // server side so a user sees the same view on every browser.
  {
    version: 2,
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS user_preferences (
        user_id INTEGER PRIMARY KEY,
        prefs_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      )`);
    },
  },
];
