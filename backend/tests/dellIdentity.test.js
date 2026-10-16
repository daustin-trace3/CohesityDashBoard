/**
 * LogicMonitor round 9 WP4: Dell iDRAC MAC and OS hostname. The DeviceManagement
 * MacAddress field name is UNVERIFIED against a live OME.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { parseDevice, normMac } = require('../services/dellOmeApi');

const TYPES = { 1000: 'Server' };
const base = { Id: 5, DeviceServiceTag: 'ABC1234', DeviceName: 'esx01', Type: 1000 };

describe('dell device identity', () => {
  it('reads the iDRAC MAC from DeviceManagement and normalises it', () => {
    const d = parseDevice({ ...base, DeviceManagement: [{ NetworkAddress: '10.0.0.5', MacAddress: 'C8-4B-D6-AA-BB-CC' }] }, TYPES);
    expect(d.idracMac).toBe('c8:4b:d6:aa:bb:cc');
    expect(d.ipAddress).toBe('10.0.0.5');
  });

  it('is null without DeviceManagement or with a malformed MAC', () => {
    expect(parseDevice(base, TYPES).idracMac).toBeNull();
    expect(parseDevice({ ...base, DeviceManagement: [{ NetworkAddress: '10.0.0.5' }] }, TYPES).idracMac).toBeNull();
    expect(normMac('not-a-mac')).toBeNull();
    expect(normMac('c84b.d6aa.bbcc')).toBe('c8:4b:d6:aa:bb:cc');
  });

  it('the migration added idrac_mac and os_hostname', () => {
    const cols = db.prepare("PRAGMA table_info('dell_devices')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['idrac_mac', 'os_hostname']));
  });
});
