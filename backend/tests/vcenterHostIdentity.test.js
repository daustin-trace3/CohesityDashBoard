/**
 * LogicMonitor round 9 WP4: vCenter host serial / service tag / uuid from the
 * SOAP PropertyCollector fragment. Property shapes are UNVERIFIED live.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { parseHostIdentity } = require('../services/vcenterApi');

const info = (key, value) => ({ identifierValue: value, identifierType: { key } });

describe('parseHostIdentity', () => {
  it('reads the ServiceTag entry, serial and uuid', () => {
    const r = parseHostIdentity({
      'hardware.systemInfo.serialNumber': 'ABC1234',
      'hardware.systemInfo.uuid': '4c4c4544-0001-0000-0000-000000000000',
      'hardware.systemInfo.otherIdentifyingInfo': { HostSystemIdentificationInfo: [info('AssetTag', 'A1'), info('ServiceTag', 'XYZ9876')] },
    });
    expect(r).toEqual({ serial: 'ABC1234', serviceTag: 'XYZ9876', uuid: '4c4c4544-0001-0000-0000-000000000000' });
  });

  it('handles a single (non-array) identification entry', () => {
    const r = parseHostIdentity({ 'hardware.systemInfo.otherIdentifyingInfo': { HostSystemIdentificationInfo: info('ServiceTag', 'ONE1234') } });
    expect(r.serviceTag).toBe('ONE1234');
    expect(r.serial).toBeNull();
  });

  it('without otherIdentifyingInfo a 7-char serial is taken as the tag', () => {
    expect(parseHostIdentity({ 'hardware.systemInfo.serialNumber': 'ABC1234' })).toMatchObject({ serial: 'ABC1234', serviceTag: 'ABC1234' });
    expect(parseHostIdentity({ 'hardware.systemInfo.serialNumber': 'VMware-56 4d 12' })).toMatchObject({ serviceTag: null });
  });

  it('absence yields nulls and never throws', () => {
    expect(parseHostIdentity({})).toEqual({ serial: null, serviceTag: null, uuid: null });
    expect(parseHostIdentity(null)).toEqual({ serial: null, serviceTag: null, uuid: null });
  });

  it('the migration added the columns', () => {
    const cols = db.prepare("PRAGMA table_info('vcenter_hosts')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['serial', 'service_tag', 'uuid']));
  });
});
