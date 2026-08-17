// Aria Operations (vROps Suite API) scope: ariaops_* tables. Direct-connection
// model like Aria Automation/vCenter/Dell — each instance registered with
// credentials (AES-encrypted). Doug has no live vROps to test against, so
// every upstream response shape in api.js is UNVERIFIED — the probe route
// (router.js) exists to see real shapes against a live instance.
// Resources/alerts are replaced per instance each poll (a full-fidelity
// dataset each cycle keeps stale rows from lingering); ariaops_metrics_history
// accumulates snapshots for trends.
//
// Copied VERBATIM from backend/db/migrations/ariaops.js, same scope id
// 'ariaops' — schema_migrations already has scope='ariaops' rows on any
// instance that ran the built-in platform, so this migration set is skipped
// on install and existing production data is adopted intact.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ariaops_instances (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          host                     TEXT NOT NULL,
          username                 TEXT NOT NULL,
          auth_source              TEXT,
          encrypted_credentials    TEXT NOT NULL,
          ssl_verify               INTEGER NOT NULL DEFAULT 0,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
          version                  TEXT,
          last_poll_status         TEXT,
          last_poll_error          TEXT,
          last_poll_at             DATETIME,
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS ariaops_resources (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id       INTEGER NOT NULL REFERENCES ariaops_instances(id) ON DELETE CASCADE,
          resource_id       TEXT,
          name              TEXT,
          kind              TEXT, -- VirtualMachine | HostSystem | Datastore
          adapter_kind      TEXT,
          health            TEXT, -- GREEN | YELLOW | ORANGE | RED | GREY
          status_json       TEXT,
          cpu_pct           REAL,
          mem_pct           REAL,
          stats_captured_at DATETIME,
          captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ariaops_resources_instance ON ariaops_resources(instance_id);

        CREATE TABLE IF NOT EXISTS ariaops_alerts (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id      INTEGER NOT NULL REFERENCES ariaops_instances(id) ON DELETE CASCADE,
          alert_id         TEXT,
          level            TEXT, -- CRITICAL | IMMEDIATE | WARNING | INFO
          status           TEXT,
          resource_name    TEXT,
          definition_name  TEXT,
          impact           TEXT,
          started_at_ms    INTEGER,
          updated_at_ms    INTEGER,
          captured_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ariaops_alerts_instance ON ariaops_alerts(instance_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ariaops_alerts_unique ON ariaops_alerts(instance_id, alert_id);

        CREATE TABLE IF NOT EXISTS ariaops_metrics_history (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id       INTEGER NOT NULL REFERENCES ariaops_instances(id) ON DELETE CASCADE,
          captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resources_total   INTEGER,
          vms_total         INTEGER,
          resources_red     INTEGER,
          resources_yellow  INTEGER,
          alerts_critical   INTEGER,
          alerts_total      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_ariaops_metrics_instance ON ariaops_metrics_history(instance_id, captured_at);
      `);
    },
  },
];
