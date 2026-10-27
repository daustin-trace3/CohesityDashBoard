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
  {
    // Round 4: AI FinOps Advisor cache table, same shape as netbackup's.
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_ai_reports (
          report_key   TEXT PRIMARY KEY,
          model        TEXT,
          content      TEXT NOT NULL,
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    // Round 5: Optimizer page (Compute Optimizer + local heuristics).
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_optimizer_recommendations (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id             INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          source                 TEXT NOT NULL,
          resource_type          TEXT NOT NULL,
          resource_id            TEXT NOT NULL,
          resource_name          TEXT,
          region                 TEXT,
          finding                TEXT,
          current_config         TEXT,
          recommended_config     TEXT,
          reason                 TEXT,
          est_monthly_savings_usd REAL,
          captured_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, source, resource_type, resource_id, finding)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_optimizer_account ON aws_optimizer_recommendations(account_id);
      `);
      const cols = db.prepare("PRAGMA table_info('aws_accounts')").all().map((c) => c.name);
      if (!cols.includes('last_optimizer_capture_at')) db.exec('ALTER TABLE aws_accounts ADD COLUMN last_optimizer_capture_at DATETIME');
      if (!cols.includes('co_enrollment')) db.exec('ALTER TABLE aws_accounts ADD COLUMN co_enrollment TEXT');
    },
  },
  {
    // Credentials beyond a long-lived key: AssumeRole (role ARN, external ID,
    // session name), a named profile on the ICC box, and an expiry for pasted
    // session credentials. The session token itself rides in the encrypted
    // secret blob; the external ID gets its own encrypted column.
    version: 6,
    up(db) {
      const cols = db.prepare("PRAGMA table_info('aws_accounts')").all().map((c) => c.name);
      const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE aws_accounts ADD COLUMN ${name} ${ddl}`); };
      add('auth_mode', "TEXT NOT NULL DEFAULT 'key'");
      add('role_arn', 'TEXT');
      add('encrypted_external_id', 'TEXT');
      add('role_session_name', 'TEXT');
      add('profile_name', 'TEXT');
      add('credential_expires_at', 'DATETIME');
    },
  },
  {
    // Round 10: the 12 digit AWS account number from the STS caller identity, filled by the
    // poller (and the test route), so LogicMonitor Direct Connect rows can be matched to an
    // ICC account by their system.aws.ownerAccount property. UNVERIFIED live.
    version: 7,
    up(db) {
      const cols = db.prepare("PRAGMA table_info('aws_accounts')").all().map((c) => c.name);
      if (!cols.includes('account_number')) db.exec('ALTER TABLE aws_accounts ADD COLUMN account_number TEXT');
    },
  },
  {
    // Cost drill-down: usage types carry their service, resource-level cost table, per-account
    // resource capture status. Legacy usage rows keep service NULL until the next daily capture.
    version: 8,
    up(db) {
      const usageCols = db.prepare("PRAGMA table_info('aws_cost_usage_daily')").all().map((c) => c.name);
      if (!usageCols.includes('service')) {
        db.exec(`
          CREATE TABLE aws_cost_usage_daily_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id  INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
            day         TEXT NOT NULL,
            service     TEXT,
            usage_type  TEXT NOT NULL,
            amount_usd  REAL,
            UNIQUE(account_id, day, service, usage_type)
          );
          INSERT INTO aws_cost_usage_daily_new (account_id, day, service, usage_type, amount_usd)
            SELECT account_id, day, NULL, usage_type, amount_usd FROM aws_cost_usage_daily;
          DROP TABLE aws_cost_usage_daily;
          ALTER TABLE aws_cost_usage_daily_new RENAME TO aws_cost_usage_daily;
          CREATE INDEX IF NOT EXISTS idx_aws_cost_usage_account ON aws_cost_usage_daily(account_id);
        `);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_cost_resource_daily (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id  INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day         TEXT NOT NULL,
          service     TEXT,
          resource_id TEXT NOT NULL,
          amount_usd  REAL,
          UNIQUE(account_id, day, service, resource_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_cost_resource_account ON aws_cost_resource_daily(account_id);
        CREATE INDEX IF NOT EXISTS idx_aws_cost_resource_day ON aws_cost_resource_daily(day);
      `);
      const cols = db.prepare("PRAGMA table_info('aws_accounts')").all().map((c) => c.name);
      if (!cols.includes('cost_resources_status')) db.exec('ALTER TABLE aws_accounts ADD COLUMN cost_resources_status TEXT');
      if (!cols.includes('cost_resources_error')) db.exec('ALTER TABLE aws_accounts ADD COLUMN cost_resources_error TEXT');
      db.exec('UPDATE aws_accounts SET last_cost_capture_at = NULL');
    },
  },
  {
    // Full Lightsail inventory: extra instance columns plus databases, disks, buckets, load
    // balancers, distributions, DNS zones and static IPs. Field mappings UNVERIFIED live.
    version: 9,
    up(db) {
      const cols = db.prepare("PRAGMA table_info('aws_lightsail_instances')").all().map((c) => c.name);
      const add = (name, type) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE aws_lightsail_instances ADD COLUMN ${name} ${type}`);
      };
      add('ram_gb', 'REAL');
      add('cpu_count', 'INTEGER');
      add('is_windows', 'INTEGER');
      add('arn', 'TEXT');
      add('private_ip', 'TEXT');
      add('created_at', 'DATETIME');
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_lightsail_databases (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id            INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name                  TEXT NOT NULL,
          arn                   TEXT,
          engine                TEXT,
          engine_version        TEXT,
          bundle                TEXT,
          ram_gb                REAL,
          disk_gb               INTEGER,
          state                 TEXT,
          az                    TEXT,
          master_endpoint       TEXT,
          port                  INTEGER,
          backup_retention      INTEGER,
          publicly_accessible   INTEGER,
          latest_restorable_at  DATETIME,
          created_at            DATETIME,
          captured_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ls_databases_account ON aws_lightsail_databases(account_id);

        CREATE TABLE IF NOT EXISTS aws_lightsail_disks (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id       INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name             TEXT NOT NULL,
          arn              TEXT,
          size_gb          INTEGER,
          state            TEXT,
          attached_to      TEXT,
          attachment_state TEXT,
          is_system_disk   INTEGER,
          iops             INTEGER,
          az               TEXT,
          created_at       DATETIME,
          captured_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ls_disks_account ON aws_lightsail_disks(account_id);

        CREATE TABLE IF NOT EXISTS aws_lightsail_buckets (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id            INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name                  TEXT NOT NULL,
          arn                   TEXT,
          bundle                TEXT,
          state                 TEXT,
          object_versioning     TEXT,
          read_only_access      INTEGER,
          able_to_update_bundle INTEGER,
          url                   TEXT,
          created_at            DATETIME,
          captured_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ls_buckets_account ON aws_lightsail_buckets(account_id);

        CREATE TABLE IF NOT EXISTS aws_lightsail_load_balancers (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id         INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name               TEXT NOT NULL,
          arn                TEXT,
          dns_name           TEXT,
          state              TEXT,
          protocol           TEXT,
          instance_port      INTEGER,
          health_check_path  TEXT,
          attached_instances TEXT,
          healthy_count      INTEGER,
          unhealthy_count    INTEGER,
          tls_cert_name      TEXT,
          tls_cert_attached  INTEGER,
          az                 TEXT,
          created_at         DATETIME,
          captured_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ls_lbs_account ON aws_lightsail_load_balancers(account_id);

        CREATE TABLE IF NOT EXISTS aws_lightsail_distributions (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id          INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name                TEXT NOT NULL,
          arn                 TEXT,
          status              TEXT,
          is_enabled          INTEGER,
          domain_name         TEXT,
          origin_name         TEXT,
          origin_region       TEXT,
          bundle              TEXT,
          cert_name           TEXT,
          alternative_domains TEXT,
          created_at          DATETIME,
          captured_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ls_dists_account ON aws_lightsail_distributions(account_id);

        CREATE TABLE IF NOT EXISTS aws_lightsail_domains (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id  INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          arn         TEXT,
          entry_count INTEGER,
          created_at  DATETIME,
          captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ls_domains_account ON aws_lightsail_domains(account_id);

        CREATE TABLE IF NOT EXISTS aws_lightsail_static_ips (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id  INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          arn         TEXT,
          ip_address  TEXT,
          is_attached INTEGER,
          attached_to TEXT,
          az          TEXT,
          created_at  DATETIME,
          captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_ls_static_ips_account ON aws_lightsail_static_ips(account_id);
      `);
    },
  },
  {
    // Exact object mapping: per resource per usage type cost (resource-level Cost Explorer).
    version: 10,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_cost_resource_usage_daily (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id  INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day         TEXT NOT NULL,
          usage_type  TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          amount_usd  REAL,
          UNIQUE(account_id, day, usage_type, resource_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_cost_res_usage_account ON aws_cost_resource_usage_daily(account_id);
        CREATE INDEX IF NOT EXISTS idx_aws_cost_res_usage_day ON aws_cost_resource_usage_daily(day);
      `);
    },
  },
  {
    // FinOps round (2026-10-27): amortized cost beside unblended (Cost Explorer returns both
    // metrics in one request), usage quantities per usage type, allocation by tag / cost category
    // / linked account, Savings Plan and Reserved Instance utilization and coverage, Cost Anomaly
    // Detection plus ICC's own per-service anomalies, forecasts, ICC-defined budgets, a lifecycle
    // per recommendation with realized savings, and a per-capability status map so every new
    // Cost Explorer call degrades visibly (denied / not_enabled) instead of failing the poll.
    // last_cost_capture_at is reset so the next poll refetches 35 days with both metrics.
    version: 11,
    up(db) {
      const colsOf = (table) => db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
      const add = (table, name, ddl) => {
        if (!colsOf(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      };
      add('aws_cost_daily', 'amortized_usd', 'REAL');
      add('aws_cost_usage_daily', 'amortized_usd', 'REAL');
      add('aws_cost_usage_daily', 'usage_qty', 'REAL');
      add('aws_cost_usage_daily', 'usage_unit', 'TEXT');
      add('aws_cost_instance_type_daily', 'amortized_usd', 'REAL');
      add('aws_accounts', 'last_finops_capture_at', 'DATETIME');
      add('aws_accounts', 'finops_backfill_at', 'DATETIME');
      db.exec('UPDATE aws_accounts SET last_cost_capture_at = NULL');

      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_cost_alloc_daily (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id    INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day           TEXT NOT NULL,
          dimension     TEXT NOT NULL,
          key           TEXT NOT NULL,
          value         TEXT NOT NULL DEFAULT '',
          service       TEXT NOT NULL DEFAULT '',
          amount_usd    REAL,
          amortized_usd REAL,
          UNIQUE(account_id, day, dimension, key, value, service)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_alloc_lookup ON aws_cost_alloc_daily(account_id, dimension, key, day);

        CREATE TABLE IF NOT EXISTS aws_sp_utilization_daily (
          id                        INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id                INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day                       TEXT NOT NULL,
          utilization_pct           REAL,
          commitment_usd            REAL,
          used_usd                  REAL,
          unused_usd                REAL,
          net_savings_usd           REAL,
          on_demand_equivalent_usd  REAL,
          UNIQUE(account_id, day)
        );
        CREATE TABLE IF NOT EXISTS aws_sp_coverage_daily (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id     INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day            TEXT NOT NULL,
          coverage_pct   REAL,
          covered_usd    REAL,
          on_demand_usd  REAL,
          total_usd      REAL,
          UNIQUE(account_id, day)
        );
        CREATE TABLE IF NOT EXISTS aws_ri_utilization_daily (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id       INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day              TEXT NOT NULL,
          utilization_pct  REAL,
          purchased_hours  REAL,
          used_hours       REAL,
          unused_hours     REAL,
          net_savings_usd  REAL,
          UNIQUE(account_id, day)
        );
        CREATE TABLE IF NOT EXISTS aws_ri_coverage_daily (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id       INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          day              TEXT NOT NULL,
          coverage_pct     REAL,
          reserved_hours   REAL,
          on_demand_hours  REAL,
          total_hours      REAL,
          UNIQUE(account_id, day)
        );
        CREATE TABLE IF NOT EXISTS aws_savings_plans (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id             INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          sp_arn                 TEXT NOT NULL,
          sp_type                TEXT,
          payment_option         TEXT,
          term                   TEXT,
          hourly_commitment_usd  REAL,
          region                 TEXT,
          instance_family        TEXT,
          start_at               TEXT,
          end_at                 TEXT,
          utilization_pct        REAL,
          net_savings_usd        REAL,
          captured_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(account_id, sp_arn)
        );
        CREATE TABLE IF NOT EXISTS aws_cost_anomalies (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id       INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          anomaly_id       TEXT NOT NULL,
          source           TEXT NOT NULL,
          monitor_arn      TEXT,
          monitor_name     TEXT,
          scope            TEXT NOT NULL,
          scope_key        TEXT NOT NULL,
          start_day        TEXT NOT NULL,
          end_day          TEXT,
          actual_usd       REAL,
          expected_usd     REAL,
          impact_usd       REAL,
          impact_pct       REAL,
          root_causes_json TEXT,
          feedback         TEXT,
          status           TEXT NOT NULL DEFAULT 'open',
          normal_days      INTEGER NOT NULL DEFAULT 0,
          superseded_by    TEXT,
          first_seen_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_seen_at     DATETIME,
          UNIQUE(account_id, anomaly_id)
        );
        CREATE INDEX IF NOT EXISTS idx_aws_anomalies_status ON aws_cost_anomalies(account_id, status, start_day);
        CREATE TABLE IF NOT EXISTS aws_cost_forecast (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id    INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          scope         TEXT NOT NULL DEFAULT 'total',
          metric        TEXT NOT NULL,
          period_start  TEXT NOT NULL,
          period_end    TEXT NOT NULL,
          generated_on  TEXT NOT NULL,
          mean_usd      REAL,
          lower_usd     REAL,
          upper_usd     REAL,
          source        TEXT NOT NULL,
          UNIQUE(account_id, scope, metric, period_start, generated_on)
        );
        CREATE TABLE IF NOT EXISTS aws_budgets (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT NOT NULL UNIQUE,
          scope_type      TEXT NOT NULL,
          scope_key       TEXT,
          scope_value     TEXT,
          amount_usd      REAL NOT NULL,
          warn_pct        INTEGER NOT NULL DEFAULT 80,
          crit_pct        INTEGER NOT NULL DEFAULT 100,
          forecast_alert  INTEGER NOT NULL DEFAULT 1,
          enabled         INTEGER NOT NULL DEFAULT 1,
          notes           TEXT,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS aws_budget_status (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          budget_id        INTEGER NOT NULL REFERENCES aws_budgets(id) ON DELETE CASCADE,
          month            TEXT NOT NULL,
          actual_usd       REAL,
          forecast_usd     REAL,
          forecast_source  TEXT,
          pct_actual       REAL,
          pct_forecast     REAL,
          state            TEXT NOT NULL,
          evaluated_at     DATETIME,
          UNIQUE(budget_id, month)
        );
        CREATE TABLE IF NOT EXISTS aws_recommendation_state (
          id                       INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id               INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          rec_key                  TEXT NOT NULL,
          status                   TEXT NOT NULL DEFAULT 'open',
          note                     TEXT,
          updated_by               TEXT,
          resolved_by              TEXT,
          est_monthly_savings_usd  REAL,
          realized_usd             REAL,
          realized_at              DATETIME,
          first_seen_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_seen_at             DATETIME,
          updated_at               DATETIME,
          UNIQUE(account_id, rec_key)
        );
        CREATE TABLE IF NOT EXISTS aws_capability_status (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id       INTEGER NOT NULL REFERENCES aws_accounts(id) ON DELETE CASCADE,
          capability       TEXT NOT NULL,
          status           TEXT NOT NULL,
          error            TEXT,
          requests         INTEGER DEFAULT 0,
          last_ok_at       DATETIME,
          last_checked_at  DATETIME,
          UNIQUE(account_id, capability)
        );
      `);
    },
  },
];

