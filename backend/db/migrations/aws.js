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
  {
    // Round 2: RDS, Lambda, DynamoDB, ECR, VPC/subnet inventory. Wholesale-
    // replaced per account each poll, same as EC2/EBS/Lightsail/ECS.
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_rds_instances (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id             INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          db_id                  TEXT NOT NULL,
          engine                 TEXT,
          engine_version         TEXT,
          instance_class         TEXT,
          status                 TEXT,
          multi_az               INTEGER,
          allocated_gb           INTEGER,
          free_storage_bytes     INTEGER,
          cpu_util               REAL,
          connections            INTEGER,
          backup_retention_days  INTEGER,
          latest_backup_at       DATETIME,
          endpoint               TEXT,
          captured_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, db_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_rds_account ON aws_rds_instances(account_id);

        CREATE TABLE IF NOT EXISTS aws_lambda_functions (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id        INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name              TEXT NOT NULL,
          runtime           TEXT,
          memory_mb         INTEGER,
          timeout_s         INTEGER,
          code_size_bytes   INTEGER,
          last_modified     DATETIME,
          invocations_24h   INTEGER,
          errors_24h        INTEGER,
          avg_duration_ms   REAL,
          captured_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_lambda_account ON aws_lambda_functions(account_id);

        CREATE TABLE IF NOT EXISTS aws_dynamo_tables (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id     INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          status         TEXT,
          billing_mode   TEXT,
          item_count     INTEGER,
          size_bytes     INTEGER,
          read_capacity  INTEGER,
          write_capacity INTEGER,
          captured_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_dynamo_account ON aws_dynamo_tables(account_id);

        CREATE TABLE IF NOT EXISTS aws_ecr_repos (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id     INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          image_count    INTEGER,
          size_bytes     INTEGER,
          scan_on_push   INTEGER,
          latest_push_at DATETIME,
          captured_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ecr_account ON aws_ecr_repos(account_id);

        CREATE TABLE IF NOT EXISTS aws_vpcs (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id             INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          vpc_id                 TEXT NOT NULL,
          name                   TEXT,
          cidr                   TEXT,
          state                  TEXT,
          is_default             INTEGER,
          subnet_count           INTEGER,
          nat_gateway_count      INTEGER,
          security_group_count   INTEGER,
          igw                    INTEGER,
          captured_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, vpc_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_vpcs_account ON aws_vpcs(account_id);

        CREATE TABLE IF NOT EXISTS aws_subnets (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id     INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          subnet_id      TEXT NOT NULL,
          vpc_id         TEXT,
          name           TEXT,
          cidr           TEXT,
          az             TEXT,
          available_ips  INTEGER,
          public         INTEGER,
          captured_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, subnet_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_subnets_account ON aws_subnets(account_id);
      `);
    },
  },
  {
    // Round 3: global-collector election fix (#0) support tables — per-day
    // history for S3 bucket size/object count and RDS free storage, plus two
    // additional Cost Explorer groupings and AWS Service Health RSS events.
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_s3_size_history (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id   INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          bucket_name  TEXT NOT NULL,
          day          TEXT NOT NULL,
          size_bytes   INTEGER,
          object_count INTEGER,
          UNIQUE(account_id, bucket_name, day)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_s3_history_account ON aws_s3_size_history(account_id);
        CREATE INDEX IF NOT EXISTS idx_aws_s3_history_bucket ON aws_s3_size_history(bucket_name, day);

        CREATE TABLE IF NOT EXISTS aws_rds_storage_history (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id         INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          db_id              TEXT NOT NULL,
          day                TEXT NOT NULL,
          free_storage_bytes INTEGER,
          allocated_gb       INTEGER,
          UNIQUE(account_id, db_id, day)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_rds_history_account ON aws_rds_storage_history(account_id);
        CREATE INDEX IF NOT EXISTS idx_aws_rds_history_db ON aws_rds_storage_history(db_id, day);

        CREATE TABLE IF NOT EXISTS aws_cost_usage_daily (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id  INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day         TEXT NOT NULL,
          usage_type  TEXT NOT NULL,
          amount_usd  REAL,
          UNIQUE(account_id, day, usage_type)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_cost_usage_account ON aws_cost_usage_daily(account_id);

        CREATE TABLE IF NOT EXISTS aws_cost_instance_type_daily (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id     INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day            TEXT NOT NULL,
          instance_type  TEXT NOT NULL,
          amount_usd     REAL,
          UNIQUE(account_id, day, instance_type)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_cost_instance_type_account ON aws_cost_instance_type_daily(account_id);

        CREATE TABLE IF NOT EXISTS aws_health_events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          feed          TEXT NOT NULL,
          service       TEXT,
          region        TEXT,
          title         TEXT NOT NULL,
          summary       TEXT,
          published_at  DATETIME,
          fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(feed, title, published_at)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_health_events_published ON aws_health_events(published_at);
      `);
    },
  },
];
