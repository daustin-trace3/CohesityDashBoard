// Per-platform alert-email settings: each platform's own recipients + minimum
// severity override (blank/null = inherit the Global Settings default), plus
// the per-alert-type SMTP mute catalog (generalizes zerto_alert_catalog to
// every platform). Mounted directly at /api/alert-notify in app.js, BEFORE the
// plugin dispatcher, with no blanket permission guard - every route below
// gates itself on the target platform's own settings permission, the same
// <platform>:settings:view|manage strings each platform's own Settings page
// already uses (see backend/middleware/requirePermission.js platformPermission).
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../db/database');
const { getNotificationSettings, setSetting } = require('../services/settings');
const { requirePermission } = require('../middleware/requirePermission');
const alertNotifier = require('../services/alertNotifier');

const router = express.Router();

const SEVERITY_VALUES = new Set(['info', 'warning', 'critical']);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

function viewPermission(req) { return `${req.params.platform}:settings:view`; }
function managePermission(req) { return `${req.params.platform}:settings:manage`; }

/** :platform must be one of the alert platforms the notifier itself knows
 *  about (static collectors + enabled plugins declaring collectAlerts). */
router.param('platform', (req, res, next, platform) => {
  const known = getNotificationSettings().alertPlatforms;
  if (!(platform in known)) return res.status(404).json({ error: 'Unknown platform' });
  next();
});

/** Comma/semicolon separated email list -> { value } normalized as a
 *  ", "-joined string, or { bad } naming the first entry that isn't an email. */
function normalizeRecipients(raw) {
  const parts = String(raw).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (!EMAIL_RE.test(part)) return { bad: part };
  }
  return { value: parts.join(', ') };
}

function currentView(platform) {
  const settings = getNotificationSettings();
  const override = db.prepare('SELECT recipients, min_severity FROM alert_notify_platform WHERE platform = ?').get(platform);
  return {
    platform,
    enabled: settings.alertPlatforms[platform] !== false,
    recipients: override?.recipients || '',
    minSeverity: override?.min_severity || null,
    globalMinSeverity: settings.alertMinSeverity,
    globalRecipientsSet: !!settings.smtpRecipients,
    smtpReady: settings.smtpEnabled && !!settings.smtpHost && !!settings.smtpFrom,
  };
}

/** GET /api/alert-notify/:platform - current settings + the type catalog. */
router.get('/:platform', requirePermission(viewPermission), (req, res, next) => {
  try {
    const platform = req.params.platform;
    const types = db.prepare(`
      SELECT type, label, enabled, first_seen AS firstSeen, last_seen AS lastSeen
      FROM alert_notify_types WHERE platform = ? ORDER BY label
    `).all(platform).map((t) => ({ ...t, enabled: !!t.enabled }));
    res.json({ ...currentView(platform), types });
  } catch (err) { next(err); }
});

/** PUT /api/alert-notify/:platform - recipients / minSeverity / enabled. */
router.put('/:platform', requirePermission(managePermission), [
  body('recipients').optional().isString().isLength({ max: 2000 }),
  body('enabled').optional().isBoolean(),
], validate, (req, res, next) => {
  try {
    const platform = req.params.platform;
    const b = req.body || {};

    if (b.minSeverity !== undefined && b.minSeverity !== null && b.minSeverity !== '' && !SEVERITY_VALUES.has(b.minSeverity)) {
      return res.status(400).json({ error: "minSeverity must be one of 'info', 'warning', 'critical', or blank to inherit the global default" });
    }

    const existing = db.prepare('SELECT recipients, min_severity FROM alert_notify_platform WHERE platform = ?').get(platform);

    let recipients = existing?.recipients || '';
    if (b.recipients !== undefined) {
      const trimmed = String(b.recipients).trim();
      if (!trimmed) {
        recipients = '';
      } else {
        const result = normalizeRecipients(trimmed);
        if (result.bad) return res.status(400).json({ error: `Not a valid email address: ${result.bad}` });
        recipients = result.value;
      }
    }

    const minSeverity = b.minSeverity !== undefined ? (b.minSeverity || null) : (existing?.min_severity ?? null);

    db.prepare(`
      INSERT INTO alert_notify_platform (platform, recipients, min_severity, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(platform) DO UPDATE SET
        recipients = excluded.recipients, min_severity = excluded.min_severity, updated_at = excluded.updated_at
    `).run(platform, recipients, minSeverity);

    if (b.enabled !== undefined) {
      // Same JSON blob PUT /api/settings/notifications writes - this is just
      // a second place to flip one platform's flag in it.
      const current = getNotificationSettings().alertPlatforms;
      setSetting('alert_email_platforms', JSON.stringify({ ...current, [platform]: !!b.enabled }));
    }

    res.json(currentView(platform));
  } catch (err) { next(err); }
});

/** PUT /api/alert-notify/:platform/types/:type - mute/unmute one alert type. */
router.put('/:platform/types/:type', requirePermission(managePermission), [
  param('type').isString().trim().isLength({ min: 1, max: 200 }),
  body('enabled').isBoolean(),
], validate, (req, res, next) => {
  try {
    const info = db.prepare('UPDATE alert_notify_types SET enabled = ? WHERE platform = ? AND type = ?')
      .run(req.body.enabled ? 1 : 0, req.params.platform, req.params.type);
    if (info.changes === 0) return res.status(404).json({ error: 'Unknown alert type' });
    res.json({ ok: true, platform: req.params.platform, type: req.params.type, enabled: !!req.body.enabled });
  } catch (err) { next(err); }
});

/** POST /api/alert-notify/:platform/test - one test email to this platform's
 *  resolved recipients. Never available on the public demo (no outbound). */
router.post('/:platform/test', requirePermission(managePermission), async (req, res) => {
  if (process.env.DASHBOARD_DEMO === '1') {
    return res.status(403).json({ error: 'Test emails are disabled on the public demo.' });
  }
  try {
    await alertNotifier.sendPlatformTestEmail(req.params.platform);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'SMTP_NOT_CONFIGURED' || err.code === 'NO_RECIPIENTS') {
      return res.status(400).json({ error: err.message });
    }
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
