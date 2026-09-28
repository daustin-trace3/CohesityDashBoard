/**
 * Poller resilience additions (2026-09-28): backoff bookkeeping in
 * pollerStatus and the watchdog email the WEB process sends when the poller
 * heartbeat goes silent (configured under Cohesity Settings > Polling, sent
 * over the Global Settings SMTP relay).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const pollerStatus = require('../services/pollerStatus');
const alertNotifier = require('../services/alertNotifier');
const heartbeat = require('../services/workerHeartbeat');

beforeEach(() => {
  db.exec('DELETE FROM poller_status');
  setSetting('poller_watchdog_email_state', '');
  setSetting('poller_watchdog_email_enabled', '0');
  setSetting('poller_watchdog_recipients', '');
});

describe('pollerStatus backoff', () => {
  it('setBackoff surfaces in getState while in the future, and a successful poll clears it', () => {
    const until = new Date(Date.now() + 10 * 60000).toISOString();
    pollerStatus.setBackoff('cohesity', 7, until, 3);
    let s = pollerStatus.getState('cohesity', 7);
    expect(s.backoffUntil).toBe(until);
    expect(s.failCount).toBe(3);
    pollerStatus.markEnd('cohesity', 7, 'success');
    s = pollerStatus.getState('cohesity', 7);
    expect(s.backoffUntil).toBeNull();
    expect(s.failCount).toBe(0);
  });

  it('an expired backoff reads as no backoff', () => {
    pollerStatus.setBackoff('cohesity', 8, new Date(Date.now() - 60000).toISOString(), 2);
    expect(pollerStatus.getState('cohesity', 8).backoffUntil).toBeNull();
  });
});

describe('watchdog email', () => {
  const smtp = () => {
    setSetting('smtp_enabled', '1');
    setSetting('smtp_host', 'mail.example.com');
    setSetting('smtp_from', 'icc@example.com');
    setSetting('smtp_recipients', 'ops@example.com');
  };
  const sent = [];
  beforeEach(() => {
    sent.length = 0;
    alertNotifier._setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); } }));
    smtp();
  });

  it('does nothing while disabled', () => {
    heartbeat.watchdogEmailCheck(null);
    expect(sent).toHaveLength(0);
  });

  it('emails once the silence passes the threshold, and only once inside the repeat window', async () => {
    setSetting('poller_watchdog_email_enabled', '1');
    // Silence began 15 minutes ago (past the 10 min threshold).
    setSetting('poller_watchdog_email_state', JSON.stringify({ silentSince: new Date(Date.now() - 15 * 60000).toISOString() }));
    heartbeat.watchdogEmailCheck(null);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ops@example.com');
    expect(sent[0].subject).toContain('poller process is not running');
    heartbeat.watchdogEmailCheck(null);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);                     // throttled
  });

  it('uses the panel recipients when set, and sends a recovery note when the heartbeat returns', async () => {
    setSetting('poller_watchdog_email_enabled', '1');
    setSetting('poller_watchdog_recipients', 'doug@example.com');
    setSetting('poller_watchdog_email_state', JSON.stringify({
      silentSince: new Date(Date.now() - 20 * 60000).toISOString(),
      lastEmailAt: new Date(Date.now() - 60000).toISOString(),
    }));
    const alive = { alive: true, at: new Date().toISOString(), pid: 123, startedAt: new Date().toISOString(), ageSeconds: 1 };
    heartbeat.watchdogEmailCheck(alive);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('doug@example.com');
    expect(sent[0].subject).toContain('poller process is back');
    // Healthy again: no further mail, state reset.
    heartbeat.watchdogEmailCheck(alive);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
  });
});
