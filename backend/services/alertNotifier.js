const cron = require('node-cron');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../db/database');
const logger = require('../utils/logger');
const { getNotificationSettings, getSmtpPassword } = require('./settings');
const registry = require('../core/registry');
const { warrantyAlertFilter } = require('./dellWarrantyCover');

const SEVERITY_RANK = { info: 0, warning: 1, error: 2, critical: 3 };
const THRESHOLD_RANK = { info: 0, warning: 1, critical: 3 };
const MAX_EMAILS_PER_RUN = 25;
const STALE_DAYS = 7;

function normalizedRank(severity) {
  const s = String(severity || '').toLowerCase();
  if (s in SEVERITY_RANK) return SEVERITY_RANK[s];
  return SEVERITY_RANK.warning;
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return String(value);
}

/** Cohesity's alertCategory is a k-prefixed camelCase enum (kBackupRestore,
 *  kDisk, ...) - human label strips the leading k and spaces the words out. */
function cohesityTypeLabel(category) {
  return category.replace(/^k/, '').replace(/([A-Z])/g, ' $1').trim();
}

/** Active Cohesity alerts (not resolved, not dismissed). */
function collectCohesityAlerts() {
  const rows = db.prepare(`
    SELECT a.cohesity_alert_id AS alertId, a.cluster_id AS clusterId, a.severity AS severity,
           a.alert_type AS alertType, a.alert_category AS alertCategory, a.description AS description,
           a.first_seen AS firstSeen, a.last_updated AS lastSeen, c.name AS hostName
    FROM alerts a JOIN clusters c ON a.cluster_id = c.id
    WHERE a.resolved = 0 AND a.dismissed = 0
  `).all();
  return rows.map((r) => ({
    sourceKey: `c${r.clusterId}:${r.alertId}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.hostName,
    message: `${r.alertType ? `${r.alertType}: ` : ''}${r.description || ''}`.trim(),
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
    ...(r.alertCategory ? { type: r.alertCategory, typeLabel: cohesityTypeLabel(r.alertCategory) } : {}),
  }));
}

/** Active Pure alerts — pure_alerts only holds open alerts (poller deletes closed ones). */
function collectPureAlerts() {
  const rows = db.prepare(`
    SELECT p.pure_alert_id AS alertId, p.array_id AS arrayId, p.severity AS severity,
           p.category AS category, p.component_type AS componentType,
           p.summary AS summary, p.created_at_ms AS createdAtMs, p.updated_at_ms AS updatedAtMs,
           a.name AS arrayName
    FROM pure_alerts p JOIN pure_arrays a ON p.array_id = a.id
  `).all();
  return rows
    .filter((r) => String(r.severity || '').toLowerCase() !== 'hidden')
    .map((r) => {
      const type = r.componentType || r.category || undefined;
      return {
        sourceKey: `a${r.arrayId}:${r.alertId}`,
        severity: String(r.severity || '').toLowerCase(),
        host: r.arrayName,
        message: r.summary || '',
        firstSeen: toIso(r.createdAtMs),
        lastSeen: toIso(r.updatedAtMs),
        ...(type ? { type, typeLabel: type } : {}),
      };
    });
}

/** Active NetApp alerts — netapp_alerts is wiped+reloaded every poll, so the
 *  sourceKey must be content-stable (index-based alert_key is not enough). */
function collectNetappAlerts() {
  const rows = db.prepare(`
    SELECT n.id AS rowId, n.array_id AS arrayId, n.alert_key AS alertKey, n.severity AS severity,
           n.node_name AS nodeName, n.source AS source, n.message AS message, n.captured_at AS capturedAt,
           a.name AS arrayName
    FROM netapp_alerts n JOIN netapp_arrays a ON n.array_id = a.id
  `).all();
  return rows.map((r) => {
    const messageHash = crypto.createHash('sha256').update(r.message || '').digest('hex').slice(0, 12);
    let severity = String(r.severity || '').toLowerCase();
    if (severity === 'information') severity = 'info';
    return {
      sourceKey: `a${r.arrayId}:${r.alertKey}:${messageHash}`,
      severity,
      host: r.nodeName ? `${r.arrayName} (${r.nodeName})` : r.arrayName,
      message: r.message || '',
      firstSeen: toIso(r.capturedAt),
      lastSeen: toIso(r.capturedAt),
      ...(r.source ? { type: r.source, typeLabel: r.source } : {}),
    };
  });
}

/** Active Zerto alerts — zerto_alerts is wiped+reloaded every poll, but
 *  alert_identifier is Zerto's own stable id so it survives the reload. */
function collectZertoAlerts() {
  // Per-type toggles: a code disabled in zerto_alert_catalog is muted — it
  // drops out of the collector entirely, which also ends its reminders.
  const rows = db.prepare(`
    SELECT alert_identifier AS alertId, severity, description, site_name AS siteName,
           collection_time AS collectionTime, captured_at AS capturedAt
    FROM zerto_alerts z
    WHERE z.alert_type IS NULL OR NOT EXISTS (
      SELECT 1 FROM zerto_alert_catalog c WHERE c.alert_type = z.alert_type AND c.enabled = 0
    )
  `).all();
  return rows.map((r) => ({
    sourceKey: `z:${r.alertId}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.siteName || 'Zerto',
    message: r.description || '',
    firstSeen: toIso(r.collectionTime || r.capturedAt),
    lastSeen: toIso(r.capturedAt),
  }));
}

/** Open vCenter computed issues — reconcileIssueHistory keeps
 *  vcenter_issue_history current with a stable issue_key per issue, and
 *  resolving drops the row out of this query (which is what ends reminders). */
function collectVcenterIssues() {
  const rows = db.prepare(`
    SELECT issue_key AS issueKey, vcenter, severity, type, message,
           first_seen AS firstSeen, last_seen AS lastSeen
    FROM vcenter_issue_history WHERE status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `v:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.vcenter,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
    ...(r.type ? { type: r.type, typeLabel: r.type } : {}),
  }));
}

/** Un-acknowledged Dell OME alerts. dell_alerts is append-only (90-day
 *  retention) — acknowledging the alert in OME is what stops reminders.
 *  OME warranty alerts for a tag whose best contract is outside the warning
 *  window are dropped (see dellWarrantyCover). */
function collectDellAlerts() {
  const keep = warrantyAlertFilter(db);
  const rows = db.prepare(`
    SELECT d.ome_id AS omeId, d.ome_id, d.alert_id AS alertId, d.severity, d.message,
           d.category AS category, d.subcategory AS subcategory,
           d.device_name AS deviceName, d.device_name, d.service_tag AS serviceTag, d.service_tag,
           d.created_at AS createdAt, d.captured_at AS capturedAt, o.name AS omeName
    FROM dell_alerts d JOIN dell_ome_instances o ON d.ome_id = o.id
    WHERE d.status IS NULL OR d.status != 'acknowledged'
  `).all().filter(keep);
  return rows.map((r) => {
    let severity = String(r.severity || '').toLowerCase();
    if (severity === 'normal') severity = 'info';
    const type = r.category ? (r.subcategory ? `${r.category} / ${r.subcategory}` : r.category) : undefined;
    return {
      sourceKey: `d${r.omeId}:${r.alertId}`,
      severity,
      host: r.deviceName ? `${r.deviceName}${r.serviceTag ? ` (${r.serviceTag})` : ''}` : r.omeName,
      message: r.message || '',
      firstSeen: toIso(r.createdAt || r.capturedAt),
      lastSeen: toIso(r.capturedAt),
      ...(type ? { type, typeLabel: type } : {}),
    };
  });
}

/** Open Aria Automation computed issues — reconcileIssueHistory keeps
 *  aria_issue_history current with a stable issue_key per issue, and
 *  resolving drops the row out of this query (which is what ends reminders). */
function collectAriaIssues() {
  const rows = db.prepare(`
    SELECT issue_key AS issueKey, instance, severity, type, message,
           first_seen AS firstSeen, last_seen AS lastSeen
    FROM aria_issue_history WHERE status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `ar:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.instance,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
    ...(r.type ? { type: r.type, typeLabel: r.type } : {}),
  }));
}

/** Open AWS computed issues — reconcileIssueHistory keeps aws_issue_history
 *  current with a stable issue_key per issue, and resolving drops the row
 *  out of this query (which is what ends reminders). */
function collectAwsIssues() {
  const rows = db.prepare(`
    SELECT i.issue_key AS issueKey, COALESCE(a.name, i.account, 'estate') AS account,
           i.severity, i.type, i.message, i.first_seen AS firstSeen, i.last_seen AS lastSeen
    FROM aws_issue_history i LEFT JOIN aws_accounts a ON i.account_id = a.id
    WHERE i.status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `aws:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.account,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
    ...(r.type ? { type: r.type, typeLabel: r.type } : {}),
  }));
}

const COLLECTORS = {
  cohesity: collectCohesityAlerts,
  pure: collectPureAlerts,
  netapp: collectNetappAlerts,
  zerto: collectZertoAlerts,
  vcenter: collectVcenterIssues,
  dell: collectDellAlerts,
  aria: collectAriaIssues,
  aws: collectAwsIssues,
};

let transportFactory = (config) => nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpEncryption === 'tls',
  requireTLS: config.smtpEncryption === 'starttls',
  auth: config.smtpAuthMethod === 'login' ? { user: config.smtpUsername, pass: getSmtpPassword() } : undefined,
  connectionTimeout: 10000,
});

/** Test-only DI seam: override the transport factory so no test hits the network. */
function _setTransportFactory(fn) {
  transportFactory = fn;
}

function _reset() {
  transportFactory = (config) => nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpEncryption === 'tls',
    requireTLS: config.smtpEncryption === 'starttls',
    auth: config.smtpAuthMethod === 'login' ? { user: config.smtpUsername, pass: getSmtpPassword() } : undefined,
    connectionTimeout: 10000,
  });
}

function buildSubject({ severity, host, message, reminderCount }) {
  const truncated = message.length > 120 ? `${message.slice(0, 120)}` : message;
  const prefix = reminderCount ? `[REMINDER ${reminderCount}] ` : '';
  return `${prefix}${severity.toUpperCase()} | ${host} | ${truncated}`;
}

function buildBody({ severity, source, host, message, firstSeen, lastSeen, notifyCount }) {
  const platformLabel = source.charAt(0).toUpperCase() + source.slice(1);
  return [
    `Severity:   ${severity.toUpperCase()}`,
    `Platform:   ${platformLabel}`,
    `Cluster/Host: ${host}`,
    `Alert:      ${message}`,
    `First fired:  ${firstSeen || 'unknown'}`,
    `Last activity: ${lastSeen || 'unknown'}`,
    `Notifications sent for this alert: ${notifyCount}`,
    '--',
    'Sent by ICC Alert Notifications',
  ].join('\n');
}

async function sendTestEmail() {
  const config = getNotificationSettings();
  if (!config.smtpHost || !config.smtpFrom || !config.smtpRecipients) {
    const err = new Error('SMTP is not fully configured (host, from, and recipients are required).');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  const transport = transportFactory(config);
  await transport.sendMail({
    from: config.smtpFrom,
    to: config.smtpRecipients,
    subject: 'INFO | ICC | SMTP configuration test',
    text: 'This is a test email from ICC Alert Notifications. Your SMTP configuration is working.',
  });
}

/** Recipients a platform's alerts would actually go to: its own override
 *  when set, else the Global Settings default (rule shared with run()). */
function resolvePlatformRecipients(platform, config) {
  const override = db.prepare('SELECT recipients FROM alert_notify_platform WHERE platform = ?').get(platform);
  return (override?.recipients || '').trim() || config.smtpRecipients;
}

/** Send a one-off test email to a single platform's resolved recipients
 *  (used by Settings - platform - Alert Notifications - Send test email). */
async function sendPlatformTestEmail(platform) {
  const config = getNotificationSettings();
  if (!config.smtpHost || !config.smtpFrom) {
    const err = new Error('SMTP is not fully configured (host and from address are required - see Global Settings, Notifications).');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  const recipients = resolvePlatformRecipients(platform, config);
  if (!recipients) {
    const err = new Error('No recipients are set for this platform and no default recipients are configured.');
    err.code = 'NO_RECIPIENTS';
    throw err;
  }
  const transport = transportFactory(config);
  await transport.sendMail({
    from: config.smtpFrom,
    to: recipients,
    subject: `INFO | ICC | ${platform} SMTP test`,
    text: `This is a test email from ICC Alert Notifications for the ${platform} platform. Your SMTP configuration is working.`,
  });
}

/** One prepared statement, one transaction: upsert alert_notify_types for
 *  every (platform, type) seen this run - new types default enabled, seen
 *  types just refresh label/last_seen. Muted stays muted (enabled untouched). */
function upsertTypeCatalog(items) {
  const run_ = db.transaction((rows) => {
    const stmt = db.prepare(`
      INSERT INTO alert_notify_types (platform, type, label, enabled, first_seen, last_seen)
      VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
      ON CONFLICT(platform, type) DO UPDATE SET
        label = excluded.label,
        last_seen = datetime('now')
    `);
    const seen = new Set();
    for (const item of rows) {
      if (!item.type) continue;
      const key = `${item.source}:${item.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stmt.run(item.source, item.type, item.typeLabel || item.type);
    }
  });
  run_(items);
}

/** Per-platform full-history query for refreshTypeCatalog(): same type/label
 *  derivation each collector above uses, but over every stored row (any
 *  resolved/open/dismissed state) instead of only the currently-open ones,
 *  so the owner can mute a type before it ever fires again. Each query
 *  returns { type, typeLabel, firstSeen, lastSeen } rows, timestamps already
 *  normalized to the 'YYYY-MM-DD HH:MM:SS' UTC text upsertTypeCatalog writes
 *  with datetime('now') (epoch-ms columns converted via unixepoch). */
const CATALOG_BACKFILL = {
  // Mirrors collectCohesityAlerts' type/label rule (alert_category + cohesityTypeLabel).
  cohesity: () => db.prepare(`
    SELECT alert_category AS type, datetime(MIN(first_seen)) AS firstSeen, datetime(MAX(last_updated)) AS lastSeen
    FROM alerts WHERE alert_category IS NOT NULL AND alert_category != ''
    GROUP BY alert_category
  `).all().map((r) => ({ type: r.type, typeLabel: cohesityTypeLabel(r.type), firstSeen: r.firstSeen, lastSeen: r.lastSeen })),

  // Mirrors collectPureAlerts' type rule (componentType || category, 'hidden' severity excluded).
  pure: () => db.prepare(`
    SELECT COALESCE(NULLIF(component_type, ''), NULLIF(category, '')) AS type,
           datetime(MIN(created_at_ms) / 1000, 'unixepoch') AS firstSeen,
           datetime(MAX(updated_at_ms) / 1000, 'unixepoch') AS lastSeen
    FROM pure_alerts WHERE LOWER(COALESCE(severity, '')) != 'hidden'
    GROUP BY type HAVING type IS NOT NULL
  `).all(),

  // Mirrors collectNetappAlerts' type rule (source, when non-empty).
  netapp: () => db.prepare(`
    SELECT source AS type, datetime(MIN(captured_at)) AS firstSeen, datetime(MAX(captured_at)) AS lastSeen
    FROM netapp_alerts WHERE source IS NOT NULL AND source != ''
    GROUP BY source
  `).all(),

  // Mirrors collectDellAlerts' type rule ("category / subcategory", falling
  // back to category, no type when category is empty).
  dell: () => db.prepare(`
    SELECT CASE WHEN category IS NULL OR category = '' THEN NULL
                WHEN subcategory IS NULL OR subcategory = '' THEN category
                ELSE category || ' / ' || subcategory END AS type,
           datetime(MIN(COALESCE(created_at, captured_at))) AS firstSeen,
           datetime(MAX(captured_at)) AS lastSeen
    FROM dell_alerts
    GROUP BY type HAVING type IS NOT NULL
  `).all(),

  // vcenter/aria/aws collectors read <x>_issue_history.type off open rows only;
  // the backfill reads every status so a resolved issue's type is caught too.
  vcenter: () => issueHistoryBackfill('vcenter_issue_history'),
  aria: () => issueHistoryBackfill('aria_issue_history'),
  aws: () => issueHistoryBackfill('aws_issue_history'),

  // unifi/bluecat platforms/*/index.js collectAlerts() and brocade's
  // fromIssues half read their own issue_history.type off open rows only;
  // the backfill reads every row. Brocade's fromEvents half (brocade_events)
  // has no type column and is intentionally left out.
  unifi: () => issueHistoryBackfill('unifi_issue_history'),
  brocade: () => issueHistoryBackfill('brocade_issue_history'),
  bluecat: () => issueHistoryBackfill('bluecat_issue_history'),

  // zerto keeps its own zerto_alert_catalog (per-code toggles) - no entry here.
};

/** Shared by vcenter/aria/aws/unifi/brocade/bluecat: their issue_history
 *  tables all share the same type/first_seen/last_seen shape. */
function issueHistoryBackfill(table) {
  return db.prepare(`
    SELECT type, datetime(MIN(first_seen)) AS firstSeen, datetime(MAX(last_seen)) AS lastSeen
    FROM ${table} WHERE type IS NOT NULL AND type != ''
    GROUP BY type
  `).all();
}

/** Fills alert_notify_types from the full stored alert tables (any
 *  resolved/open/dismissed state), not just currently-open alerts, so the
 *  owner can mute a type before it ever fires again. `platform` narrows to
 *  one platform; omitted, every known platform is refreshed. One transaction
 *  per call; each platform's query is isolated so a missing table (an
 *  install without that platform) can't break the others. Never touches
 *  `enabled` on conflict - only widens the first/last-seen range and
 *  refreshes the label. */
function refreshTypeCatalog(platform) {
  const platforms = platform ? [platform] : Object.keys(CATALOG_BACKFILL);
  const upsert = db.prepare(`
    INSERT INTO alert_notify_types (platform, type, label, enabled, first_seen, last_seen)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(platform, type) DO UPDATE SET
      label = excluded.label,
      first_seen = MIN(first_seen, excluded.first_seen),
      last_seen = MAX(last_seen, excluded.last_seen)
  `);
  // Fallback for the rare row whose stored timestamps didn't resolve to
  // anything - same 'YYYY-MM-DD HH:MM:SS' UTC text datetime('now') writes.
  const now = db.prepare("SELECT datetime('now') AS now").get().now;
  const run_ = db.transaction((platformList) => {
    for (const p of platformList) {
      const query = CATALOG_BACKFILL[p];
      if (!query) continue;
      let rows;
      try {
        rows = query();
      } catch (err) {
        // Expected on an install/branch without this platform's table(s) -
        // debug only, not warn, so it doesn't repeat every 5 minutes.
        logger.debug(`[AlertNotifier] Type-catalog backfill skipped for ${p}: ${err.message}`);
        continue;
      }
      for (const r of rows) {
        if (!r.type) continue;
        upsert.run(p, r.type, r.typeLabel || r.type, r.firstSeen || now, r.lastSeen || now);
      }
    }
  });
  run_(platforms);
}

/** Core run loop, shared by the cron job and any manual trigger. */
async function run() {
  try {
    const config = getNotificationSettings();

    try {
      refreshTypeCatalog();
    } catch (err) {
      logger.error('[AlertNotifier] Type-catalog backfill failed:', err.message);
    }

    if (!config.smtpEnabled || !config.smtpHost || !config.smtpFrom) return;

    const platformOverrides = new Map(
      db.prepare('SELECT platform, recipients, min_severity FROM alert_notify_platform').all()
        .map((r) => [r.platform, r])
    );
    const mutedTypes = new Set(
      db.prepare("SELECT platform, type FROM alert_notify_types WHERE enabled = 0").all()
        .map((r) => `${r.platform}:${r.type}`)
    );

    const activeKeys = new Set();
    const collected = [];
    for (const [source, collect] of Object.entries(COLLECTORS)) {
      if (!config.alertPlatforms[source]) continue;
      let items;
      try {
        items = collect();
      } catch (err) {
        logger.error(`[AlertNotifier] Failed to collect ${source} alerts:`, err.message);
        continue;
      }
      for (const item of items) {
        activeKeys.add(`${source}:${item.sourceKey}`);
        collected.push({ source, ...item });
      }
    }

    // Plugin-contributed collectors (Phase 1 manifest-driven core hooks):
    // any enabled plugin declaring collectAlerts, that isn't already a
    // built-in source above.
    for (const contributor of registry.getAlertCollectors()) {
      const source = contributor.id;
      if (COLLECTORS[source]) continue;
      if (!config.alertPlatforms[source]) continue;
      let items;
      try {
        items = contributor.collect();
      } catch (err) {
        logger.error(`[AlertNotifier] Failed to collect ${source} alerts:`, err.message);
        continue;
      }
      for (const item of items) {
        activeKeys.add(`${source}:${item.sourceKey}`);
        collected.push({ source, ...item });
      }
    }

    try {
      upsertTypeCatalog(collected);
    } catch (err) {
      logger.error('[AlertNotifier] Alert-type catalog upkeep failed:', err.message);
    }

    // Per-candidate: muted (platform, type) is skipped; threshold and
    // recipients come from the platform's own override, falling back to the
    // global default - a candidate with no resolved recipients sends nothing
    // and writes no alert_notifications row (so it is retried, not dropped).
    const candidates = [];
    for (const item of collected) {
      if (item.type && mutedTypes.has(`${item.source}:${item.type}`)) continue;

      const override = platformOverrides.get(item.source);
      const thresholdRank = THRESHOLD_RANK[override?.min_severity] ?? THRESHOLD_RANK[config.alertMinSeverity] ?? THRESHOLD_RANK.warning;
      if (normalizedRank(item.severity) < thresholdRank) continue;

      const recipients = (override?.recipients || '').trim() || config.smtpRecipients;
      if (!recipients) continue;

      candidates.push({ ...item, recipients });
    }

    let transport;
    let sentThisRun = 0;

    for (const candidate of candidates) {
      if (sentThisRun >= MAX_EMAILS_PER_RUN) {
        logger.warn('[AlertNotifier] Hit per-run email cap (25); remaining alerts will be picked up next run.');
        break;
      }

      const existing = db.prepare(
        'SELECT * FROM alert_notifications WHERE source = ? AND source_key = ?'
      ).get(candidate.source, candidate.sourceKey);

      let isReminder = false;
      let reminderCount = 0;

      if (!existing) {
        // NEW
      } else if (config.reminderHours > 0) {
        const lastNotified = new Date(`${existing.last_notified_at.replace(' ', 'T')}Z`);
        const ageHours = (Date.now() - lastNotified.getTime()) / (1000 * 60 * 60);
        if (ageHours >= config.reminderHours) {
          isReminder = true;
          reminderCount = existing.notify_count + 1;
        } else {
          continue;
        }
      } else {
        continue;
      }

      try {
        if (!transport) transport = transportFactory(config);
        const subject = buildSubject({
          severity: candidate.severity,
          host: candidate.host,
          message: candidate.message,
          reminderCount,
        });
        const body = buildBody({
          severity: candidate.severity,
          source: candidate.source,
          host: candidate.host,
          message: candidate.message,
          firstSeen: candidate.firstSeen,
          lastSeen: candidate.lastSeen,
          notifyCount: isReminder ? reminderCount : 1,
        });
        await transport.sendMail({
          from: config.smtpFrom,
          to: candidate.recipients,
          subject,
          text: body,
        });
        sentThisRun += 1;

        if (isReminder) {
          db.prepare(`
            UPDATE alert_notifications SET notify_count = ?, last_notified_at = datetime('now')
            WHERE source = ? AND source_key = ?
          `).run(reminderCount, candidate.source, candidate.sourceKey);
        } else {
          db.prepare(`
            INSERT INTO alert_notifications (source, source_key, severity, notify_count, first_notified_at, last_notified_at)
            VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
            ON CONFLICT(source, source_key) DO UPDATE SET
              notify_count = 1, first_notified_at = datetime('now'), last_notified_at = datetime('now')
          `).run(candidate.source, candidate.sourceKey, candidate.severity);
        }
      } catch (err) {
        logger.error(`[AlertNotifier] Failed to send email for ${candidate.source}:${candidate.sourceKey}:`, err.message);
        // No row write on failure — retried next run.
      }
    }

    // Housekeeping: drop stale rows for alerts no longer active, older than STALE_DAYS.
    try {
      const staleRows = db.prepare(
        `SELECT id, source, source_key FROM alert_notifications WHERE last_notified_at < datetime('now', '-${STALE_DAYS} days')`
      ).all();
      const toDelete = staleRows.filter((r) => !activeKeys.has(`${r.source}:${r.source_key}`));
      if (toDelete.length) {
        const del = db.prepare('DELETE FROM alert_notifications WHERE id = ?');
        for (const row of toDelete) del.run(row.id);
      }
    } catch (err) {
      logger.error('[AlertNotifier] Housekeeping failed:', err.message);
    }
  } catch (err) {
    logger.error('[AlertNotifier] run() failed:', err.message);
  }
}

/** Same always-on-cohesity / registry-enabled gate as routes/ops.js's
 *  platformGateOk — kept as a private copy here (Service Status needs the
 *  identical rule but must not import from routes/). */
function platformGateOk(id) {
  const entry = registry.getPlugin(id);
  if (id === 'cohesity') {
    if (entry) return entry.enabled === true;
    // Older registries (icc-phase1) have no isBuiltinPresent; cohesity is always-on there.
    return typeof registry.isBuiltinPresent === 'function' ? registry.isBuiltinPresent('cohesity') : true;
  }
  return entry?.enabled === true;
}

/**
 * Service Status (contract): every currently-open alert across every
 * enabled platform, gated on platform enablement (NOT the email toggles the
 * rest of this module uses) so the status board reflects reality even when
 * SMTP notifications are off. Each collector is isolated — a throwing
 * collector's platform id is reported in `failed` instead of aborting the
 * whole sweep, and its previously-recorded events are left untouched by the
 * caller rather than cleared.
 */
function collectOpenAlerts() {
  const items = [];
  const failed = [];

  for (const [platform, collect] of Object.entries(COLLECTORS)) {
    if (!platformGateOk(platform)) continue;
    try {
      for (const item of collect()) items.push({ platform, ...item });
    } catch (err) {
      logger.error(`[ServiceStatus] Failed to collect ${platform} alerts:`, err.message);
      failed.push(platform);
    }
  }

  // Manifest-hook collectors exist only on registries that expose them.
  const contributors = typeof registry.getAlertCollectors === 'function' ? registry.getAlertCollectors() : [];
  for (const contributor of contributors) {
    const platform = contributor.id;
    if (COLLECTORS[platform]) continue;
    if (!platformGateOk(platform)) continue;
    try {
      for (const item of contributor.collect()) items.push({ platform, ...item });
    } catch (err) {
      logger.error(`[ServiceStatus] Failed to collect ${platform} alerts:`, err.message);
      failed.push(platform);
    }
  }

  return { items, failed };
}

let cronTask = null;

function initAlertNotifier() {
  if (cronTask) return cronTask;
  const { forEachTenant } = require('../core/tenantRegistry');
  cronTask = cron.schedule('*/5 * * * *', () => { forEachTenant(() => run()); });
  return cronTask;
}

function stopAlertNotifier() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}

module.exports = {
  run,
  sendTestEmail,
  sendPlatformTestEmail,
  initAlertNotifier,
  stopAlertNotifier,
  collectOpenAlerts,
  refreshTypeCatalog,
  _setTransportFactory,
  _reset,
};
