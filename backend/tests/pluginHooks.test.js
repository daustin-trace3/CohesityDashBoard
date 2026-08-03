/**
 * Phase 1 manifest-driven core hooks: opsSummary, collectAlerts,
 * searchCategories, metricsHistory, RBAC-grant seeding on enable, and the
 * notifications platform list. Registers a fake in-memory plugin manifest
 * declaring all six hooks against the real app + real (per-file temp) DB,
 * mirroring tests/awsPlugin.test.js's "registered via registry" pattern.
 *
 * Loaded via createRequire so app.js, core/registry.js and db/database.js
 * all resolve to the SAME module instances.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const registry = require('../core/registry');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';

function hookManifest(id, overrides = {}) {
  return {
    id,
    name: `Hook Plugin ${id}`,
    apiVersion: 1,
    color: '#123456',
    migrations: [
      {
        version: 1,
        up(migDb) {
          migDb.exec(`
            CREATE TABLE IF NOT EXISTS ${id}_items (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE IF NOT EXISTS ${id}_arrays (id INTEGER PRIMARY KEY, name TEXT, polling_interval_minutes INTEGER);
            CREATE TABLE IF NOT EXISTS ${id}_metrics (id INTEGER PRIMARY KEY, array_id INTEGER, captured_at TEXT);
          `);
          migDb.prepare(`INSERT INTO ${id}_items (name) VALUES (?)`).run(`${id}-widget-1`);
          migDb.prepare(`INSERT INTO ${id}_arrays (name, polling_interval_minutes) VALUES (?, ?)`).run(`${id}-array-1`, 15);
        },
      },
    ],
    createRouter() {
      const router = express.Router();
      router.get('/ping', (req, res) => res.json({ ok: true, id }));
      return router;
    },
    opsSummary() {
      return {
        objects: 3,
        headline: [{ label: 'Widgets', value: 3 }],
        exceptions: [{ severity: 'warning', count: 1, text: '1 test warning', link: `/${id}` }],
        spark: null,
      };
    },
    collectAlerts() {
      return [{
        sourceKey: 'w1',
        severity: 'critical',
        host: 'test-host',
        message: 'test alert',
        firstSeen: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      }];
    },
    searchCategories: [{
      key: `${id}-items`, label: 'Hook Items', platform: id, perm: `${id}:items:view`, base: `/${id}/items`,
      sql: `SELECT name AS title, NULL AS subtitle FROM ${id}_items WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
    }],
    metricsHistory: { arraysTable: `${id}_arrays`, metricsTable: `${id}_metrics`, arrayIdColumn: 'array_id' },
    ...overrides,
  };
}

function throwingHookManifest(id) {
  return hookManifest(id, {
    opsSummary() { throw new Error('ops boom'); },
    collectAlerts() { throw new Error('alerts boom'); },
  });
}

let app;

beforeEach(() => {
  registry._reset();
  registry.init();
  app = createApp({ licenseGate: (req, res, next) => next() });
});

describe('opsSummary hook', () => {
  it('a plugin declaring opsSummary contributes a card to /api/ops/summary', async () => {
    registry.registerPlugin(hookManifest('hooka'));
    registry.setEnabled('hooka', true);

    const res = await request(app).get('/api/ops/summary').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    const card = res.body.platforms.find((p) => p.id === 'hooka');
    expect(card).toBeTruthy();
    expect(card.label).toBe('Hook Plugin hooka');
    expect(card.color).toBe('#123456');
    expect(card.route).toBe('/hooka');
    expect(card.objects).toBe(3);
    expect(card.health).toBe('warning');
  });

  it('a throwing opsSummary degrades to an unknown-health card, other platforms unaffected', async () => {
    registry.registerPlugin(hookManifest('hookok'));
    registry.setEnabled('hookok', true);
    registry.registerPlugin(throwingHookManifest('hookbad'));
    registry.setEnabled('hookbad', true);

    const res = await request(app).get('/api/ops/summary').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    const bad = res.body.platforms.find((p) => p.id === 'hookbad');
    expect(bad).toMatchObject({ health: 'unknown', error: true });
    const ok = res.body.platforms.find((p) => p.id === 'hookok');
    expect(ok).toMatchObject({ health: 'warning', objects: 3 });
  });
});

describe('collectAlerts hook', () => {
  it('alertNotifier collects rows from a plugin declaring collectAlerts', async () => {
    const alertNotifier = require('../services/alertNotifier');
    registry.registerPlugin(hookManifest('hookb'));
    registry.setEnabled('hookb', true);

    const { setSetting } = require('../services/settings');
    setSetting('smtp_enabled', '1');
    setSetting('smtp_host', 'smtp.example.com');
    setSetting('smtp_from', 'alerts@example.com');
    setSetting('smtp_recipients', 'ops@example.com');
    setSetting('alert_email_min_severity', 'info');

    const sentMails = [];
    alertNotifier._setTransportFactory(() => ({
      sendMail: async (mail) => { sentMails.push(mail); },
    }));

    await alertNotifier.run();

    expect(sentMails.some((m) => m.subject.includes('test-host') && m.subject.includes('test alert'))).toBe(true);

    alertNotifier._reset();
  });

  it('a throwing collectAlerts degrades gracefully — run() does not throw', async () => {
    const alertNotifier = require('../services/alertNotifier');
    registry.registerPlugin(throwingHookManifest('hookbad2'));
    registry.setEnabled('hookbad2', true);

    const { setSetting } = require('../services/settings');
    setSetting('smtp_enabled', '1');
    setSetting('smtp_host', 'smtp.example.com');
    setSetting('smtp_from', 'alerts@example.com');
    setSetting('smtp_recipients', 'ops@example.com');

    await expect(alertNotifier.run()).resolves.toBeUndefined();
  });
});

describe('searchCategories hook', () => {
  it('/api/search returns results from a plugin-declared category', async () => {
    registry.registerPlugin(hookManifest('hookc'));
    registry.setEnabled('hookc', true);
    const { setSetting } = require('../services/settings');
    setSetting('platform_hookc_enabled', '1');

    const res = await request(app).get('/api/search').query({ q: 'hookc-widget' }).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    const cat = res.body.results.find((r) => r.key === 'hookc-items');
    expect(cat).toBeTruthy();
    expect(cat.items[0].title).toBe('hookc-widget-1');
  });
});

describe('metricsHistory hook', () => {
  it('/api/poller/status includes a section for a plugin declaring metricsHistory', async () => {
    registry.registerPlugin(hookManifest('hookd'));
    registry.setEnabled('hookd', true);

    const res = await request(app).get('/api/poller/status').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.hookd).toBeTruthy();
    expect(res.body.hookd.enabled).toBe(true);
    expect(Array.isArray(res.body.hookd.entities)).toBe(true);
    expect(res.body.hookd.entities[0].name).toBe('hookd-array-1');
  });
});

describe('RBAC grant seeding on enable', () => {
  it('enabling a plugin seeds Operator/Viewer grants; re-enabling does not duplicate', async () => {
    registry.registerPlugin(hookManifest('hooke'));
    registry.setEnabled('hooke', true);

    const grants = db.prepare(`
      SELECT g.name AS groupName, r.permission FROM role_grants r
      JOIN groups g ON g.id = r.subject_id AND r.subject_type = 'group'
      WHERE r.permission LIKE 'hooke:%'
    `).all();
    expect(grants).toEqual(expect.arrayContaining([
      { groupName: 'Operator', permission: 'hooke:*:*' },
      { groupName: 'Viewer', permission: 'hooke:*:view' },
    ]));

    registry.setEnabled('hooke', false);
    registry.setEnabled('hooke', true);

    const grantsAfter = db.prepare(`SELECT permission FROM role_grants WHERE permission LIKE 'hooke:%'`).all();
    expect(grantsAfter.length).toBe(2);
  });
});

describe('notification platform list', () => {
  it('GET /api/settings/notifications lists an enabled plugin declaring collectAlerts', async () => {
    registry.registerPlugin(hookManifest('hookf'));
    registry.setEnabled('hookf', true);

    const res = await request(app).get('/api/settings/notifications').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.platforms).toEqual(expect.arrayContaining([{ key: 'hookf', label: 'Hook Plugin hookf' }]));
    expect(res.body.alertPlatforms.hookf).toBe(true);
  });
});
