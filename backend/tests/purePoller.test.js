/**
 * Pure poller outcome rule: a poll where EVERY fetch failed is a failed poll
 * (framework records 'error'), a partial failure is recorded as 'partial',
 * and a clean poll as 'success'. Mirrors the Cohesity rule.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const pollerStatus = require('../services/pollerStatus');
// purePoller destructures these at load, so replace them on the module object
// before the poller is first required (CommonJS: vi.mock does not reach it).
const pureApi = require('../services/pureApi');

const FETCHES = [
  'fetchArrayInfo', 'fetchAlerts', 'fetchVolumes', 'fetchHosts',
  'fetchVolumesPerformance', 'fetchArrayConnections', 'fetchProtectionGroups',
  'fetchHardware', 'fetchDrives', 'fetchControllers', 'fetchCertificates',
  'fetchNetworkInterfaces', 'fetchPorts', 'fetchConnections', 'fetchPods',
];
const behaviour = {};
let pollArray;
let arrayId;

beforeAll(() => {
  for (const name of FETCHES) pureApi[name] = (...a) => behaviour[name](...a);
  ({ pollArray } = require('../services/purePoller'));
  arrayId = db.prepare(`
    INSERT INTO pure_arrays (name, mgmt_host, client_id, key_id, username, encrypted_credentials, auth_method)
    VALUES ('fa-test', 'fa.example.com', 'c', 'k', 'u', 'enc', 'token')
  `).run().lastInsertRowid;
});

function setAll(fn) { for (const n of FETCHES) behaviour[n] = fn; }
function row() { return db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId); }
function array() { return row(); }

let markEnd;
beforeEach(() => {
  markEnd = vi.spyOn(pollerStatus, 'markEnd');
  db.prepare('UPDATE pure_arrays SET last_poll_at = NULL, last_poll_status = NULL, last_poll_error = NULL WHERE id = ?').run(arrayId);
  db.prepare('DELETE FROM pure_volumes WHERE array_id = ?').run(arrayId);
});
afterEach(() => { markEnd.mockRestore(); });

describe('pure poller outcome', () => {
  it('every fetch rejected: poll recorded as error with the first error', async () => {
    setAll(() => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:443')));
    await pollArray(array());
    const r = row();
    expect(r.last_poll_status).toBe('error');
    expect(r.last_poll_error).toContain('every fetch failed');
    expect(r.last_poll_error).toContain('ECONNREFUSED');
    expect(r.last_poll_at).toBeTruthy();
    expect(markEnd).toHaveBeenCalledWith('pure', arrayId, 'error');
  });

  it('two fetches rejected: partial, names both sections, stores the rest', async () => {
    setAll(() => Promise.resolve([]));
    behaviour.fetchVolumes = () => Promise.resolve([{ name: 'vol1', provisioned: 100, space: { total_physical: 10 } }]);
    behaviour.fetchHosts = () => Promise.reject(new Error('hosts boom'));
    behaviour.fetchPods = () => Promise.reject(new Error('pods boom'));
    await pollArray(array());
    const r = row();
    expect(r.last_poll_status).toBe('partial');
    expect(r.last_poll_error).toContain('hosts');
    expect(r.last_poll_error).toContain('pods');
    expect(r.last_poll_error).toContain('hosts boom');
    expect(markEnd).toHaveBeenCalledWith('pure', arrayId, 'success');
    const vols = db.prepare('SELECT name FROM pure_volumes WHERE array_id = ?').all(arrayId);
    expect(vols.map((v) => v.name)).toEqual(['vol1']);
  });

  it('all fetches fulfilled: success, error cleared', async () => {
    setAll(() => Promise.resolve([]));
    db.prepare("UPDATE pure_arrays SET last_poll_error = 'old' WHERE id = ?").run(arrayId);
    await pollArray(array());
    const r = row();
    expect(r.last_poll_status).toBe('success');
    expect(r.last_poll_error).toBeNull();
    expect(markEnd).toHaveBeenCalledWith('pure', arrayId, 'success');
  });
});
