// Rubrik demo platform migrations (versions 1-3), moved verbatim from the
// v1.2.1 monolithic backend/src/index.js as part of the v2.0.0 file
// restructure (plugin-sdk/rubrik foundation). SQL/seed logic is
// byte-identical to the original — only the module boundary changed.
//
// POLICY (v2.1.9): demo/fake content (INSERT/UPDATE of seed rows) only ever
// runs when DASHBOARD_DEMO=1. Schema (CREATE TABLE / ensureColumn / indexes)
// ALWAYS runs, on every instance, so the plugin's routes/pages work against
// an empty estate on a non-demo install. Version 5 purges any previously
// seeded rows when demo mode is off, cleaning instances that installed
// earlier plugin versions before this policy existed.

const isDemo = () => process.env.DASHBOARD_DEMO === '1';

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

// ---------------------------------------------------------------------
// v1.2.0 additions below: Settings/connections page (rubrik_connections).
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

// ---------------------------------------------------------------------
// v2.0.0 additions below (version 4): Cohesity-parity mirror — alerts,
// per-object protection run history, workload trends, licensing meters,
// SLA-domain policy extensions, sources, and replication-run granularity.
// The SQL-BILLING-DR / SQL-HR-DR chronic-failure narrative from v1/v2 is
// carried forward here so alerts and run history stay coherent with it.
// ---------------------------------------------------------------------

const CHRONIC_FAIL_OBJECTS = new Set(['SQL-BILLING-DR', 'SQL-HR-DR']);

const RUN_TYPE_RANGES = {
  Backup: { durMin: 120, durMax: 900, bytesMin: 1500000000, bytesMax: 25000000000 },
  Replication: { durMin: 60, durMax: 500, bytesMin: 1000000000, bytesMax: 15000000000 },
  Archival: { durMin: 400, durMax: 1400, bytesMin: 5000000000, bytesMax: 45000000000 },
};

const GENERIC_FAIL_ERRORS = [
  'Snapshot creation failed: insufficient space on staging pool',
  'Network timeout while transferring blocks to replica target',
  'Backup skipped: object not reachable (host unresponsive)',
  'Archival upload failed: cloud provider throttling (429)',
];

const GENERIC_WARN_ERRORS = [
  'Completed with warnings: retry required for 2 files',
  'Completed with warnings: snapshot retention approaching limit',
];

const CHRONIC_ERROR_BY_OBJECT = {
  'SQL-BILLING-DR': 'Snapshot mount timeout: exceeded 45s waiting for VSS quiesce on host dr-sql-02',
  'SQL-HR-DR': 'Authentication failed: service account credentials expired (AD trust)',
};

const ALERT_TYPES = ['Backup', 'Replication', 'Capacity', 'Security', 'System'];
const ALERT_SEVERITIES = ['critical', 'warning', 'info'];

const WORKLOAD_DEFS = [
  { workload: 'VM', count: 12, unprotected: 2, bytesPerObj: 9000000000, reduction: 0.55 },
  { workload: 'SQL', count: 6, unprotected: 1, bytesPerObj: 5000000000, reduction: 0.35 },
  { workload: 'NAS', count: 6, unprotected: 1, bytesPerObj: 20000000000, reduction: 0.7 },
  { workload: 'EC2', count: 6, unprotected: 0, bytesPerObj: 4000000000, reduction: 0.5 },
  { workload: 'VolumeGroup', count: 8, unprotected: 1, bytesPerObj: 12000000000, reduction: 0.6 },
];

const WORKLOAD_GROWTH_PER_DAY = { VM: 0.0012, SQL: 0.0009, NAS: 0.0007, EC2: 0.0015, VolumeGroup: 0.0006 };

const SOURCES = [
  { id: 1, name: 'vCenter01-PRD', cluster: 'rbk-prd-01', sourceType: 'vCenter', environment: 'Production', protected: 10, unprotected: 0, unprotectedBytes: 0 },
  { id: 2, name: 'vCenter02-DR', cluster: 'rbk-dr-01', sourceType: 'vCenter', environment: 'DR', protected: 3, unprotected: 0, unprotectedBytes: 0 },
  { id: 3, name: 'vCenter03-DEV', cluster: 'rbk-dev-01', sourceType: 'vCenter', environment: 'Development', protected: 2, unprotected: 1, unprotectedBytes: 45000000000 },
  { id: 4, name: 'SQL-Host-PRD01', cluster: 'rbk-prd-01', sourceType: 'SQL Host', environment: 'Production', protected: 2, unprotected: 0, unprotectedBytes: 0 },
  { id: 5, name: 'SQL-Host-DR01', cluster: 'rbk-dr-01', sourceType: 'SQL Host', environment: 'DR', protected: 1, unprotected: 1, unprotectedBytes: 120000000000 },
  { id: 6, name: 'SQL-Host-DEV01', cluster: 'rbk-dev-01', sourceType: 'SQL Host', environment: 'Development', protected: 2, unprotected: 0, unprotectedBytes: 0 },
  { id: 7, name: 'NAS-Array-PRD', cluster: 'rbk-prd-01', sourceType: 'NAS Array', environment: 'Production', protected: 2, unprotected: 0, unprotectedBytes: 0 },
  { id: 8, name: 'NAS-Array-DR', cluster: 'rbk-dr-01', sourceType: 'NAS Array', environment: 'DR', protected: 2, unprotected: 0, unprotectedBytes: 0 },
  { id: 9, name: 'NAS-Array-DEV', cluster: 'rbk-dev-01', sourceType: 'NAS Array', environment: 'Development', protected: 2, unprotected: 0, unprotectedBytes: 0 },
  { id: 10, name: 'AWS-Account-Prod', cluster: 'rbk-prd-01', sourceType: 'AWS Account', environment: 'Production', protected: 2, unprotected: 0, unprotectedBytes: 0 },
  { id: 11, name: 'AWS-Account-DR', cluster: 'rbk-dr-01', sourceType: 'AWS Account', environment: 'DR', protected: 2, unprotected: 0, unprotectedBytes: 0 },
  { id: 12, name: 'Physical-Dev-Hosts', cluster: 'rbk-dev-01', sourceType: 'Physical', environment: 'Development', protected: 2, unprotected: 0, unprotectedBytes: 0 },
];

function retentionDaysFor(text) {
  if (text === '30d') return 30;
  if (text === '90d') return 90;
  if (text === '1y') return 365;
  if (text === '7d') return 7;
  return 30;
}

function rangeFor(min, max, rnd) {
  return Math.round(min + rnd() * (max - min));
}

const migrations = [
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

      if (!isDemo()) return;

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

      if (!isDemo()) return;

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
  {
    version: 3,
    up(db) {
      // --- Settings/connections page: user-registered RSC / CDM
      // connections. No seed rows — starts empty (that's the point). ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS rubrik_connections (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          name                  TEXT NOT NULL UNIQUE,
          kind                  TEXT NOT NULL CHECK(kind IN ('rsc', 'cdm')),
          endpoint              TEXT NOT NULL,
          identity              TEXT,
          encrypted_credentials TEXT,
          created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // --- schema: always runs, demo or not ---
      ensureColumn(db, 'rubrik_clusters', 'software_status', 'TEXT');
      ensureColumn(db, 'rubrik_sla_domains', 'replication_targets', 'TEXT');
      ensureColumn(db, 'rubrik_sla_domains', 'archival_targets', 'TEXT');
      ensureColumn(db, 'rubrik_sla_domains', 'datalock', 'INTEGER');
      ensureColumn(db, 'rubrik_sla_domains', 'no_offsite', 'INTEGER');
      ensureColumn(db, 'rubrik_sla_domains', 'retention_days', 'INTEGER');
      db.exec(`
        CREATE TABLE IF NOT EXISTS rubrik_alerts (
          id               INTEGER PRIMARY KEY,
          cluster          TEXT NOT NULL,
          severity         TEXT NOT NULL CHECK(severity IN ('critical', 'warning', 'info')),
          alert_type       TEXT NOT NULL,
          description      TEXT NOT NULL,
          object_name      TEXT,
          first_seen       DATETIME NOT NULL,
          dismissed        INTEGER NOT NULL DEFAULT 0,
          resolved         INTEGER NOT NULL DEFAULT 0,
          resolution_note  TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS rubrik_protection_runs (
          id            INTEGER PRIMARY KEY,
          day           TEXT NOT NULL,
          cluster       TEXT NOT NULL,
          job_name      TEXT NOT NULL,
          object_name   TEXT NOT NULL,
          status        TEXT NOT NULL CHECK(status IN ('Succeeded', 'Failed', 'Warning', 'Running', 'Canceled')),
          run_type      TEXT NOT NULL CHECK(run_type IN ('Backup', 'Replication', 'Archival')),
          start_ms      INTEGER NOT NULL,
          duration_s    INTEGER NOT NULL,
          logical_bytes INTEGER NOT NULL,
          error_message TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS rubrik_workload_history (
          day               TEXT NOT NULL,
          workload          TEXT NOT NULL,
          protected_count   INTEGER NOT NULL,
          unprotected_count INTEGER NOT NULL,
          protected_bytes   INTEGER NOT NULL,
          logical_bytes     INTEGER NOT NULL,
          physical_bytes    INTEGER NOT NULL,
          UNIQUE(day, workload)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS rubrik_licensing (
          key            TEXT PRIMARY KEY CHECK(key IN ('capacity', 'cloud', 'security')),
          label          TEXT NOT NULL,
          consumed_bytes INTEGER NOT NULL,
          entitled_tb    REAL NOT NULL,
          basis          TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS rubrik_sources (
          id                 INTEGER PRIMARY KEY,
          name               TEXT NOT NULL,
          cluster            TEXT NOT NULL,
          source_type        TEXT NOT NULL,
          environment        TEXT NOT NULL,
          protected_count    INTEGER NOT NULL,
          unprotected_count  INTEGER NOT NULL,
          unprotected_bytes  INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS rubrik_replication_runs (
          id                 INTEGER PRIMARY KEY,
          job_name           TEXT NOT NULL,
          source_cluster     TEXT NOT NULL,
          target_cluster     TEXT NOT NULL,
          status             TEXT NOT NULL CHECK(status IN ('Active', 'Completed', 'Failed')),
          start_ms_offset    INTEGER NOT NULL,
          logical_bytes      INTEGER NOT NULL,
          transferred_bytes  INTEGER NOT NULL,
          percent_complete   REAL NOT NULL
        )
      `);

      if (!isDemo()) return;

      // --- demo seed content below: always skipped when DASHBOARD_DEMO !== '1' ---

      // --- version drift + software_status column ---
      db.prepare(`UPDATE rubrik_clusters SET software_status = ? WHERE id = ?`).run('Current', 1);
      db.prepare(`UPDATE rubrik_clusters SET software_status = ? WHERE id = ?`).run('Current', 2);
      db.prepare(`UPDATE rubrik_clusters SET version = ?, software_status = ? WHERE id = ?`).run('9.1.2-p8', 'Outdated', 3);

      // --- rubrik_sla_domains (== "rubrik_policies") extension ---
      const updateSla = db.prepare(
        `UPDATE rubrik_sla_domains
           SET replication_targets = ?, archival_targets = ?, datalock = ?, no_offsite = ?, retention_days = ?
         WHERE name = ?`
      );
      for (const name of Object.keys(SLA_META)) {
        const meta = SLA_META[name];
        const replicationTargets = meta.replication ? JSON.stringify([meta.replication]) : JSON.stringify([]);
        const archivalTargets = meta.archival ? JSON.stringify([meta.archival]) : JSON.stringify([]);
        const datalock = name === 'Gold-4h' ? 1 : 0;
        const noOffsite = name === 'Bronze-7d' ? 1 : 0;
        updateSla.run(replicationTargets, archivalTargets, datalock, noOffsite, retentionDaysFor(meta.retention), name);
      }

      // --- rubrik_alerts: ~45 rows over 14 days ---
      const seedAlert = db.prepare(
        `INSERT OR IGNORE INTO rubrik_alerts
           (id, cluster, severity, alert_type, description, object_name, first_seen, dismissed, resolved, resolution_note)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?)`
      );
      const alertRnd = mulberry32(55021);
      let alertId = 1;
      // The pinned SQL-BILLING-DR anomaly gets a critical Security alert first, open (unresolved).
      seedAlert.run(
        alertId++,
        'rbk-dr-01',
        'critical',
        'Security',
        'Radar detected encryption anomaly (97% probability) on SQL-BILLING-DR',
        'SQL-BILLING-DR',
        offsetModifier(-3),
        0,
        0,
        null
      );
      // Chronic-failure backup alerts for the two narrative objects.
      seedAlert.run(alertId++, 'rbk-dr-01', 'critical', 'Backup', CHRONIC_ERROR_BY_OBJECT['SQL-BILLING-DR'], 'SQL-BILLING-DR', offsetModifier(-8), 0, 0, null);
      seedAlert.run(alertId++, 'rbk-dr-01', 'critical', 'Backup', CHRONIC_ERROR_BY_OBJECT['SQL-HR-DR'], 'SQL-HR-DR', offsetModifier(-12), 0, 0, null);

      const resolvedTarget = 8;
      const dismissedTarget = 5;
      let resolvedSoFar = 0;
      let dismissedSoFar = 0;
      while (alertId <= 45) {
        const hoursAgo = alertRnd() * 14 * 24;
        const cluster = CLUSTERS[Math.floor(alertRnd() * CLUSTERS.length)].name;
        const alertType = ALERT_TYPES[Math.floor(alertRnd() * ALERT_TYPES.length)];
        const severity = ALERT_SEVERITIES[Math.floor(alertRnd() * ALERT_SEVERITIES.length)];
        const obj = OBJECTS[Math.floor(alertRnd() * OBJECTS.length)];
        const descByType = {
          Backup: `Backup job for ${obj.name} exceeded expected duration`,
          Replication: `Replication lag threshold exceeded for ${cluster}`,
          Capacity: `${cluster} capacity utilization crossed warning threshold`,
          Security: `Radar flagged unusual file activity on ${obj.name}`,
          System: `${cluster} node health check reported a transient issue`,
        };
        let dismissed = 0;
        let resolved = 0;
        let resolutionNote = null;
        const remaining = 45 - alertId;
        if (resolvedSoFar < resolvedTarget && (alertRnd() < 0.25 || remaining <= resolvedTarget - resolvedSoFar)) {
          resolved = 1;
          resolvedSoFar++;
          resolutionNote = 'Resolved: condition cleared on next successful run';
        } else if (dismissedSoFar < dismissedTarget && (alertRnd() < 0.2 || remaining <= dismissedTarget - dismissedSoFar)) {
          dismissed = 1;
          dismissedSoFar++;
        }
        seedAlert.run(alertId++, cluster, severity, alertType, descByType[alertType], obj.name, offsetModifier(-hoursAgo), dismissed, resolved, resolutionNote);
      }

      // --- rubrik_protection_runs: 30 days x ~40 runs/day ---
      const seedRun = db.prepare(
        `INSERT OR IGNORE INTO rubrik_protection_runs
           (id, day, cluster, job_name, object_name, status, run_type, start_ms, duration_s, logical_bytes, error_message)
         VALUES (?, date('now', ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const runRnd = mulberry32(30044);
      const nowMs = Date.now();
      let runId = 1;
      for (let dayIdx = 0; dayIdx < 30; dayIdx++) {
        const daysAgo = 29 - dayIdx;
        for (const o of OBJECTS) {
          const cluster = CLUSTERS.find((c) => c.id === o.clusterId);
          const meta = SLA_META[o.slaDomain];
          const chronic = CHRONIC_FAIL_OBJECTS.has(o.name);
          const runTypes = ['Backup'];
          if (meta.replication && (dayIdx + o.id) % 3 === 0) runTypes.push('Replication');
          if (meta.archival && (dayIdx + o.id) % 5 === 0) runTypes.push('Archival');

          for (const runType of runTypes) {
            const failRate = chronic ? 0.85 : 0.05;
            const warnRate = chronic ? 0.05 : 0.03;
            const r = runRnd();
            let status;
            if (r < failRate) status = 'Failed';
            else if (r < failRate + warnRate) status = 'Warning';
            else status = 'Succeeded';

            const ranges = RUN_TYPE_RANGES[runType];
            let durationS = rangeFor(ranges.durMin, ranges.durMax, runRnd);
            let logicalBytes = rangeFor(ranges.bytesMin, ranges.bytesMax, runRnd);
            let errorMessage = null;
            if (status === 'Failed') {
              durationS = Math.round(durationS * 0.15);
              logicalBytes = 0;
              errorMessage =
                chronic && CHRONIC_ERROR_BY_OBJECT[o.name]
                  ? CHRONIC_ERROR_BY_OBJECT[o.name]
                  : GENERIC_FAIL_ERRORS[Math.floor(runRnd() * GENERIC_FAIL_ERRORS.length)];
            } else if (status === 'Warning') {
              errorMessage = GENERIC_WARN_ERRORS[Math.floor(runRnd() * GENERIC_WARN_ERRORS.length)];
            }

            const startMs = nowMs - daysAgo * 86400000 - Math.floor(runRnd() * 20 * 3600000);
            const jobName = `${o.name} ${runType}`;

            seedRun.run(
              runId++,
              `-${daysAgo} days`,
              cluster.name,
              jobName,
              o.name,
              status,
              runType,
              startMs,
              durationS,
              logicalBytes,
              errorMessage
            );
          }
        }
      }

      // --- rubrik_workload_history: 180 days x 5 workload categories ---
      const seedWorkload = db.prepare(
        `INSERT OR IGNORE INTO rubrik_workload_history
           (day, workload, protected_count, unprotected_count, protected_bytes, logical_bytes, physical_bytes)
         VALUES (date('now', ?), ?, ?, ?, ?, ?, ?)`
      );
      const workloadRnd = mulberry32(18077);
      for (let dayIdx = 0; dayIdx < 180; dayIdx++) {
        const daysAgo = 179 - dayIdx;
        for (const w of WORKLOAD_DEFS) {
          const growth = 1 + WORKLOAD_GROWTH_PER_DAY[w.workload] * dayIdx;
          const wiggle = daysAgo === 0 ? 0 : Math.sin(dayIdx * 0.5 + w.workload.length) * 0.03;
          const baseLogical = Math.round(w.count * w.bytesPerObj * growth * (1 + wiggle));
          const logicalBytes = Math.max(0, baseLogical);
          const protectedBytes = logicalBytes;
          const physicalBytes = Math.round(logicalBytes * (1 - w.reduction));
          const unprotectedCount = daysAgo === 0 ? w.unprotected : Math.max(0, w.unprotected - Math.floor(workloadRnd() * 2));
          seedWorkload.run(dayOffsetModifier(daysAgo), w.workload, w.count, unprotectedCount, protectedBytes, logicalBytes, physicalBytes);
        }
      }

      // --- rubrik_licensing: 3 meters ---
      const TB = 1000000000000;
      const seedLicensing = db.prepare(
        `INSERT OR IGNORE INTO rubrik_licensing (key, label, consumed_bytes, entitled_tb, basis) VALUES (?, ?, ?, ?, ?)`
      );
      seedLicensing.run('capacity', 'Capacity', 61 * TB, 80, 'FETB');
      seedLicensing.run('cloud', 'Cloud Archival', 18 * TB, 40, 'Archived bytes');
      seedLicensing.run('security', 'Security (Radar)', 55 * TB, 80, 'Covered objects as bytes');

      // --- rubrik_sources ---
      const seedSource = db.prepare(
        `INSERT OR IGNORE INTO rubrik_sources
           (id, name, cluster, source_type, environment, protected_count, unprotected_count, unprotected_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const s of SOURCES) {
        seedSource.run(s.id, s.name, s.cluster, s.sourceType, s.environment, s.protected, s.unprotected, s.unprotectedBytes);
      }

      // --- rubrik_replication_runs: ~25 recent runs ---
      const seedReplRun = db.prepare(
        `INSERT OR IGNORE INTO rubrik_replication_runs
           (id, job_name, source_cluster, target_cluster, status, start_ms_offset, logical_bytes, transferred_bytes, percent_complete)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const replRnd = mulberry32(72091);
      const prdReplicatedObjs = OBJECTS.filter((o) => o.clusterId === 1 && SLA_META[o.slaDomain].replication === 'rbk-dr-01');
      const devReplicatedObjs = OBJECTS.filter((o) => o.clusterId === 3);
      const replPool = [
        ...prdReplicatedObjs.map((o) => ({ name: o.name, source: 'rbk-prd-01', target: 'rbk-dr-01' })),
        ...devReplicatedObjs.slice(0, 3).map((o) => ({ name: o.name, source: 'rbk-dev-01', target: 'rbk-dr-01' })),
      ];
      for (let i = 1; i <= 25; i++) {
        const pick = replPool[(i - 1) % replPool.length];
        const jobName = `${pick.name} Replication`;
        let status;
        let percentComplete;
        if (i <= 3) {
          status = 'Active';
          percentComplete = Math.round(20 + replRnd() * 60);
        } else if (i <= 5) {
          status = 'Failed';
          percentComplete = Math.round(replRnd() * 40);
        } else {
          status = 'Completed';
          percentComplete = 100;
        }
        const logicalBytes = rangeFor(1000000000, 15000000000, replRnd);
        const transferredBytes = status === 'Completed' ? logicalBytes : Math.round((logicalBytes * percentComplete) / 100);
        const startMsOffset = Math.round(replRnd() * 12 * 3600000) + (pick.source === 'rbk-dev-01' ? 9 * 3600000 : 0);
        seedReplRun.run(i, jobName, pick.source, pick.target, status, startMsOffset, logicalBytes, transferredBytes, percentComplete);
      }
    },
  },
  {
    version: 5,
    up(db) {
      // Purges seeded demo rows on any instance NOT running in demo mode.
      // Cleans up installs from before this policy existed (all seed
      // content used to run unconditionally). Complete no-op when demo
      // mode is on — the demo instance keeps its data. rubrik_connections
      // is deliberately excluded: it holds user-created connections, not
      // seed data. Idempotent: DELETE on an already-empty table is a no-op.
      if (isDemo()) return;

      const DATA_TABLES = [
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
        'rubrik_alerts',
        'rubrik_protection_runs',
        'rubrik_workload_history',
        'rubrik_licensing',
        'rubrik_sources',
        'rubrik_replication_runs',
      ];

      for (const table of DATA_TABLES) {
        const exists = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(table);
        if (exists) db.exec(`DELETE FROM ${table}`);
      }
    },
  },
];

module.exports = {
  migrations,
  CLUSTERS,
  OBJECTS,
  JOBS,
  isoDate,
  CHRONIC_NAMES,
};
