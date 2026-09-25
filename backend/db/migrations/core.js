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
  // NetBackup platform grants — same shape as v8/v10.
  {
    version: 11,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'netbackup:*:*', Viewer: 'netbackup:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
  // Custom dashboards (phase 2): per-owner saved dashboards, widgets as a
  // JSON array of { title, datasetId, chartType, query } referencing the
  // dataset catalog. Private-only in this phase — no sharing columns yet.
  {
    version: 12,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_dashboards (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          owner      TEXT NOT NULL,
          name       TEXT NOT NULL,
          widgets    TEXT NOT NULL DEFAULT '[]',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_user_dashboards_owner ON user_dashboards(owner);
      `);
    },
  },
  // Name-enriched views for the dataset catalog: cluster_id alone is
  // meaningless in user-built widgets, so these join clusters.name in.
  // Views, not tables — always current, nothing to backfill.
  {
    version: 13,
    up(db) {
      db.exec(`
        CREATE VIEW IF NOT EXISTS v_ds_metrics_history AS
          SELECT m.*, c.name AS cluster_name
          FROM metrics_history m LEFT JOIN clusters c ON c.id = m.cluster_id;
        CREATE VIEW IF NOT EXISTS v_ds_alerts AS
          SELECT a.*, c.name AS cluster_name
          FROM alerts a LEFT JOIN clusters c ON c.id = a.cluster_id;
        CREATE VIEW IF NOT EXISTS v_ds_protection_runs AS
          SELECT p.*, c.name AS cluster_name
          FROM protection_runs p LEFT JOIN clusters c ON c.id = p.cluster_id;
      `);
    },
  },
  // AWS platform grants — same shape as v4/v5/v8/v10/v11.
  {
    version: 14,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'aws:*:*', Viewer: 'aws:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
  // Proxmox VE platform grants — same shape as v4/v5/v8/v10/v11/v14.
  {
    version: 15,
    up(db) {
      const getGroupId = db.prepare('SELECT id FROM groups WHERE name = ?');
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, ?)'
      );
      const now = new Date().toISOString();
      const grants = { Operator: 'proxmox:*:*', Viewer: 'proxmox:*:view' };
      for (const [groupName, permission] of Object.entries(grants)) {
        const row = getGroupId.get(groupName);
        if (row) insertGrant.run('group', row.id, permission, now);
      }
    },
  },
  // Service Status page: per-platform critical-alert events, one AI analysis
  // per event, and a per-platform state timeline the board carries forward.
  {
    version: 16,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS service_alert_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL,
          source_key TEXT NOT NULL,
          severity TEXT NOT NULL,
          host TEXT,
          message TEXT,
          first_seen TEXT,
          detected_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          cleared_at TEXT,
          analysis_status TEXT NOT NULL DEFAULT 'pending',
          UNIQUE(platform, source_key)
        );
        CREATE INDEX IF NOT EXISTS idx_sae_platform_open ON service_alert_events(platform, cleared_at);
        CREATE INDEX IF NOT EXISTS idx_sae_detected ON service_alert_events(detected_at);
        CREATE TABLE IF NOT EXISTS service_alert_analyses (
          event_id INTEGER PRIMARY KEY REFERENCES service_alert_events(id) ON DELETE CASCADE,
          evidence_verdict TEXT NOT NULL,
          ai_verdict TEXT,
          verdict TEXT NOT NULL,
          verdict_reason TEXT,
          why TEXT,
          actions_json TEXT,
          current_state TEXT,
          confidence TEXT,
          evidence_json TEXT NOT NULL,
          model TEXT,
          error TEXT,
          reused_from INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS service_status_timeline (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL,
          state TEXT NOT NULL,
          at TEXT NOT NULL,
          reason TEXT,
          event_ids_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_sst_platform_at ON service_status_timeline(platform, at);
      `);
    },
  },
  // App Service Status: the watched usage-ids (global list) and the last
  // computed state per app; critical apps also flow into service_alert_events.
  {
    version: 17,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_service_watch (
          usage_id TEXT PRIMARY KEY,
          display_id TEXT NOT NULL,
          label TEXT,
          check_port INTEGER,
          created_by TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_service_state (
          usage_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          reason TEXT,
          since TEXT NOT NULL,
          computed_at TEXT NOT NULL,
          summary_json TEXT NOT NULL DEFAULT '{}'
        );
      `);
    },
  },
  // App Services: imported application catalog (ATM ID -> name, lifecycle,
  // platform). Supplies the display name; a manual label on the watch row wins.
  {
    version: 18,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_service_catalog (
          usage_id TEXT PRIMARY KEY,
          atm_id TEXT NOT NULL,
          name TEXT,
          lifecycle TEXT,
          platform TEXT,
          source_rows INTEGER NOT NULL DEFAULT 1,
          imported_at TEXT NOT NULL,
          imported_by TEXT
        );
      `);
    },
  },
  // Per-platform alert email settings: each platform's own recipients + minimum
  // severity override (blank/NULL = inherit the Global Settings default), and
  // the catalog of alert types ICC has seen per platform with a per-type SMTP
  // mute (the same idea as zerto_alert_catalog, generalized to every platform).
  {
    version: 19,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alert_notify_platform (
          platform     TEXT PRIMARY KEY,
          recipients   TEXT NOT NULL DEFAULT '',
          min_severity TEXT,
          updated_at   TEXT
        );
        CREATE TABLE IF NOT EXISTS alert_notify_types (
          platform     TEXT NOT NULL,
          type         TEXT NOT NULL,
          label        TEXT,
          enabled      INTEGER NOT NULL DEFAULT 1,
          first_seen   TEXT,
          last_seen    TEXT,
          PRIMARY KEY (platform, type)
        );
      `);
    },
  },
  // Per-tenant audit log (multi-tenant decision 16): what happened inside
  // this tenant. Sign-ins, switches and tenant administration go to the
  // global audit log in the global database instead.
  {
    version: 20,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_audit (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          at      TEXT NOT NULL,
          actor   TEXT,
          action  TEXT NOT NULL,
          detail  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tenant_audit_at ON tenant_audit(at);
      `);
    },
  },
  // Alert email types start muted (Doug, 2026-09-22): a platform can carry
  // hundreds of types, so the operator opts types in rather than muting the
  // rest. Rows already on record are muted here to match the new default.
  {
    version: 21,
    up(db) {
      db.exec('UPDATE alert_notify_types SET enabled = 0');
    },
  },
  // Operations Agent: incidents built from open alerts, their member alerts,
  // the triage written per incident, and a short run log for the status line.
  {
    version: 22,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ops_incidents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          incident_key TEXT NOT NULL,
          title TEXT,
          host TEXT,
          platforms TEXT NOT NULL,
          severity TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'collecting',
          opened_at TEXT NOT NULL,
          hold_until TEXT NOT NULL,
          last_event_at TEXT NOT NULL,
          triaged_at TEXT,
          triage_error TEXT,
          notified_at TEXT,
          notify_count INTEGER NOT NULL DEFAULT 0,
          email_to TEXT,
          email_error TEXT,
          email_attempt_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          baseline INTEGER NOT NULL DEFAULT 0,
          classification TEXT,
          confidence TEXT,
          summary TEXT,
          analysis_json TEXT,
          evidence_json TEXT,
          model TEXT,
          event_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_ops_incidents_state ON ops_incidents(state, opened_at);
        CREATE INDEX IF NOT EXISTS idx_ops_incidents_key ON ops_incidents(incident_key, opened_at);
        CREATE TABLE IF NOT EXISTS ops_incident_alerts (
          incident_id INTEGER NOT NULL REFERENCES ops_incidents(id) ON DELETE CASCADE,
          platform TEXT NOT NULL,
          source_key TEXT NOT NULL,
          severity TEXT NOT NULL,
          host TEXT,
          message TEXT,
          type TEXT,
          first_seen TEXT,
          attached_at TEXT NOT NULL,
          cleared_at TEXT,
          PRIMARY KEY (incident_id, platform, source_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ops_incident_alerts_key ON ops_incident_alerts(platform, source_key);
        CREATE TABLE IF NOT EXISTS ops_agent_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          alerts_seen INTEGER,
          new_alerts INTEGER,
          incidents_opened INTEGER,
          triaged INTEGER,
          emails_sent INTEGER,
          error TEXT
        );
      `);
    },
  },
];
