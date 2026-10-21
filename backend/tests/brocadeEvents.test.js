/**
 * Brocade events poll: 2 hour window cap, startIndex paging, 400 retry with a
 * halved window, and progress kept when a later page fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const brocadeApi = require('../services/brocadeApi');
const brocadePoller = require('../services/brocadePoller');
const registry = require('../core/registry');
const brocadeManifest = require('../platforms/brocade');
const { createApp } = require('../app');
const request = require('supertest');

const WINDOW = 115 * 60000;
let seedCounter = 0;

function seedSource() {
  seedCounter += 1;
  const info = db.prepare(`
    INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl, enabled,
      polling_interval_minutes, event_poll_minutes, fos_proxy_enabled, sannav_version)
    VALUES (?, ?, 443, 'admin', 'x', 0, 1, 60, 5, 0, '3.0.1')
  `).run(`Events Test ${seedCounter}`, `10.9.0.${seedCounter}`);
  return db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(info.lastInsertRowid);
}

const ev = (id, ms) => ({
  eventId: id, severity: 'Warning', severityNorm: 'warning', eventCategory: 'X', sourceName: 's',
  sourceAddress: null, sourceType: null, sourceWwn: null, fabricName: null, messageId: null, origin: null,
  module: null, description: `d${id}`, eventCount: 1, firstOccurredMs: ms, lastOccurredMs: ms,
  acknowledged: 0, ackBy: null, ackNotes: null, ackedTimeMs: null, productName: null,
  productAddress: null, portWwn: null,
});

const fresh = (id) => db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);

let spy;
beforeEach(() => { spy = vi.spyOn(brocadeApi, 'fetchEventsPage'); });
afterEach(() => { spy.mockRestore(); });

describe('pollEvents', () => {
  it('first poll caps the window, starts at index 0 and records success', async () => {
    const src = seedSource();
    const t = Date.now() - 1000;
    spy.mockResolvedValueOnce({ events: [ev('a1', t - 50), ev('a2', t)], nextPageIndex: null, totalRecords: 2 });
    await brocadePoller.pollEvents(src);
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0][1];
    expect(args.endTime - args.startTime).toBeLessThanOrEqual(WINDOW);
    expect(args.startIndex).toBe(0);
    expect(args.nextPageIndex).toBeNull();
    const row = fresh(src.id);
    expect(row.last_event_poll_status).toBe('success');
    expect(row.last_event_poll_error).toBeNull();
    expect(row.event_cursor_ms).toBe(t);
  });

  it('pages with startIndex and the returned nextPageIndex', async () => {
    const src = seedSource();
    const t = Date.now() - 1000;
    spy.mockResolvedValueOnce({ events: [ev('b1', t - 2), ev('b2', t - 1)], nextPageIndex: 'tok', totalRecords: null });
    spy.mockResolvedValueOnce({ events: [ev('b3', t)], nextPageIndex: null, totalRecords: null });
    await brocadePoller.pollEvents(src);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1].startIndex).toBe(2);
    expect(spy.mock.calls[1][1].nextPageIndex).toBe('tok');
  });

  it('keeps page 1 rows and records the error when page 2 fails', async () => {
    const src = seedSource();
    const t = Date.now() - 1000;
    spy.mockResolvedValueOnce({ events: [ev('c1', t - 1), ev('c2', t)], nextPageIndex: 'tok', totalRecords: null });
    const err = new Error('boom');
    err.response = { status: 400, data: { errorMessage: 'bad window' } };
    spy.mockRejectedValueOnce(err);
    await brocadePoller.pollEvents(src);
    const n = db.prepare('SELECT COUNT(*) AS n FROM brocade_events WHERE source_id = ?').get(src.id).n;
    expect(n).toBe(2);
    const row = fresh(src.id);
    expect(row.event_cursor_ms).toBe(t);
    expect(row.last_event_poll_status).toBe('error');
    expect(row.last_event_poll_error).toContain('HTTP 400: bad window');
    expect(row.last_event_poll_error).toContain('page 2');
  });

  it('halves the window once when page 1 answers 400', async () => {
    const src = seedSource();
    const err = new Error('boom');
    err.response = { status: 400, data: { message: 'span too long' } };
    spy.mockRejectedValueOnce(err);
    spy.mockResolvedValueOnce({ events: [], nextPageIndex: null, totalRecords: 0 });
    await brocadePoller.pollEvents(src);
    expect(spy).toHaveBeenCalledTimes(2);
    const a = spy.mock.calls[0][1];
    const b = spy.mock.calls[1][1];
    const first = a.endTime - a.startTime;
    const second = b.endTime - b.startTime;
    expect(Math.abs(second - first / 2)).toBeLessThanOrEqual(1);
    expect(fresh(src.id).last_event_poll_status).toBe('success');
  });
});

describe('events page size (SANnav 3.0.1 accepts 100 to 5000)', () => {
  it('the poller and the probe both send a page size inside the range', async () => {
    const src = seedSource();
    spy.mockResolvedValue({ events: [], nextPageIndex: null, totalRecords: 0 });
    await brocadePoller.pollEvents(src);
    const pollSize = spy.mock.calls[0][1].pageSize;
    expect(pollSize).toBeGreaterThanOrEqual(100);
    expect(pollSize).toBeLessThanOrEqual(5000);

    registry._reset();
    registry.init();
    registry.registerPlugin(brocadeManifest);
    registry.setEnabled('brocade', true);
    const app = createApp({ licenseGate: (req, res, next) => next() });
    const res = await request(app).get(`/api/brocade/sources/${src.id}/probe?section=events`).set('x-api-key', 'test-api-key');
    expect(res.status).toBe(200);
    const probeSize = spy.mock.calls[spy.mock.calls.length - 1][1].pageSize;
    expect(probeSize).toBeGreaterThanOrEqual(100);
    expect(probeSize).toBeLessThanOrEqual(5000);
  });
});
