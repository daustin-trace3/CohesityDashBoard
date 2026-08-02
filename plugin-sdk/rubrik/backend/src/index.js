// Rubrik demo platform plugin manifest (ICC contract C1). Static, seeded
// demo data — no live upstream connection. Mirrors plugin-sdk/template/.

const CLUSTERS = [
  { id: 1, name: 'rbk-prd-01', model: 'r6408', nodes: 8, version: '9.2.1-p3', capacityBytes: 480000000000000, usedBytes: 345600000000000, status: 'Connected' },
  { id: 2, name: 'rbk-dr-01', model: 'r6404', nodes: 4, version: '9.2.1-p3', capacityBytes: 240000000000000, usedBytes: 163200000000000, status: 'Connected' },
  { id: 3, name: 'rbk-dev-01', model: 'r6404-edge', nodes: 4, version: '9.1.3-p2', capacityBytes: 60000000000000, usedBytes: 36000000000000, status: 'Connected' },
];

// offsetHours: how long ago the last backup completed (negative = past).
const OBJECTS = [
  { id: 1, clusterId: 1, name: 'web-prd-01', type: 'VM', slaDomain: 'Gold-4h', offsetHours: -1, compliant: true },
  { id: 2, clusterId: 1, name: 'web-prd-02', type: 'VM', slaDomain: 'Gold-4h', offsetHours: -2, compliant: true },
  { id: 3, clusterId: 1, name: 'web-prd-03', type: 'VM', slaDomain: 'Gold-4h', offsetHours: -1, compliant: true },
  { id: 4, clusterId: 1, name: 'app-prd-01', type: 'VM', slaDomain: 'Gold-4h', offsetHours: -3, compliant: true },
  { id: 5, clusterId: 1, name: 'app-prd-02', type: 'VM', slaDomain: 'Silver-24h', offsetHours: -5, compliant: true },
  { id: 6, clusterId: 1, name: 'db-vm-prd-01', type: 'VM', slaDomain: 'Gold-4h', offsetHours: -2, compliant: true },
  { id: 7, clusterId: 2, name: 'db-vm-dr-01', type: 'VM', slaDomain: 'Silver-24h', offsetHours: -10, compliant: true },
  { id: 8, clusterId: 2, name: 'db-vm-dr-02', type: 'VM', slaDomain: 'Silver-24h', offsetHours: -11, compliant: true },
  { id: 9, clusterId: 3, name: 'file-vm-dev-01', type: 'VM', slaDomain: 'Bronze-7d', offsetHours: -30, compliant: false },
  { id: 10, clusterId: 3, name: 'file-vm-dev-02', type: 'VM', slaDomain: 'Bronze-7d', offsetHours: -20, compliant: true },
  { id: 11, clusterId: 3, name: 'file-vm-dev-03', type: 'VM', slaDomain: 'Bronze-7d', offsetHours: -18, compliant: true },
  { id: 12, clusterId: 2, name: 'web-dr-01', type: 'VM', slaDomain: 'Silver-24h', offsetHours: -9, compliant: true },
  { id: 13, clusterId: 1, name: 'SQL-ERP-PRD', type: 'MSSQL DB', slaDomain: 'Gold-4h', offsetHours: -1, compliant: true },
  { id: 14, clusterId: 1, name: 'SQL-CRM-PRD', type: 'MSSQL DB', slaDomain: 'Gold-4h', offsetHours: -2, compliant: true },
  { id: 15, clusterId: 2, name: 'SQL-BILLING-DR', type: 'MSSQL DB', slaDomain: 'Silver-24h', offsetHours: -8, compliant: true },
  { id: 16, clusterId: 2, name: 'SQL-HR-DR', type: 'MSSQL DB', slaDomain: 'Silver-24h', offsetHours: -55, compliant: false },
  { id: 17, clusterId: 3, name: 'SQL-STAGE-DEV', type: 'MSSQL DB', slaDomain: 'Bronze-7d', offsetHours: -16, compliant: true },
  { id: 18, clusterId: 3, name: 'SQL-TEST-DEV', type: 'MSSQL DB', slaDomain: 'Bronze-7d', offsetHours: -19, compliant: true },
  { id: 19, clusterId: 1, name: '\\\\nas01\\finance', type: 'NAS Share', slaDomain: 'Gold-4h', offsetHours: -3, compliant: true },
  { id: 20, clusterId: 1, name: '\\\\nas01\\hr', type: 'NAS Share', slaDomain: 'Silver-24h', offsetHours: -6, compliant: true },
  { id: 21, clusterId: 2, name: '\\\\nas02\\engineering', type: 'NAS Share', slaDomain: 'Silver-24h', offsetHours: -9, compliant: true },
  { id: 22, clusterId: 2, name: '\\\\nas02\\backups', type: 'NAS Share', slaDomain: 'Silver-24h', offsetHours: -12, compliant: true },
  { id: 23, clusterId: 3, name: '\\\\nas03\\dev-share', type: 'NAS Share', slaDomain: 'Bronze-7d', offsetHours: -22, compliant: true },
  { id: 24, clusterId: 3, name: '\\\\nas03\\qa-share', type: 'NAS Share', slaDomain: 'Bronze-7d', offsetHours: -24, compliant: true },
  { id: 25, clusterId: 1, name: 'web-ec2-01', type: 'EC2 Instance', slaDomain: 'Gold-4h', offsetHours: -2, compliant: true },
  { id: 26, clusterId: 1, name: 'web-ec2-02', type: 'EC2 Instance', slaDomain: 'Gold-4h', offsetHours: -3, compliant: true },
  { id: 27, clusterId: 2, name: 'app-ec2-01', type: 'EC2 Instance', slaDomain: 'Silver-24h', offsetHours: -7, compliant: true },
  { id: 28, clusterId: 2, name: 'app-ec2-02', type: 'EC2 Instance', slaDomain: 'Silver-24h', offsetHours: -10, compliant: true },
  { id: 29, clusterId: 3, name: 'dev-ec2-01', type: 'EC2 Instance', slaDomain: 'Bronze-7d', offsetHours: -21, compliant: true },
  { id: 30, clusterId: 3, name: 'dev-ec2-02', type: 'EC2 Instance', slaDomain: 'Bronze-7d', offsetHours: -23, compliant: true },
];

// startOffsetHours: when the job started, relative to now. durationSeconds
// determines the ended_at offset.
const JOBS = [
  { id: 1, clusterId: 1, objectName: 'web-prd-01', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -1, durationSeconds: 280, dataBytes: 8500000000, error: null },
  { id: 2, clusterId: 1, objectName: 'web-prd-02', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -2, durationSeconds: 310, dataBytes: 9100000000, error: null },
  { id: 3, clusterId: 1, objectName: 'app-prd-01', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -3, durationSeconds: 265, dataBytes: 6700000000, error: null },
  { id: 4, clusterId: 1, objectName: 'db-vm-prd-01', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -2, durationSeconds: 420, dataBytes: 15200000000, error: null },
  { id: 5, clusterId: 1, objectName: 'SQL-ERP-PRD', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -1, durationSeconds: 190, dataBytes: 4300000000, error: null },
  { id: 6, clusterId: 1, objectName: 'SQL-CRM-PRD', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -2, durationSeconds: 210, dataBytes: 5000000000, error: null },
  { id: 7, clusterId: 1, objectName: '\\\\nas01\\finance', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -3, durationSeconds: 520, dataBytes: 22000000000, error: null },
  { id: 8, clusterId: 1, objectName: 'web-ec2-01', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -2, durationSeconds: 180, dataBytes: 3900000000, error: null },
  { id: 9, clusterId: 1, objectName: 'web-prd-03', jobType: 'Replication', status: 'Succeeded', startOffsetHours: -4, durationSeconds: 340, dataBytes: 8800000000, error: null },
  { id: 10, clusterId: 1, objectName: 'SQL-ERP-PRD', jobType: 'Archival', status: 'Succeeded', startOffsetHours: -5, durationSeconds: 900, dataBytes: 41000000000, error: null },
  { id: 11, clusterId: 2, objectName: 'db-vm-dr-01', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -10, durationSeconds: 300, dataBytes: 9600000000, error: null },
  { id: 12, clusterId: 2, objectName: 'db-vm-dr-02', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -11, durationSeconds: 295, dataBytes: 9200000000, error: null },
  { id: 13, clusterId: 2, objectName: 'SQL-BILLING-DR', jobType: 'Backup', status: 'Failed', startOffsetHours: -8, durationSeconds: 45, dataBytes: 0, error: 'Snapshot mount timeout: exceeded 45s waiting for VSS quiesce on host dr-sql-02' },
  { id: 14, clusterId: 2, objectName: 'SQL-HR-DR', jobType: 'Backup', status: 'Failed', startOffsetHours: -12, durationSeconds: 30, dataBytes: 0, error: 'Authentication failed: service account credentials expired (AD trust)' },
  { id: 15, clusterId: 2, objectName: '\\\\nas02\\engineering', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -9, durationSeconds: 610, dataBytes: 18500000000, error: null },
  { id: 16, clusterId: 2, objectName: 'app-ec2-01', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -7, durationSeconds: 150, dataBytes: 2800000000, error: null },
  { id: 17, clusterId: 2, objectName: 'web-dr-01', jobType: 'Replication', status: 'Succeeded', startOffsetHours: -9, durationSeconds: 400, dataBytes: 11000000000, error: null },
  { id: 18, clusterId: 3, objectName: 'file-vm-dev-02', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -20, durationSeconds: 260, dataBytes: 6100000000, error: null },
  { id: 19, clusterId: 3, objectName: 'file-vm-dev-03', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -18, durationSeconds: 245, dataBytes: 5900000000, error: null },
  { id: 20, clusterId: 3, objectName: 'SQL-STAGE-DEV', jobType: 'Backup', status: 'Succeeded', startOffsetHours: -16, durationSeconds: 120, dataBytes: 1900000000, error: null },
];

function offsetModifier(hours) {
  const minutes = Math.round(hours * 60);
  return `${minutes} minutes`;
}

module.exports = {
  id: 'rubrik',
  name: 'Rubrik',
  apiVersion: 1,
  migrations: [
    {
      version: 1,
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_clusters (
            id             INTEGER PRIMARY KEY,
            name           TEXT NOT NULL,
            model          TEXT NOT NULL,
            nodes          INTEGER NOT NULL,
            version        TEXT NOT NULL,
            used_bytes     INTEGER NOT NULL,
            capacity_bytes INTEGER NOT NULL,
            status         TEXT NOT NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_protected_objects (
            id            INTEGER PRIMARY KEY,
            cluster_id    INTEGER NOT NULL REFERENCES rubrik_clusters(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            type          TEXT NOT NULL,
            sla_domain    TEXT NOT NULL,
            last_backup_at TEXT NOT NULL,
            compliant     INTEGER NOT NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_jobs (
            id                  INTEGER PRIMARY KEY,
            cluster_id          INTEGER NOT NULL REFERENCES rubrik_clusters(id) ON DELETE CASCADE,
            object_name         TEXT NOT NULL,
            job_type            TEXT NOT NULL,
            status              TEXT NOT NULL,
            started_at          TEXT NOT NULL,
            ended_at            TEXT NOT NULL,
            duration_seconds    INTEGER NOT NULL,
            data_transferred_bytes INTEGER NOT NULL,
            error_message       TEXT
          )
        `);

        const seedCluster = db.prepare(
          `INSERT OR IGNORE INTO rubrik_clusters
             (id, name, model, nodes, version, used_bytes, capacity_bytes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const c of CLUSTERS) {
          seedCluster.run(c.id, c.name, c.model, c.nodes, c.version, c.usedBytes, c.capacityBytes, c.status);
        }

        const seedObject = db.prepare(
          `INSERT OR IGNORE INTO rubrik_protected_objects
             (id, cluster_id, name, type, sla_domain, last_backup_at, compliant)
           VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)`
        );
        for (const o of OBJECTS) {
          seedObject.run(o.id, o.clusterId, o.name, o.type, o.slaDomain, offsetModifier(o.offsetHours), o.compliant ? 1 : 0);
        }

        const seedJob = db.prepare(
          `INSERT OR IGNORE INTO rubrik_jobs
             (id, cluster_id, object_name, job_type, status, started_at, ended_at, duration_seconds, data_transferred_bytes, error_message)
           VALUES (?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), ?, ?, ?)`
        );
        for (const j of JOBS) {
          const endOffsetHours = j.startOffsetHours + j.durationSeconds / 3600;
          seedJob.run(
            j.id,
            j.clusterId,
            j.objectName,
            j.jobType,
            j.status,
            offsetModifier(j.startOffsetHours),
            offsetModifier(endOffsetHours),
            j.durationSeconds,
            j.dataBytes,
            j.error
          );
        }
      },
    },
  ],
  // createRouter must return a BARE (req, res, next) function — installed
  // plugins are loaded via require() on their own dist/backend/index.cjs and
  // cannot require the host's copy of express.
  createRouter(coreApi) {
    return function rubrikRouter(req, res, next) {
      if (req.method === 'GET' && req.path === '/overview') {
        const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
        const objectsTotal = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_protected_objects').get().n;
        const outOfCompliance = coreApi.db
          .prepare('SELECT COUNT(*) AS n FROM rubrik_protected_objects WHERE compliant = 0')
          .get().n;
        const jobs24h = coreApi.db
          .prepare("SELECT COUNT(*) AS n FROM rubrik_jobs WHERE started_at >= datetime('now', '-24 hours')")
          .get().n;
        const failed24h = coreApi.db
          .prepare("SELECT COUNT(*) AS n FROM rubrik_jobs WHERE started_at >= datetime('now', '-24 hours') AND status = 'Failed'")
          .get().n;
        const usedBytes = clusters.reduce((sum, c) => sum + c.used_bytes, 0);
        const capacityBytes = clusters.reduce((sum, c) => sum + c.capacity_bytes, 0);

        res.json({
          clusters: clusters.length,
          objects: objectsTotal,
          protected: objectsTotal - outOfCompliance,
          outOfCompliance,
          jobs24h,
          failed24h,
          usedBytes,
          capacityBytes,
        });
        return;
      }

      if (req.method === 'GET' && req.path === '/clusters') {
        const rows = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
        res.json(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            model: r.model,
            nodes: r.nodes,
            version: r.version,
            usedBytes: r.used_bytes,
            capacityBytes: r.capacity_bytes,
            status: r.status,
          }))
        );
        return;
      }

      if (req.method === 'GET' && req.path === '/objects') {
        const rows = coreApi.db
          .prepare(
            `SELECT o.*, c.name AS cluster_name
             FROM rubrik_protected_objects o
             JOIN rubrik_clusters c ON c.id = o.cluster_id
             ORDER BY o.id`
          )
          .all();
        res.json(
          rows.map((r) => ({
            id: r.id,
            clusterId: r.cluster_id,
            clusterName: r.cluster_name,
            name: r.name,
            type: r.type,
            slaDomain: r.sla_domain,
            lastBackupAt: r.last_backup_at,
            compliant: !!r.compliant,
          }))
        );
        return;
      }

      if (req.method === 'GET' && req.path === '/jobs') {
        const rows = coreApi.db
          .prepare(
            `SELECT j.*, c.name AS cluster_name
             FROM rubrik_jobs j
             JOIN rubrik_clusters c ON c.id = j.cluster_id
             ORDER BY j.started_at DESC, j.id DESC`
          )
          .all();
        res.json(
          rows.map((r) => ({
            id: r.id,
            clusterId: r.cluster_id,
            clusterName: r.cluster_name,
            objectName: r.object_name,
            jobType: r.job_type,
            status: r.status,
            startedAt: r.started_at,
            endedAt: r.ended_at,
            durationSeconds: r.duration_seconds,
            dataTransferredBytes: r.data_transferred_bytes,
            errorMessage: r.error_message,
          }))
        );
        return;
      }

      next();
    };
  },
  // Demo data is static (seeded by the migration) — no upstream to poll.
  // init()/stopAll() are no-ops so the host's plugin lifecycle stays uniform.
  createPoller(coreApi) {
    return {
      init() {
        coreApi.logger.info('[rubrik] Static demo data — no live polling configured.');
        return [];
      },
      stopAll() {},
    };
  },
  statusTables: ['rubrik_clusters', 'rubrik_protected_objects', 'rubrik_jobs'],
};
