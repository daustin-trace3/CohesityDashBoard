const cron = require('node-cron');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../db/database');
const logger = require('../utils/logger');
const { getNotificationSettings, getSmtpPassword } = require('./settings');

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

/** Active Cohesity alerts (not resolved, not dismissed). */
function collectCohesityAlerts() {
  const rows = db.prepare(`
    SELECT a.cohesity_alert_id AS alertId, a.cluster_id AS clusterId, a.severity AS severity,
           a.alert_type AS alertType, a.description AS description,
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
  }));
}

/** Active Pure alerts — pure_alerts only holds open alerts (poller deletes closed ones). */
function collectPureAlerts() {
  const rows = db.prepare(`
    SELECT p.pure_alert_id AS alertId, p.array_id AS arrayId, p.severity AS severity,
           p.summary AS summary, p.created_at_ms AS createdAtMs, p.updated_at_ms AS updatedAtMs,
           a.name AS arrayName
    FROM pure_alerts p JOIN pure_arrays a ON p.array_id = a.id
  `).all();
  return rows
    .filter((r) => String(r.severity || '').toLowerCase() !== 'hidden')
    .map((r) => ({
      sourceKey: `a${r.arrayId}:${r.alertId}`,
      severity: String(r.severity || '').toLowerCase(),
      host: r.arrayName,
      message: r.summary || '',
      firstSeen: toIso(r.createdAtMs),
      lastSeen: toIso(r.updatedAtMs),
    }));
}

/** Active NetApp alerts — netapp_alerts is wiped+reloaded every poll, so the
 *  sourceKey must be content-stable (index-based alert_key is not enough). */
function collectNetappAlerts() {
  const rows = db.prepare(`
    SELECT n.id AS rowId, n.array_id AS arrayId, n.alert_key AS alertKey, n.severity AS severity,
           n.node_name AS nodeName, n.message AS message, n.captured_at AS capturedAt,
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
    };
  });
}

/** Active Zerto alerts — zerto_alerts is wiped+reloaded every poll, but
 *  alert_identifier is Zerto's own stable id so it survives the reload. */
function collectZertoAlerts() {
  const rows = db.prepare(`
    SELECT alert_identifier AS alertId, severity, description, site_name AS siteName,
           collection_time AS collectionTime, captured_at AS capturedAt
    FROM zerto_alerts
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
    SELECT issue_key AS issueKey, vcenter, severity, message,
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
  }));
}

/** Un-acknowledged Dell OME alerts. dell_alerts is append-only (90-day
 *  retention) — acknowledging the alert in OME is what stops reminders. */
function collectDellAlerts() {
  const rows = db.prepare(`
    SELECT d.ome_id AS omeId, d.alert_id AS alertId, d.severity, d.message,
           d.device_name AS deviceName, d.service_tag AS serviceTag,
           d.created_at AS createdAt, d.captured_at AS capturedAt, o.name AS omeName
    FROM dell_alerts d JOIN dell_ome_instances o ON d.ome_id = o.id
    WHERE d.status IS NULL OR d.status != 'acknowledged'
  `).all();
  return rows.map((r) => {
    let severity = String(r.severity || '').toLowerCase();
    if (severity === 'normal') severity = 'info';
    return {
      sourceKey: `d${r.omeId}:${r.alertId}`,
      severity,
      host: r.deviceName ? `${r.deviceName}${r.serviceTag ? ` (${r.serviceTag})` : ''}` : r.omeName,
      message: r.message || '',
      firstSeen: toIso(r.createdAt || r.capturedAt),
      lastSeen: toIso(r.capturedAt),
    };
  });
}

/** Open Aria Automation computed issues — reconcileIssueHistory keeps
 *  aria_issue_history current with a stable issue_key per issue, and
 *  resolving drops the row out of this query (which is what ends reminders). */
function collectAriaIssues() {
  const rows = db.prepare(`
    SELECT issue_key AS issueKey, instance, severity, message,
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

/** Core run loop, shared by the cron job and any manual trigger. */
async function run() {
  try {
    const config = getNotificationSettings();
    if (!config.smtpEnabled || !config.smtpHost || !config.smtpFrom || !config.smtpRecipients) return;

    const thresholdRank = THRESHOLD_RANK[config.alertMinSeverity] ?? THRESHOLD_RANK.warning;

    const activeKeys = new Set();
    const candidates = [];
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
        if (normalizedRank(item.severity) < thresholdRank) continue;
        candidates.push({ source, ...item });
      }
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
          to: config.smtpRecipients,
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

let cronTask = null;

function initAlertNotifier() {
  if (cronTask) return cronTask;
  cronTask = cron.schedule('*/5 * * * *', () => { run(); });
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
  initAlertNotifier,
  stopAlertNotifier,
  _setTransportFactory,
  _reset,
};
