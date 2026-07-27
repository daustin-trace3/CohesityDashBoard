// Aria Automation scope: aria_* tables. Direct-connection model (vRA 8.x
// on-prem only — Aria SaaS is dead) — each instance registered with
// credentials (AES-encrypted) like vCenter/Dell. Most inventory tables are
// replaced per instance each poll; aria_requests and aria_runs are
// append+dedupe logs (a request/run id is stable once seen) trimmed to the
// newest 2000 rows per instance; aria_metrics_history accumulates snapshots
// for trends; aria_issue_history mirrors vcenter_issue_history for alert
// email dedupe keys.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aria_instances (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          host                     TEXT NOT NULL,
          username                 TEXT NOT NULL,
          domain                   TEXT,
          encrypted_credentials    TEXT NOT NULL,
          ssl_verify               INTEGER NOT NULL DEFAULT 0,
          polling_interval_minutes INTEGER NOT NULL DEFAULT 15,
          version                  TEXT,
          api_version              TEXT,
          reachable                INTEGER,
          cert_subject             TEXT,
          cert_issuer              TEXT,
          cert_valid_from          TEXT,
          cert_valid_to            TEXT,
          last_poll_status         TEXT,
          last_poll_error          TEXT,
          last_poll_at             DATETIME,
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS aria_deployments (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id       INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          deployment_id     TEXT,
          name              TEXT,
          project_name      TEXT,
          status            TEXT,
          created_by        TEXT,
          created_at_src    TEXT,
          updated_at_src    TEXT,
          lease_expire_at   TEXT,
          resource_count    INTEGER,
          raw_status_detail TEXT,
          captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_deployments_instance ON aria_deployments(instance_id);

        CREATE TABLE IF NOT EXISTS aria_requests (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id    INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          request_id     TEXT,
          deployment_id  TEXT,
          name           TEXT,
          status         TEXT,
          requested_by   TEXT,
          created_at_src TEXT,
          updated_at_src TEXT,
          detail         TEXT,
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_requests_instance ON aria_requests(instance_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_aria_requests_unique ON aria_requests(instance_id, request_id);

        CREATE TABLE IF NOT EXISTS aria_endpoints (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id  INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          endpoint_id  TEXT,
          kind         TEXT, -- 'cloud-account' | 'integration'
          name         TEXT,
          type         TEXT,
          health_state TEXT,
          detail       TEXT,
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_endpoints_instance ON aria_endpoints(instance_id);

        CREATE TABLE IF NOT EXISTS aria_projects (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id  INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          project_id   TEXT,
          name         TEXT,
          description  TEXT,
          captured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_projects_instance ON aria_projects(instance_id);

        CREATE TABLE IF NOT EXISTS aria_catalog_sources (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id        INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          source_id          TEXT,
          name               TEXT,
          type               TEXT,
          items_imported     INTEGER,
          items_found        INTEGER,
          last_import_at     TEXT,
          last_import_errors TEXT,
          captured_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_catalog_sources_instance ON aria_catalog_sources(instance_id);

        CREATE TABLE IF NOT EXISTS aria_runs (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id    INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          kind           TEXT, -- 'abx' | 'pipeline'
          run_id         TEXT,
          name           TEXT,
          status         TEXT,
          project_name   TEXT,
          started_at_src TEXT,
          message        TEXT,
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_runs_instance ON aria_runs(instance_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_aria_runs_unique ON aria_runs(instance_id, kind, run_id);

        CREATE TABLE IF NOT EXISTS aria_approvals (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id    INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          approval_id    TEXT,
          subject        TEXT,
          requested_by   TEXT,
          status         TEXT,
          created_at_src TEXT,
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_approvals_instance ON aria_approvals(instance_id);

        CREATE TABLE IF NOT EXISTS aria_metrics_history (
          id                          INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id                 INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          captured_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          deployments_total           INTEGER,
          deployments_failed          INTEGER,
          deployments_lease_expiring  INTEGER, -- lease_expire_at within 7d
          requests_24h_total          INTEGER,
          requests_24h_failed         INTEGER,
          endpoints_total             INTEGER,
          endpoints_unhealthy         INTEGER,
          runs_24h_failed             INTEGER,
          approvals_pending           INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_aria_metrics_instance ON aria_metrics_history(instance_id, captured_at);

        CREATE TABLE IF NOT EXISTS aria_issue_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key   TEXT NOT NULL, -- type|instance|target (stable across polls)
          instance    TEXT,
          severity    TEXT,
          type        TEXT,
          target      TEXT,
          message     TEXT,
          status      TEXT NOT NULL DEFAULT 'open', -- open | resolved
          first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_aria_issue_hist_key ON aria_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_aria_issue_hist_seen ON aria_issue_history(last_seen);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      // VM building blocks: fabric images (raw templates/AMIs discovered per
      // cloud-account region), image profiles (curated logical-name -> image
      // mappings blueprints reference), and flavor mappings (t-shirt sizes).
      // All replaced per instance each poll, same as the other inventory tables.
      db.exec(`
        CREATE TABLE IF NOT EXISTS aria_images (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id       INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          image_id          TEXT,
          name              TEXT,
          description       TEXT,
          external_id       TEXT,              -- native template/AMI id
          region            TEXT,
          os_family         TEXT,              -- LINUX | WINDOWS (unverified vocab)
          is_private        INTEGER,
          custom_properties TEXT,              -- raw JSON
          captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_images_instance ON aria_images(instance_id);

        CREATE TABLE IF NOT EXISTS aria_image_mappings (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id       INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          profile_id        TEXT,
          profile_name      TEXT,
          region            TEXT,
          mapping_name      TEXT,              -- the logical name blueprints use
          image_name        TEXT,
          image_external_id TEXT,
          os_family         TEXT,
          description       TEXT,
          captured_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_image_mappings_instance ON aria_image_mappings(instance_id);

        CREATE TABLE IF NOT EXISTS aria_flavor_mappings (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id   INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          profile_name  TEXT,
          region        TEXT,
          mapping_name  TEXT,                  -- e.g. small / medium / large
          cpu_count     INTEGER,
          memory_mb     INTEGER,
          captured_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_flavor_mappings_instance ON aria_flavor_mappings(instance_id);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      // Image lifecycle + usage tracing. created_at_src/updated_at_src are the
      // vRA record timestamps (when data collection first discovered / last
      // re-synced the image) — NOT the template's build date on the source
      // platform, which vRA does not expose. aria_blueprints stores each
      // Cloud Assembly template with the image references extracted from its
      // YAML (blueprints name image MAPPINGS, not fabric images directly).
      db.exec(`
        ALTER TABLE aria_images ADD COLUMN created_at_src TEXT;
        ALTER TABLE aria_images ADD COLUMN updated_at_src TEXT;

        CREATE TABLE IF NOT EXISTS aria_blueprints (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id    INTEGER NOT NULL REFERENCES aria_instances(id) ON DELETE CASCADE,
          blueprint_id   TEXT,
          name           TEXT,
          project_name   TEXT,
          status         TEXT,              -- e.g. RELEASED / DRAFT (unverified vocab)
          updated_at_src TEXT,
          image_refs     TEXT,              -- JSON array of image values found in the YAML
          captured_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aria_blueprints_instance ON aria_blueprints(instance_id);
      `);
    },
  },
];
