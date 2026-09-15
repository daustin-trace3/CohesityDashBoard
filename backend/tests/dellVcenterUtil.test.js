// Dell Overview CPU/memory stand-in from vCenter: OME reports the ESXi OS
// hostname (often short) while vCenter names hosts by FQDN. Matching must
// survive that mismatch without cross-matching different hosts.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { vcenterHostUtilization, shortHost } from '../services/dellVcenterUtil.js';

function mkdb(hosts, osRows) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vcenter_hosts (id INTEGER PRIMARY KEY, name TEXT, cpu_mhz_used INTEGER, cpu_mhz_capacity INTEGER,
      mem_bytes_used INTEGER, mem_bytes_capacity INTEGER);
    CREATE TABLE dell_devices (id INTEGER PRIMARY KEY, ome_id INTEGER, device_id INTEGER, name TEXT);
    CREATE TABLE dell_components (id INTEGER PRIMARY KEY, ome_id INTEGER, device_id INTEGER, kind TEXT, extra TEXT);
  `);
  const h = db.prepare('INSERT INTO vcenter_hosts (name, cpu_mhz_used, cpu_mhz_capacity, mem_bytes_used, mem_bytes_capacity) VALUES (?, ?, ?, ?, ?)');
  for (const [name, cpu, mem] of hosts) h.run(name, cpu, 100, mem, 100);
  const d = db.prepare('INSERT INTO dell_devices (ome_id, device_id, name) VALUES (1, ?, ?)');
  const c = db.prepare("INSERT INTO dell_components (ome_id, device_id, kind, extra) VALUES (1, ?, 'os', ?)");
  osRows.forEach(([deviceName, hostname], i) => {
    d.run(i + 1, deviceName);
    c.run(i + 1, JSON.stringify({ hostname }));
  });
  return db;
}
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, Math.round(r.cpu_util_pct)]));

describe('shortHost', () => {
  it('strips the domain, lowercases, and leaves IP literals alone', () => {
    expect(shortHost('ESX01.corp.example.com')).toBe('esx01');
    expect(shortHost('esx01')).toBe('esx01');
    expect(shortHost('10.20.30.40')).toBe('10.20.30.40');
  });
});

describe('vcenterHostUtilization', () => {
  it('matches OME short hostnames to vCenter FQDN hosts (the reported bug)', () => {
    const db = mkdb(
      [['esx01.corp.example.com', 40, 50], ['esx02.corp.example.com', 60, 70], ['esx03', 80, 90]],
      [['R750-1', 'esx01'], ['R750-2', 'ESX02'], ['R750-3', 'esx03']],
    );
    expect(byName(vcenterHostUtilization(db))).toEqual({ 'R750-1': 40, 'R750-2': 60, 'R750-3': 80 });
  });

  it('matches OME FQDN hostnames to vCenter short names too', () => {
    const db = mkdb([['esx01', 40, 50]], [['R750-1', 'esx01.corp.example.com']]);
    expect(byName(vcenterHostUtilization(db))).toEqual({ 'R750-1': 40 });
  });

  it('prefers the exact match when a short name is shared across domains', () => {
    const db = mkdb(
      [['esx01.dc1.example.com', 40, 50], ['esx01.dc2.example.com', 60, 70]],
      [['DC1-R750', 'esx01.dc1.example.com'], ['DC2-R750', 'esx01.dc2.example.com'], ['Unknown-R750', 'esx01']],
    );
    // The bare short name is ambiguous between the two domains and stays unmatched.
    expect(byName(vcenterHostUtilization(db))).toEqual({ 'DC1-R750': 40, 'DC2-R750': 60 });
  });

  it('skips hosts without quickstats, non-ESXi devices, and unmatched names', () => {
    const db = mkdb([['esx01.corp.example.com', null, null], ['esx02.corp.example.com', 60, 70]],
      [['R750-1', 'esx01'], ['R750-2', 'esx02'], ['Win-R750', 'winsrv01']]);
    db.prepare("INSERT INTO dell_components (ome_id, device_id, kind, extra) VALUES (1, 1, 'nic', '{\"hostname\":\"esx02\"}')").run();
    expect(byName(vcenterHostUtilization(db))).toEqual({ 'R750-2': 60 });
  });

  it('returns an empty list when the vCenter table is missing or empty', () => {
    const db = mkdb([], [['R750-1', 'esx01']]);
    expect(vcenterHostUtilization(db)).toEqual([]);
    const bare = new Database(':memory:');
    expect(() => vcenterHostUtilization(bare)).toThrow(); // caller wraps in try/catch
  });
});
