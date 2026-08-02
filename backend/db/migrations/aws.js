// AWS scope: aws_* tables. Single-account v1 but schema carries account_id
// everywhere for future multi-account support. Direct-connection model like
// vCenter — credentials optionally stored (AES-encrypted), falling back to
// process.env.AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY when blank. Inventory
// tables (EC2/EBS/Lightsail/ECS/S3) are wholesale-replaced per account each
// poll; Bedrock usage and cost are daily history, upserted.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_accounts (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          name                     TEXT NOT NULL UNIQUE,
          access_key_id            TEXT,
          encrypted_credentials    TEXT,
          region                   TEXT NOT NULL DEFAULT 'us-east-2',
          polling_interval_minutes INTEGER NOT NULL DEFAULT 10,
          last_poll_status         TEXT,
          last_poll_error          TEXT,
          last_poll_at             DATETIME,
          last_cost_capture_at     DATETIME,
          last_s3_capture_at       DATETIME,
          created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS aws_ec2_instances (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id        INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          instance_id       TEXT NOT NULL,
          name              TEXT,
          state             TEXT,
          instance_type     TEXT,
          az                TEXT,
          private_ip        TEXT,
          public_ip         TEXT,
          platform          TEXT,
          launch_time       DATETIME,
          cpu_util          REAL,
          status_check      TEXT,
          captured_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, instance_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ec2_account ON aws_ec2_instances(account_id);

        CREATE TABLE IF NOT EXISTS aws_ebs_volumes (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id          INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          volume_id           TEXT NOT NULL,
          state               TEXT,
          size_gb             INTEGER,
          volume_type         TEXT,
          az                  TEXT,
          attached_instance_id TEXT,
          captured_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, volume_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ebs_account ON aws_ebs_volumes(account_id);

        CREATE TABLE IF NOT EXISTS aws_lightsail_instances (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id          INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name                TEXT NOT NULL,
          state               TEXT,
          blueprint           TEXT,
          bundle              TEXT,
          az                  TEXT,
          public_ip           TEXT,
          cpu_util            REAL,
          snapshot_count      INTEGER,
          latest_snapshot_at  DATETIME,
          captured_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_lightsail_account ON aws_lightsail_instances(account_id);

        CREATE TABLE IF NOT EXISTS aws_ecs_clusters (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id          INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          cluster_arn         TEXT NOT NULL,
          cluster_name        TEXT,
          status              TEXT,
          running_tasks       INTEGER,
          pending_tasks       INTEGER,
          service_count       INTEGER,
          container_instances INTEGER,
          captured_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, cluster_arn)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ecs_clusters_account ON aws_ecs_clusters(account_id);

        CREATE TABLE IF NOT EXISTS aws_ecs_services (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id     INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          cluster_name   TEXT,
          service_name   TEXT NOT NULL,
          status         TEXT,
          desired_count  INTEGER,
          running_count  INTEGER,
          pending_count  INTEGER,
          launch_type    TEXT,
          cpu_util       REAL,
          memory_util    REAL,
          captured_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, cluster_name, service_name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ecs_services_account ON aws_ecs_services(account_id);

        CREATE TABLE IF NOT EXISTS aws_s3_buckets (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id            INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name                  TEXT NOT NULL,
          region                TEXT,
          size_bytes            INTEGER,
          object_count          INTEGER,
          public_access_blocked INTEGER,
          versioning            TEXT,
          lifecycle_rules       INTEGER,
          created_at_aws        DATETIME,
          captured_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_s3_account ON aws_s3_buckets(account_id);

        CREATE TABLE IF NOT EXISTS aws_bedrock_usage (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id     INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          model_id       TEXT NOT NULL,
          day            TEXT NOT NULL,
          invocations    INTEGER,
          input_tokens   INTEGER,
          output_tokens  INTEGER,
          avg_latency_ms REAL,
          UNIQUE(account_id, model_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_bedrock_account ON aws_bedrock_usage(account_id);

        CREATE TABLE IF NOT EXISTS aws_cost_daily (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id  INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day         TEXT NOT NULL,
          service     TEXT NOT NULL,
          amount_usd  REAL,
          currency    TEXT DEFAULT 'USD',
          UNIQUE(account_id, day, service)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_cost_account ON aws_cost_daily(account_id);

        CREATE TABLE IF NOT EXISTS aws_metrics_history (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id        INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          captured_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
          ec2_running       INTEGER,
          ec2_stopped       INTEGER,
          ec2_alarmed       INTEGER,
          lightsail_running INTEGER,
          ecs_services      INTEGER,
          ecs_degraded      INTEGER,
          s3_total_bytes    INTEGER,
          s3_buckets        INTEGER,
          mtd_spend_usd     REAL
        );
        CREATE INDEX IF NOT EXISTS idx_aws_metrics_account ON aws_metrics_history(account_id, captured_at);

        CREATE TABLE IF NOT EXISTS aws_issue_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key   TEXT NOT NULL,
          account_id  INTEGER,
          account     TEXT,
          severity    TEXT,
          type        TEXT,
          target      TEXT,
          message     TEXT,
          status      TEXT NOT NULL DEFAULT 'open',
          first_seen  DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_seen   DATETIME,
          resolved_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_aws_issue_hist_key ON aws_issue_history(issue_key, status);
        CREATE INDEX IF NOT EXISTS idx_aws_issue_hist_seen ON aws_issue_history(last_seen);
      `);
    },
  },
];
