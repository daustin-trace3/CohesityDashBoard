/**
 * Round-trip coverage for anonymizer.js's loadDictionary() dictionary
 * sources plus the key-based whole-value masking (serial/service_tag ->
 * SERIAL, user/requested_by/created_by -> USER, wwn -> MAC) and the SERIAL
 * token category.
 *
 * This used to seed fixture rows for the non-Cohesity platform dictionary
 * sources (Pure, NetApp, Zerto, vCenter, Dell, Aria, AWS), but those 9
 * platforms were removed from core in the 2026-08 pluginization campaign
 * (their tables are gone) — loadDictionary() itself already wraps each
 * platform's queries in a try/catch ("<platform> tables not present on this
 * instance"), so it degrades gracefully with no test changes needed there.
 * The "scrubs seeded platform names" and CLUSTER-token round-trip coverage
 * is instead exercised against cohesity's own `clusters` table, which stays
 * in core and is the identical dictionary mechanic (name -> CLUSTER token).
 * The key-based whole-value masking tests below never touched the DB and
 * are unchanged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { createAnonymizer } = require('../services/anonymizer');

beforeAll(() => {
  db.prepare(`
    INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
    VALUES ('cohesity-cluster-alpha', 'direct', 'apikey', ?)
  `).run(encrypt(JSON.stringify({})));
});

const SEEDED_NAMES = ['cohesity-cluster-alpha'];

describe('anonymizer platform coverage', () => {
  it('scrubs seeded platform names with zero leaks in a composed text blob', () => {
    const anon = createAnonymizer();
    const blob = SEEDED_NAMES.map((n) => `Alert regarding ${n} at 10.20.30.40`).join('. ');
    const out = anon.anonymize(blob);
    for (const name of SEEDED_NAMES) {
      expect(out).not.toContain(name);
    }
  });

  it('masks a service_tag value entirely with a SERIAL token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ service_tag: 'ABC1234' });
    expect(out.service_tag).toMatch(/^SERIAL-\d+$/);
    expect(out.service_tag).not.toContain('ABC1234');
  });

  it('masks a serial-keyed field entirely with a SERIAL token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ serial_number: 'SN-99887766' });
    expect(out.serial_number).toMatch(/^SERIAL-\d+$/);
  });

  it('masks a wwn-keyed field with a MAC token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ wwn: '52:4a:93:7a:00:01:02:03' });
    expect(out.wwn).toMatch(/^MAC-\d+$/);
  });

  it('masks user/created_by/requested_by keyed fields with a USER token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ username: 'jdoe', created_by: 'asmith', requested_by: 'bwhite' });
    expect(out.username).toMatch(/^USER-\d+$/);
    expect(out.created_by).toMatch(/^USER-\d+$/);
    expect(out.requested_by).toMatch(/^USER-\d+$/);
  });

  it('preserves version strings under a "version" key', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ version: '7.0.1.100' });
    expect(out.version).toBe('7.0.1.100');
  });

  it('preserves time-of-day strings that look like IPv6', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ duration: 'Started at 12:30:44 and finished later' });
    expect(out.duration).toContain('12:30:44');
  });

  it('restore() maps tokens back to originals, including a lowercased token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ name: 'cohesity-cluster-alpha' });
    const token = out.name;
    expect(token).toMatch(/^CLUSTER-\d+$/i);
    const restored = anon.restore(`Cluster ${token} and also ${token.toLowerCase()} had an issue.`);
    expect(restored).toContain('cohesity-cluster-alpha');
    expect(restored.match(/cohesity-cluster-alpha/g)).toHaveLength(2);
  });

  it('mappings() includes the expected categories after mixed use', () => {
    const anon = createAnonymizer();
    anon.anonymize({
      cluster: 'cohesity-cluster-alpha',
      service_tag: 'XYZ9999',
      wwn: '52:4a:93:7a:00:01:02:04',
      username: 'someuser',
    });
    const categories = new Set(anon.mappings().map((m) => m.token.split('-')[0]));
    expect(categories.has('CLUSTER')).toBe(true);
    expect(categories.has('SERIAL')).toBe(true);
    expect(categories.has('MAC')).toBe(true);
    expect(categories.has('USER')).toBe(true);
  });
});
