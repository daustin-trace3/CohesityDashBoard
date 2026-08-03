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

// ---------------------------------------------------------------------
// v1.1.0 additions below. v1 (CLUSTERS/OBJECTS/JOBS/offsetModifier and the
// version:1 migration) is untouched byte-for-byte above this line.
// ---------------------------------------------------------------------

function dayOffsetModifier(daysAgo) {
  return `${-daysAgo} days`;
}

function isoDate(daysFromToday) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

// Deterministic PRNG (mulberry32) — used only to vary filler/demo rows so
// the seed is reproducible across environments without relying on Math.random.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// SLA domain metadata: frequency/retention/archival/replication policy and
// how each maps onto snapshot cadence for protected-object enrichment.
const SLA_META = {
  'Gold-4h': { frequency: 'every 4h', retention: '30d', snapshotsPerObj: 180, nextInHours: 2, archival: null, replication: 'rbk-dr-01' },
  'Silver-24h': { frequency: 'daily', retention: '90d', snapshotsPerObj: 90, nextInHours: 14, archival: 'aws-s3-archive', replication: 'rbk-dr-01' },
  'Bronze-7d': { frequency: 'weekly', retention: '1y', snapshotsPerObj: 52, nextInHours: 60, archival: 'azure-blob-dr', replication: null },
  'Platinum-1h': { frequency: 'hourly', retention: '7d', snapshotsPerObj: 168, nextInHours: 0.5, archival: null, replication: 'rbk-dr-01' },
};

// bytes/day growth rate per cluster, calibrated so the 90d regression in
// /capacity lands close to the seeded runway_days (45 / 210 / 380).
const GROWTH_PER_DAY = { 1: 2987000000000, 2: 365700000000, 3: 63158000000 };
const RUNWAY_DAYS = { 1: 45, 2: 210, 3: 380 };
const VERSION_STATUS = { 1: 'Current', 2: 'Current', 3: 'Update Available' };

// The two v1 objects already flagged compliant:false get chronic misses in
// the /compliance matrix so the story is consistent end to end.
const CHRONIC_NAMES = new Set(['file-vm-dev-01', 'SQL-HR-DR']);

const ANOMALY_EVENTS = [
  { id: 1, hoursAgo: 3, cluster: 'rbk-dr-01', objectName: 'SQL-BILLING-DR', objectType: 'MSSQL DB', probability: 0.97, encryption: 1, fileChanges: 48213, severity: 'Critical', status: 'Open', quarantined: 1 },
  { id: 2, hoursAgo: 18, cluster: 'rbk-dev-01', objectName: 'file-vm-dev-01', objectType: 'VM', probability: 0.42, encryption: 0, fileChanges: 1200, severity: 'Warning', status: 'Investigating', quarantined: 0 },
  { id: 3, hoursAgo: 5 * 24, cluster: 'rbk-prd-01', objectName: 'web-prd-02', objectType: 'VM', probability: 0.31, encryption: 0, fileChanges: 340, severity: 'Warning', status: 'Resolved', quarantined: 0 },
  { id: 4, hoursAgo: 9 * 24, cluster: 'rbk-prd-01', objectName: 'app-prd-02', objectType: 'VM', probability: 0.28, encryption: 0, fileChanges: 210, severity: 'Warning', status: 'Resolved', quarantined: 0 },
  { id: 5, hoursAgo: 15 * 24, cluster: 'rbk-dr-01', objectName: 'db-vm-dr-02', objectType: 'VM', probability: 0.35, encryption: 0, fileChanges: 480, severity: 'Warning', status: 'Resolved', quarantined: 0 },
  { id: 6, hoursAgo: 22 * 24, cluster: 'rbk-dev-01', objectName: 'file-vm-dev-03', objectType: 'VM', probability: 0.22, encryption: 0, fileChanges: 95, severity: 'Warning', status: 'Resolved', quarantined: 0 },
];

const THREAT_HUNTS = [
  { id: 1, name: 'IOC sweep — LockBit 3.0 filehash', iocType: 'File hash', status: 'Running', startedHoursAgo: 1 / 3, completedHoursAgo: null, clustersScanned: 2, snapshotsScanned: 340, objectsScanned: 18, matchesFound: 0 },
  { id: 2, name: 'IOC sweep — SQL-BILLING-DR encryption signatures', iocType: 'YARA rule', status: 'Completed', startedHoursAgo: 2.5, completedHoursAgo: 1.75, clustersScanned: 1, snapshotsScanned: 62, objectsScanned: 1, matchesFound: 2 },
  { id: 3, name: 'YARA sweep — ransomware note patterns', iocType: 'YARA rule', status: 'Completed', startedHoursAgo: 3 * 24, completedHoursAgo: 3 * 24 - 1, clustersScanned: 3, snapshotsScanned: 890, objectsScanned: 30, matchesFound: 0 },
  { id: 4, name: 'File pattern scan — webshell indicators', iocType: 'File pattern', status: 'Completed', startedHoursAgo: 6 * 24, completedHoursAgo: 6 * 24 - 2, clustersScanned: 3, snapshotsScanned: 1240, objectsScanned: 30, matchesFound: 0 },
];

// Narrative events tie the anomaly, the threat hunt, and the two v1 failed
// jobs together into one coherent security story in the events feed.
const NARRATIVE_EVENTS = [
  { hoursAgo: 3, cluster: 'rbk-dr-01', severity: 'Critical', eventType: 'Security', objectName: 'SQL-BILLING-DR', message: 'Radar detected encryption anomaly (97% probability) on SQL-BILLING-DR' },
  { hoursAgo: 3 - 2 / 60, cluster: 'rbk-dr-01', severity: 'Info', eventType: 'Security', objectName: 'SQL-BILLING-DR', message: 'Snapshot quarantined pending investigation' },
  { hoursAgo: 2.5, cluster: 'rbk-dr-01', severity: 'Info', eventType: 'Security', objectName: null, message: "Threat hunt 'IOC sweep — SQL-BILLING-DR encryption signatures' started" },
  { hoursAgo: 1.75, cluster: 'rbk-dr-01', severity: 'Warning', eventType: 'Security', objectName: 'SQL-BILLING-DR', message: 'Threat hunt completed — 2 IOC matches found' },
  { hoursAgo: 18, cluster: 'rbk-dev-01', severity: 'Warning', eventType: 'Security', objectName: 'file-vm-dev-01', message: 'Radar detected anomalous file activity (42% probability)' },
  { hoursAgo: 8, cluster: 'rbk-dr-01', severity: 'Critical', eventType: 'Backup', objectName: 'SQL-BILLING-DR', message: 'Backup failed: Snapshot mount timeout: exceeded 45s waiting for VSS quiesce on host dr-sql-02' },
  { hoursAgo: 12, cluster: 'rbk-dr-01', severity: 'Critical', eventType: 'Backup', objectName: 'SQL-HR-DR', message: 'Backup failed: Authentication failed: service account credentials expired (AD trust)' },
  { hoursAgo: 5 * 24, cluster: 'rbk-dev-01', severity: 'Warning', eventType: 'System', objectName: null, message: 'Node reboot completed: rbk-dev-01-node3' },
  { hoursAgo: 6 * 24, cluster: 'rbk-prd-01', severity: 'Info', eventType: 'System', objectName: null, message: 'Cluster software updated to 9.2.1-p3' },
  { hoursAgo: 2 * 24, cluster: 'rbk-dev-01', severity: 'Info', eventType: 'Maintenance', objectName: null, message: 'Scheduled maintenance window started' },
];

const ROUTINE_TEMPLATES = [
  { eventType: 'Backup', severity: 'Info', msg: (o) => `Backup completed for ${o}` },
  { eventType: 'Replication', severity: 'Info', msg: (o) => `Replication sync completed for ${o}` },
  { eventType: 'Archival', severity: 'Info', msg: (o) => `Archival job completed for ${o}` },
];

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
    {
      version: 2,
      up(db) {
        // --- pragma-guarded ALTERs on v1 tables ---
        ensureColumn(db, 'rubrik_clusters', 'version_status', 'TEXT');
        ensureColumn(db, 'rubrik_clusters', 'runway_days', 'INTEGER');
        ensureColumn(db, 'rubrik_protected_objects', 'location', 'TEXT');
        ensureColumn(db, 'rubrik_protected_objects', 'next_snapshot_at', 'DATETIME');
        ensureColumn(db, 'rubrik_protected_objects', 'snapshot_count', 'INTEGER');
        ensureColumn(db, 'rubrik_protected_objects', 'local_storage_bytes', 'INTEGER');
        ensureColumn(db, 'rubrik_protected_objects', 'archived_bytes', 'INTEGER');

        // --- new tables ---
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_sla_domains (
            id                 INTEGER PRIMARY KEY,
            name               TEXT NOT NULL UNIQUE,
            snapshot_frequency TEXT NOT NULL,
            retention          TEXT NOT NULL,
            object_count       INTEGER NOT NULL,
            compliance_pct     REAL NOT NULL,
            archival_location  TEXT,
            replication_target TEXT
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_capacity_history (
            cluster    TEXT NOT NULL,
            day        TEXT NOT NULL,
            used_bytes INTEGER NOT NULL,
            UNIQUE(cluster, day)
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_replication_pairs (
            id             INTEGER PRIMARY KEY,
            source_cluster TEXT NOT NULL,
            target_cluster TEXT NOT NULL,
            objects        INTEGER NOT NULL,
            lag_seconds    INTEGER NOT NULL,
            status         TEXT NOT NULL,
            last_sync_at   DATETIME NOT NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_archival_locations (
            id             INTEGER PRIMARY KEY,
            name           TEXT NOT NULL,
            type           TEXT NOT NULL,
            archived_bytes INTEGER NOT NULL,
            object_count   INTEGER NOT NULL,
            status         TEXT NOT NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_anomaly_events (
            id                    INTEGER PRIMARY KEY,
            detected_at           DATETIME NOT NULL,
            cluster                TEXT NOT NULL,
            object_name           TEXT NOT NULL,
            object_type           TEXT NOT NULL,
            anomaly_probability   REAL NOT NULL,
            encryption_detected   INTEGER NOT NULL,
            file_changes          INTEGER NOT NULL,
            severity              TEXT NOT NULL,
            status                TEXT NOT NULL,
            snapshot_quarantined  INTEGER NOT NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_threat_hunts (
            id                 INTEGER PRIMARY KEY,
            name               TEXT NOT NULL,
            ioc_type           TEXT NOT NULL,
            status             TEXT NOT NULL,
            started_at         DATETIME NOT NULL,
            completed_at       DATETIME,
            clusters_scanned   INTEGER NOT NULL,
            snapshots_scanned  INTEGER NOT NULL,
            objects_scanned    INTEGER NOT NULL,
            matches_found      INTEGER NOT NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS rubrik_events (
            id          INTEGER PRIMARY KEY,
            at          DATETIME NOT NULL,
            cluster     TEXT,
            severity    TEXT NOT NULL,
            event_type  TEXT NOT NULL,
            object_name TEXT,
            message     TEXT NOT NULL
          )
        `);

        // --- backfill new cluster columns ---
        const updateCluster = db.prepare(
          `UPDATE rubrik_clusters SET version_status = ?, runway_days = ? WHERE id = ?`
        );
        for (const c of CLUSTERS) {
          updateCluster.run(VERSION_STATUS[c.id], RUNWAY_DAYS[c.id], c.id);
        }

        // --- backfill new protected-object columns ---
        const updateObject = db.prepare(
          `UPDATE rubrik_protected_objects
             SET location = ?, next_snapshot_at = datetime('now', ?), snapshot_count = ?,
                 local_storage_bytes = ?, archived_bytes = ?
           WHERE id = ?`
        );
        const s3Objects = [];
        const azureObjects = [];
        const prdReplicated = [];
        for (const o of OBJECTS) {
          const meta = SLA_META[o.slaDomain];
          const cluster = CLUSTERS.find((c) => c.id === o.clusterId);
          const location =
            o.type === 'MSSQL DB'
              ? `${cluster.name}-sql01`
              : o.type === 'NAS Share'
              ? `${cluster.name}-nas01`
              : o.type === 'EC2 Instance'
              ? `aws-us-east-1/${cluster.name}`
              : `vcenter01.corp.local/${cluster.name}`;
          const localBytes = 50000000000 + ((o.id * 6100000000) % 400000000000);
          const archivedBytes = meta.archival ? Math.round(localBytes * 0.15) : 0;
          const snapshotCount = meta.snapshotsPerObj + (o.id % 7);
          const nextInHours = meta.nextInHours + (o.id % 5) * 0.3;

          updateObject.run(location, offsetModifier(nextInHours), snapshotCount, localBytes, archivedBytes, o.id);

          if (meta.archival === 'aws-s3-archive') s3Objects.push({ o, archivedBytes });
          if (meta.archival === 'azure-blob-dr') azureObjects.push({ o, archivedBytes });
          if (meta.replication === 'rbk-dr-01' && o.clusterId === 1) prdReplicated.push(o);
        }

        // --- SLA domains (compliance derived from the v1 seed data) ---
        const slaNames = Object.keys(SLA_META);
        const seedSla = db.prepare(
          `INSERT OR IGNORE INTO rubrik_sla_domains
             (id, name, snapshot_frequency, retention, object_count, compliance_pct, archival_location, replication_target)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        slaNames.forEach((name, idx) => {
          const meta = SLA_META[name];
          const objs = OBJECTS.filter((o) => o.slaDomain === name);
          const objectCount = objs.length;
          const compliantCount = objs.filter((o) => o.compliant).length;
          const compliancePct = objectCount > 0 ? Math.round((compliantCount / objectCount) * 1000) / 10 : 100;
          seedSla.run(idx + 1, name, meta.frequency, meta.retention, objectCount, compliancePct, meta.archival, meta.replication);
        });

        // --- 90 days of capacity history per cluster, anchored at today's
        // used_bytes exactly (no wiggle on the most recent day). ---
        const seedCapacity = db.prepare(
          `INSERT OR IGNORE INTO rubrik_capacity_history (cluster, day, used_bytes) VALUES (?, date('now', ?), ?)`
        );
        for (let dayIdx = 0; dayIdx < 90; dayIdx++) {
          const daysAgo = 89 - dayIdx;
          for (const c of CLUSTERS) {
            const growth = GROWTH_PER_DAY[c.id];
            const wiggle = daysAgo === 0 ? 0 : Math.round(Math.sin(dayIdx * 0.7 + c.id) * growth * 0.15);
            const used = Math.max(0, Math.round(c.usedBytes - growth * daysAgo + wiggle));
            seedCapacity.run(c.name, dayOffsetModifier(daysAgo), used);
          }
        }

        // --- replication pairs ---
        const seedReplication = db.prepare(
          `INSERT OR IGNORE INTO rubrik_replication_pairs
             (id, source_cluster, target_cluster, objects, lag_seconds, status, last_sync_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`
        );
        seedReplication.run(1, 'rbk-prd-01', 'rbk-dr-01', prdReplicated.length, 45, 'Healthy', offsetModifier(-45 / 3600));
        seedReplication.run(2, 'rbk-dev-01', 'rbk-dr-01', 3, 32400, 'Lagging', offsetModifier(-9));

        // --- archival locations ---
        const seedArchival = db.prepare(
          `INSERT OR IGNORE INTO rubrik_archival_locations
             (id, name, type, archived_bytes, object_count, status)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        seedArchival.run(
          1,
          'aws-s3-archive',
          'S3',
          s3Objects.reduce((sum, x) => sum + x.archivedBytes, 0),
          s3Objects.length,
          'Active'
        );
        seedArchival.run(
          2,
          'azure-blob-dr',
          'Azure',
          azureObjects.reduce((sum, x) => sum + x.archivedBytes, 0),
          azureObjects.length,
          'Active'
        );

        // --- Radar anomaly events ---
        const seedAnomaly = db.prepare(
          `INSERT OR IGNORE INTO rubrik_anomaly_events
             (id, detected_at, cluster, object_name, object_type, anomaly_probability, encryption_detected, file_changes, severity, status, snapshot_quarantined)
           VALUES (?, datetime('now', ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const a of ANOMALY_EVENTS) {
          seedAnomaly.run(
            a.id,
            offsetModifier(-a.hoursAgo),
            a.cluster,
            a.objectName,
            a.objectType,
            a.probability,
            a.encryption,
            a.fileChanges,
            a.severity,
            a.status,
            a.quarantined
          );
        }

        // --- threat hunts ---
        const nowIso = db.prepare(`SELECT datetime('now') AS v`).get().v;
        const seedHunt = db.prepare(
          `INSERT OR IGNORE INTO rubrik_threat_hunts
             (id, name, ioc_type, status, started_at, completed_at, clusters_scanned, snapshots_scanned, objects_scanned, matches_found)
           VALUES (?, ?, ?, ?, datetime('now', ?), ?, ?, ?, ?, ?)`
        );
        for (const h of THREAT_HUNTS) {
          const completedAt =
            h.completedHoursAgo == null ? null : db.prepare(`SELECT datetime(?, ?) AS v`).get(nowIso, offsetModifier(-h.completedHoursAgo)).v;
          seedHunt.run(
            h.id,
            h.name,
            h.iocType,
            h.status,
            offsetModifier(-h.startedHoursAgo),
            completedAt,
            h.clustersScanned,
            h.snapshotsScanned,
            h.objectsScanned,
            h.matchesFound
          );
        }

        // --- events feed: narrative rows + deterministic filler up to ~40 ---
        const seedEvent = db.prepare(
          `INSERT OR IGNORE INTO rubrik_events (id, at, cluster, severity, event_type, object_name, message)
           VALUES (?, datetime('now', ?), ?, ?, ?, ?, ?)`
        );
        let eventId = 1;
        for (const e of NARRATIVE_EVENTS) {
          seedEvent.run(eventId++, offsetModifier(-e.hoursAgo), e.cluster, e.severity, e.eventType, e.objectName, e.message);
        }
        const rnd = mulberry32(9182);
        while (eventId <= 40) {
          const obj = OBJECTS[Math.floor(rnd() * OBJECTS.length)];
          const cluster = CLUSTERS.find((c) => c.id === obj.clusterId);
          const tmpl = ROUTINE_TEMPLATES[Math.floor(rnd() * ROUTINE_TEMPLATES.length)];
          const hoursAgo = rnd() * 168;
          seedEvent.run(eventId++, offsetModifier(-hoursAgo), cluster.name, tmpl.severity, tmpl.eventType, obj.name, tmpl.msg(obj.name));
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

        const slaDomains = coreApi.db.prepare('SELECT * FROM rubrik_sla_domains').all();
        const weighted = slaDomains.reduce((acc, s) => acc + s.compliance_pct * s.object_count, 0);
        const weightedCount = slaDomains.reduce((acc, s) => acc + s.object_count, 0);
        const slaCompliancePct = weightedCount > 0 ? Math.round((weighted / weightedCount) * 10) / 10 : 100;

        const openAnomaly = coreApi.db
          .prepare("SELECT MAX(anomaly_probability) AS maxProb FROM rubrik_anomaly_events WHERE status = 'Open'")
          .get();
        const anomaliesOpen = coreApi.db.prepare("SELECT COUNT(*) AS n FROM rubrik_anomaly_events WHERE status = 'Open'").get().n;
        const lastDetectedAt = coreApi.db.prepare('SELECT MAX(detected_at) AS v FROM rubrik_anomaly_events').get().v;
        const overallMaxProb = coreApi.db.prepare('SELECT MAX(anomaly_probability) AS v FROM rubrik_anomaly_events').get().v;

        const huntsRunning = coreApi.db.prepare("SELECT COUNT(*) AS n FROM rubrik_threat_hunts WHERE status = 'Running'").get().n;
        const huntsCompleted7d = coreApi.db
          .prepare("SELECT COUNT(*) AS n FROM rubrik_threat_hunts WHERE status = 'Completed' AND completed_at >= datetime('now', '-7 days')")
          .get().n;
        const huntMatches = coreApi.db
          .prepare("SELECT COALESCE(SUM(matches_found), 0) AS n FROM rubrik_threat_hunts WHERE status = 'Completed'")
          .get().n;

        const replicationPairs = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_replication_pairs').get().n;
        const replicationLagging = coreApi.db
          .prepare("SELECT COUNT(*) AS n FROM rubrik_replication_pairs WHERE status = 'Lagging'")
          .get().n;

        const archivalLocations = coreApi.db.prepare('SELECT COUNT(*) AS n FROM rubrik_archival_locations').get().n;
        const archivedBytes = coreApi.db.prepare('SELECT COALESCE(SUM(archived_bytes), 0) AS n FROM rubrik_archival_locations').get().n;

        const minRunway = clusters.reduce((min, c) => (c.runway_days != null && c.runway_days < min ? c.runway_days : min), Infinity);
        let growth30dBytes = 0;
        for (const c of clusters) {
          const now = coreApi.db
            .prepare('SELECT used_bytes FROM rubrik_capacity_history WHERE cluster = ? ORDER BY day DESC LIMIT 1')
            .get(c.name);
          const past = coreApi.db
            .prepare("SELECT used_bytes FROM rubrik_capacity_history WHERE cluster = ? AND day <= date('now', '-30 days') ORDER BY day DESC LIMIT 1")
            .get(c.name);
          if (now && past) growth30dBytes += now.used_bytes - past.used_bytes;
        }

        res.json({
          clusters: clusters.length,
          objects: objectsTotal,
          protected: objectsTotal - outOfCompliance,
          outOfCompliance,
          jobs24h,
          failed24h,
          usedBytes,
          capacityBytes,
          slaCompliancePct,
          anomalies: {
            open: anomaliesOpen,
            lastDetectedAt,
            maxProbability: openAnomaly && openAnomaly.maxProb != null ? openAnomaly.maxProb : overallMaxProb,
          },
          threatHunts: { running: huntsRunning, completed7d: huntsCompleted7d, matches: huntMatches },
          replication: { pairs: replicationPairs, lagging: replicationLagging },
          archival: { locations: archivalLocations, archivedBytes },
          capacity: {
            usedBytes,
            capacityBytes,
            runwayDays: Number.isFinite(minRunway) ? minRunway : null,
            growth30dBytes,
          },
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
            versionStatus: r.version_status,
            runwayDays: r.runway_days,
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
            location: r.location,
            nextSnapshotAt: r.next_snapshot_at,
            snapshotCount: r.snapshot_count,
            localStorageBytes: r.local_storage_bytes,
            archivedBytes: r.archived_bytes,
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

      if (req.method === 'GET' && req.path === '/sla-domains') {
        const rows = coreApi.db.prepare('SELECT * FROM rubrik_sla_domains ORDER BY id').all();
        res.json(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            snapshotFrequency: r.snapshot_frequency,
            retention: r.retention,
            objectCount: r.object_count,
            compliancePct: r.compliance_pct,
            archivalLocation: r.archival_location,
            replicationTarget: r.replication_target,
          }))
        );
        return;
      }

      if (req.method === 'GET' && req.path === '/compliance') {
        const rows = coreApi.db
          .prepare(
            `SELECT o.name, o.type, o.sla_domain, c.name AS cluster_name
             FROM rubrik_protected_objects o
             JOIN rubrik_clusters c ON c.id = o.cluster_id
             ORDER BY o.id`
          )
          .all();
        const result = rows.map((r) => {
          const cadence = r.sla_domain === 'Bronze-7d' ? 7 : 1;
          const chronic = CHRONIC_NAMES.has(r.name);
          const days = [];
          for (let i = 0; i < 14; i++) {
            const expected = i % cadence === cadence - 1;
            let status;
            if (!expected) {
              status = 'none';
            } else {
              const missThisOne = chronic && (i === cadence - 1 || i === 13 || (cadence === 1 && i === 3));
              status = missThisOne ? 'missed' : 'ok';
            }
            days.push({ day: isoDate(i - 13), status });
          }
          return { name: r.name, type: r.type, cluster: r.cluster_name, slaDomain: r.sla_domain, days };
        });
        res.json(result);
        return;
      }

      if (req.method === 'GET' && req.path === '/capacity') {
        const clusters = coreApi.db.prepare('SELECT * FROM rubrik_clusters ORDER BY id').all();
        const out = clusters.map((c) => {
          const history = coreApi.db
            .prepare('SELECT day, used_bytes FROM rubrik_capacity_history WHERE cluster = ? ORDER BY day ASC')
            .all(c.name);
          const points = history.map((h, idx) => ({ x: idx, y: h.used_bytes }));
          const n = points.length;
          const sumX = points.reduce((s, p) => s + p.x, 0);
          const sumY = points.reduce((s, p) => s + p.y, 0);
          const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
          const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
          const denom = n * sumXX - sumX * sumX;
          let slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
          slope = Math.max(slope, c.capacity_bytes * 0.0001);

          const lastUsed = history.length > 0 ? history[history.length - 1].used_bytes : c.used_bytes;
          const forecast = [];
          for (let i = 1; i <= 90; i++) {
            const raw = lastUsed + slope * i;
            forecast.push({ day: isoDate(i), usedBytes: Math.round(Math.min(c.capacity_bytes, raw)) });
          }
          const runwayDays = Math.max(1, Math.round((c.capacity_bytes - lastUsed) / slope));

          return {
            cluster: c.name,
            capacityBytes: c.capacity_bytes,
            series: history.map((h) => ({ day: h.day, usedBytes: h.used_bytes })),
            forecast,
            runwayDays,
            growthPerDayBytes: Math.round(slope),
          };
        });
        res.json({ clusters: out });
        return;
      }

      if (req.method === 'GET' && req.path === '/replication') {
        const pairs = coreApi.db.prepare('SELECT * FROM rubrik_replication_pairs ORDER BY id').all();
        const archival = coreApi.db.prepare('SELECT * FROM rubrik_archival_locations ORDER BY id').all();
        res.json({
          pairs: pairs.map((p) => ({
            id: p.id,
            sourceCluster: p.source_cluster,
            targetCluster: p.target_cluster,
            objects: p.objects,
            lagSeconds: p.lag_seconds,
            status: p.status,
            lastSyncAt: p.last_sync_at,
          })),
          archival: archival.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            archivedBytes: a.archived_bytes,
            objectCount: a.object_count,
            status: a.status,
          })),
        });
        return;
      }

      if (req.method === 'GET' && req.path === '/security') {
        const anomalies = coreApi.db.prepare('SELECT * FROM rubrik_anomaly_events ORDER BY detected_at DESC').all();
        const hunts = coreApi.db.prepare('SELECT * FROM rubrik_threat_hunts ORDER BY started_at DESC').all();
        const openAnomalies = anomalies.filter((a) => a.status === 'Open').length;
        const quarantinedSnapshots = anomalies.filter((a) => a.snapshot_quarantined).length;
        const runningHunts = hunts.filter((h) => h.status === 'Running').length;
        const matches = hunts.reduce((sum, h) => sum + h.matches_found, 0);

        res.json({
          anomalies: anomalies.map((a) => ({
            id: a.id,
            detectedAt: a.detected_at,
            cluster: a.cluster,
            objectName: a.object_name,
            objectType: a.object_type,
            anomalyProbability: a.anomaly_probability,
            encryptionDetected: !!a.encryption_detected,
            fileChanges: a.file_changes,
            severity: a.severity,
            status: a.status,
            snapshotQuarantined: !!a.snapshot_quarantined,
          })),
          hunts: hunts.map((h) => ({
            id: h.id,
            name: h.name,
            iocType: h.ioc_type,
            status: h.status,
            startedAt: h.started_at,
            completedAt: h.completed_at,
            clustersScanned: h.clusters_scanned,
            snapshotsScanned: h.snapshots_scanned,
            objectsScanned: h.objects_scanned,
            matchesFound: h.matches_found,
          })),
          summary: { openAnomalies, quarantinedSnapshots, runningHunts, matches },
        });
        return;
      }

      if (req.method === 'GET' && req.path === '/events') {
        const days = Math.max(1, Math.min(90, parseInt(req.query && req.query.days, 10) || 7));
        const severity = req.query && req.query.severity;
        let sql = "SELECT * FROM rubrik_events WHERE at >= datetime('now', ?)";
        const params = [`-${days} days`];
        if (severity) {
          sql += ' AND severity = ?';
          params.push(severity);
        }
        sql += ' ORDER BY at DESC, id DESC LIMIT 200';
        const rows = coreApi.db.prepare(sql).all(...params);
        res.json(
          rows.map((r) => ({
            id: r.id,
            at: r.at,
            cluster: r.cluster,
            severity: r.severity,
            eventType: r.event_type,
            objectName: r.object_name,
            message: r.message,
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
  statusTables: [
    'rubrik_clusters',
    'rubrik_protected_objects',
    'rubrik_jobs',
    'rubrik_sla_domains',
    'rubrik_capacity_history',
    'rubrik_replication_pairs',
    'rubrik_archival_locations',
    'rubrik_anomaly_events',
    'rubrik_threat_hunts',
    'rubrik_events',
  ],
};
