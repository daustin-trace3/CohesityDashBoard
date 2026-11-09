import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { pairUnits, stemOf, roleOf } = require('../platforms/f5/haPairs');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const U = (o) => ({
  sourceId: 1, deviceId: 1, device: 'lb-phx-01', site: 'phx', failoverText: 'active', syncState: 'In Sync', cpuP95_7d: 30, cpuBaseline: 10,
  clientConnections: 1000, lastFailoverDay: '2026-11-01', failovers90d: 2, ...o,
});

describe('stemOf', () => {
  it('strips the HA marker and nothing else', () => {
    expect(stemOf('lb-phx-01')).toBe('lb-phx');
    expect(stemOf('lb-phx-02')).toBe('lb-phx');
    expect(stemOf('f5-a')).toBe('f5');
    expect(stemOf('f5-b')).toBe('f5');
    expect(stemOf('bigip-primary')).toBe('bigip');
    expect(stemOf('bigip-secondary')).toBe('bigip');
    expect(stemOf('ltm-pri')).toBe('ltm');
    expect(stemOf('lb1.corp.local')).toBe('lb');
    expect(stemOf('lb2')).toBe('lb');
    expect(stemOf('lbdata')).toBe('lbdata');
    expect(stemOf('lbb')).toBe('lbb');
    expect(stemOf('web-12')).toBe('web-12');
    expect(stemOf('10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('roleOf', () => {
  it('prefers text and falls back to the F5 MIB enum', () => {
    expect(roleOf({ failoverText: 'Active' })).toBe('active');
    expect(roleOf({ failoverText: 'standby' })).toBe('standby');
    expect(roleOf({ failoverText: 'forced offline' })).toBe('offline');
    expect(roleOf({ failoverState: { raw: 4, text: 'standby' } })).toBe('standby');
    expect(roleOf({ failoverState: 4 })).toBe('active');
    expect(roleOf({ failoverState: 3 })).toBe('standby');
    expect(roleOf({ failoverState: 1 })).toBe('offline');
    expect(roleOf({})).toBe('unknown');
  });
});

describe('pairUnits', () => {
  it('pairs a healthy active and standby by site and name stem', () => {
    const pairs = pairUnits([
      U({ deviceId: 2, device: 'lb-phx-02', failoverText: 'standby', cpuP95_7d: 5, cpuBaseline: 8, clientConnections: 10 }),
      U({ deviceId: 1, device: 'lb-phx-01' }),
    ], { now: NOW });
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.units.map((u) => u.device)).toEqual(['lb-phx-01', 'lb-phx-02']);
    expect(p.roles).toEqual(['active', 'standby']);
    expect(p.severity).toBe('ok');
    expect(p.bothActive).toBe(false);
    expect(p.neitherActive).toBe(false);
    expect(p.daysSinceFailover).toBe(8);
    expect(p.failovers90d).toBe(2);
    expect(p.headroom).toMatchObject({ activeCpuP95: 30, standbyCpuBaseline: 8, sum: 38, ok: true });
    expect(p.asymmetry).toBe(false);
  });

  it('flags both active and neither active as critical', () => {
    const both = pairUnits([U({ device: 'a-01' }), U({ deviceId: 2, device: 'a-02' })], { now: NOW })[0];
    expect(both.bothActive).toBe(true);
    expect(both.severity).toBe('critical');
    const neither = pairUnits([U({ device: 'b-01', failoverText: 'standby' }), U({ deviceId: 2, device: 'b-02', failoverText: 'offline' })], { now: NOW })[0];
    expect(neither.neitherActive).toBe(true);
    expect(neither.severity).toBe('critical');
  });

  it('flags no headroom and standby asymmetry', () => {
    const p = pairUnits([
      U({ device: 'c-01', cpuP95_7d: 60 }),
      U({ deviceId: 2, device: 'c-02', failoverText: 'standby', cpuBaseline: 30, clientConnections: 300 }),
    ], { now: NOW })[0];
    expect(p.headroom.ok).toBe(false);
    expect(p.asymmetry).toBe(true);
    expect(p.standbyShare).toBeCloseTo(0.3);
    expect(p.severity).toBe('warning');
    expect(p.reasons.join(' ')).toMatch(/cannot absorb/);
    expect(p.reasons.join(' ')).toMatch(/30 percent/);
  });

  it('reports insufficient headroom data instead of a verdict', () => {
    const p = pairUnits([U({ device: 'd-01', cpuP95_7d: null }), U({ deviceId: 2, device: 'd-02', failoverText: 'standby', cpuBaseline: null, cpuP95_7d: null })], { now: NOW })[0];
    expect(p.headroom.ok).toBeNull();
  });

  it('returns an odd unit alone and marks the missing partner', () => {
    const pairs = pairUnits([
      U({ device: 'e-01', site: 'dal' }), U({ deviceId: 2, device: 'e-02', site: 'dal', failoverText: 'standby' }),
      U({ deviceId: 3, device: 'solo-01', site: 'dal' }),
    ], { now: NOW });
    expect(pairs).toHaveLength(2);
    const solo = pairs.find((p) => p.partnerMissing);
    expect(solo.units[1]).toBeNull();
    expect(solo.neitherActive).toBe(false);
    expect(solo.severity).toBe('warning');
  });

  it('keeps units at different sites apart even with the same stem', () => {
    const pairs = pairUnits([U({ device: 'lb-01', site: 'phx' }), U({ deviceId: 2, device: 'lb-02', site: 'dal', failoverText: 'standby' })], { now: NOW });
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.partnerMissing)).toBe(true);
  });

  it('uses the device group when the feed carries one, whatever the names say', () => {
    const pairs = pairUnits([
      U({ device: 'alpha', deviceGroup: 'grp1', site: 'phx' }),
      U({ deviceId: 2, device: 'omega', deviceGroup: 'grp1', site: 'dal', failoverText: 'standby' }),
    ], { now: NOW });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].units.map((u) => u.device)).toEqual(['alpha', 'omega']);
  });

  it('chunks a group of more than two units into pairs and sorts worst first', () => {
    const rows = ['g-01', 'g-02', 'g-03'].map((n, i) => U({ deviceId: i + 1, device: n, deviceGroup: 'big', failoverText: i === 0 ? 'active' : 'standby' }));
    const pairs = pairUnits(rows, { now: NOW });
    expect(pairs).toHaveLength(2);
    expect(pairs[0].severity).not.toBe('ok');
  });

  it('handles empty and malformed input', () => {
    expect(pairUnits([], { now: NOW })).toEqual([]);
    expect(pairUnits(null, { now: NOW })).toEqual([]);
    expect(pairUnits([null, U({ device: 'z-01' })], { now: NOW })).toHaveLength(1);
  });
});
