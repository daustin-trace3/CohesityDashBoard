/**
 * LogicMonitor round 9, WP3: description grammar. Every example is a verbatim
 * port description or neighbour name from the CG portal export (2026-10-15).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseEndpointDescription: parse, linkFromDescription } = require('../services/logicmonitorGrammar');
const lmPoller = require('../services/logicmonitorPoller');

describe('parseEndpointDescription', () => {
  it('reads NetApp node and port', () => {
    expect(parse('ASX1NACLS-02 e4a')).toEqual({ platformHint: 'netapp', host: 'asx1nacls-02', nic: 'e4a', confidence: 'high', cls: null });
    expect(parse('ASX1NACLS-01 e4e')).toMatchObject({ host: 'asx1nacls-01', nic: 'e4e' });
    expect(parse('IRVNACLSFS-01 e0e & e1a')).toMatchObject({ platformHint: 'netapp', host: 'irvnaclsfs-01', nic: 'e0e & e1a', confidence: 'high' });
  });

  it('reads the CG tag class and strips the tag before matching', () => {
    expect(parse('irvxnas-01 e0c [t=srv m=0 q=0 n=0]')).toEqual({ platformHint: 'netapp', host: 'irvxnas-01', nic: 'e0c', confidence: 'high', cls: 'srv' });
    expect(parse('snoxnas-02-wrench [t=srv m=0 q=0 n=0]')).toEqual({ platformHint: null, host: 'snoxnas-02-wrench', nic: null, confidence: 'low', cls: 'srv' });
    // several words: the class is kept, no host to resolve
    expect(parse('ThousandEyes agent [t=srv m=0 q=0 n=0]')).toEqual({ platformHint: null, host: null, nic: null, confidence: 'low', cls: 'srv' });
  });

  it('reads the NetApp pair uplink', () => {
    expect(parse('ASX1NACLS-01 & 2 -C@uplink-')).toEqual({ platformHint: 'netapp', host: 'asx1nacls-01', nic: null, confidence: 'medium', cls: null });
  });

  it('reads Pure controller ports (the Port N spelling is kept as typed)', () => {
    expect(parse('SNX2GCPRDR1SA01-CT1 Eth2')).toEqual({ platformHint: 'pure', host: 'snx2gcprdr1sa01', nic: 'ct1.eth2', confidence: 'high', cls: null });
    expect(parse('SNX2MGPRAR1SA01-ct0 Port 2')).toMatchObject({ platformHint: 'pure', host: 'snx2mgprar1sa01', nic: 'ct0.port 2' });
  });

  it('reads Dell iDRAC by hostname and by MAC', () => {
    expect(parse('SJX1PENTEST1 iDRAC')).toEqual({ platformHint: 'dell', host: 'sjx1pentest1', nic: 'idrac', confidence: 'high', cls: null });
    expect(parse('ASX1PENTEST1-Idrac')).toMatchObject({ platformHint: 'dell', host: 'asx1pentest1', nic: 'idrac' });
    expect(parse('idrac - c8:4b:d6:a1:6e:31')).toEqual({ platformHint: 'dell', host: 'c8:4b:d6:a1:6e:31', nic: 'idrac', confidence: 'high', cls: null });
  });

  it('returns null when no shape applies so the generic parser runs', () => {
    expect(parse('Uplink to core-1 port 5')).toBeNull();
    expect(parse('SNX1-CORE-2 E1/8 @int')).toBeNull();
    expect(parse('to nyc-esx-0101 vmnic0')).toBeNull();
    expect(parse('server nyc-esx-0101.icc.demo')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse(null)).toBeNull();
  });
});

describe('linkFromDescription', () => {
  const lm = (name) => (name === 'asx1pentest1' ? 7 : null);
  const icc = (name) => (name === 'asx1nacls-02' ? { platform: 'netapp', ref: 'asx1nacls-02', platforms: ['netapp'] } : null);

  it('resolves LM devices first, then the ICC identity, and keeps the class', () => {
    expect(linkFromDescription('ASX1NACLS-02 e4a', lm, icc)).toEqual({
      link: { dstDeviceId: null, dstName: 'asx1nacls-02', dstPort: 'e4a', confidence: 'high', dstPlatform: 'netapp', dstRef: 'asx1nacls-02' },
      cls: null,
    });
    expect(linkFromDescription('ASX1PENTEST1-Idrac', lm, icc).link).toMatchObject({ dstDeviceId: 7, dstPlatform: 'logicmonitor', dstPort: 'idrac' });
  });

  it('drops one confidence step when the resolved platform differs from the hint', () => {
    const other = () => ({ platform: 'unifi', ref: 'asx1nacls-02', platforms: ['unifi'] });
    expect(linkFromDescription('ASX1NACLS-02 e4a', () => null, other).link.confidence).toBe('medium');
  });

  it('returns no link when nothing resolves, but still returns the class', () => {
    expect(linkFromDescription('snoxnas-02-wrench [t=srv m=0 q=0 n=0]', () => null, () => null)).toEqual({ link: null, cls: 'srv' });
    expect(linkFromDescription('printer port', () => null, () => null)).toEqual({ link: null, cls: null });
  });
});

describe('CG neighbour names through the LM device index', () => {
  it('resolves "name(serial)" and a different domain spelling to the same LM device', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE lm_devices (source_id INTEGER, lm_device_id INTEGER, display_name TEXT, name TEXT, sysname TEXT, hostname TEXT,
      serial TEXT, ips_json TEXT, eri_json TEXT, stale INTEGER DEFAULT 0)`);
    const ins = db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, display_name, name, sysname, hostname, serial) VALUES (1, ?, ?, ?, ?, ?, ?)');
    ins.run(1, 'nyx1-mgt-1', 'nyx1-mgt-1', 'NYX1-MGT-1', null, 'FLM29210HWA');
    ins.run(2, 'snot-core-1.cgftdev.com', 'snot-core-1.cgftdev.com', null, null, null);
    ins.run(3, 'chx1-pfs-1', 'chx1-pfs-1', 'CHX1-PFS-1', null, null);
    const index = lmPoller.buildDeviceIndex(db, 1);
    const resolve = (t) => { const r = index.get(String(t).toLowerCase()); return r == null ? null : r; };
    expect(resolve('nyx1-mgt-1')).toBe(1);
    expect(resolve('flm29210hwa')).toBe(1);   // serial indexes
    expect(resolve('snot-core-1')).toBe(2);   // domain stripped
    expect(resolve('CHX1-PFS-1')).toBe(3);
    // the poller resolver also accepts the "(serial)" spelling, with or without the closing paren
    const resolver = lmPoller.makeResolver(index, 99);
    expect(resolver('nyx1-mgt-1(flm29210hwa)')).toBe(1);
    expect(resolver('nyx1-mgt-1(flm29210hwa')).toBe(1);
    const neighbour = lmPoller.parseNeighborInstance({ instanceId: 5, displayName: 'nyx1-mgt-1(flm29210hwa)', props: { auto: {} } }, resolver);
    expect(neighbour.dstDeviceId).toBe(1);
    expect(resolver('ascx-mgt-1-new')).toBeNull();
  });
});
