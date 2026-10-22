import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { lookup, tableInfo, parseOntapVersion } = require('../services/ontapSupportDates');
const table = require('../services/ontapSupportTable.json');

const at = (iso) => new Date(`${iso}T12:00:00Z`);
const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

describe('ontapSupportDates lookup', () => {
  it('maps a patch release to its line', () => {
    expect(lookup('9.13.1P8').line).toBe('9.13.1');
  });
  it('maps a full node release string to major.minor', () => {
    expect(lookup('NetApp Release 9.8P3: Thu Mar 14 12:00:00 UTC 2024').line).toBe('9.8');
  });
  it('maps 8.x to Clustered Data ONTAP', () => {
    const r = lookup('8.3');
    expect(r.product).toBe('Clustered Data ONTAP');
    expect(r.line).toBe('8.3');
  });
  it('returns unknown for a line newer than the table and for garbage', () => {
    const r = lookup('9.20.1', at('2026-10-22'));
    expect(r.phase).toBe('unknown');
    expect(r.end_full_support).toBeNull();
    expect(lookup('nonsense').phase).toBe('unknown');
    expect(lookup(null).phase).toBe('unknown');
  });
  it('flips phase the day after each end date (end day inclusive)', () => {
    const t = table.lines.find((l) => l.line === '9.13.1');
    expect(lookup('9.13.1', at(t.end_full_support)).phase).toBe('full');
    expect(lookup('9.13.1', at(nextDay(t.end_full_support))).phase).toBe('limited');
    expect(lookup('9.13.1', at(t.end_limited_support)).phase).toBe('limited');
    expect(lookup('9.13.1', at(nextDay(t.end_limited_support))).phase).toBe('self-service');
    expect(lookup('9.13.1', at(t.end_self_service_support)).phase).toBe('self-service');
    expect(lookup('9.13.1', at(nextDay(t.end_self_service_support))).phase).toBe('unsupported');
  });
  it('signs the day counts and names the next milestone', () => {
    const t = table.lines.find((l) => l.line === '9.13.1');
    const dayBefore = new Date(Date.parse(`${t.end_full_support}T12:00:00Z`) - 86400000);
    const before = lookup('9.13.1', dayBefore);
    expect(before.phase).toBe('full');
    expect(before.days_to_end_full_support).toBe(1);
    expect(before.next_milestone).toEqual({ label: 'end of full support', date: t.end_full_support, days: 1 });
    const twoAfter = new Date(Date.parse(`${t.end_full_support}T12:00:00Z`) + 2 * 86400000);
    const after = lookup('9.13.1', twoAfter);
    expect(after.days_to_end_full_support).toBe(-2);
    expect(after.next_milestone.label).toBe('end of limited support');
    expect(after.days_to_end_limited_support).toBeGreaterThan(0);
  });
  it('every table line parses and has ordered dates', () => {
    for (const l of table.lines) {
      expect(parseOntapVersion(l.line)).not.toBeNull();
      expect(l.end_full_support < l.end_limited_support).toBe(true);
      expect(l.end_limited_support < l.end_self_service_support).toBe(true);
      expect(lookup(l.line).line).toBe(l.line);
    }
  });
  it('tableInfo describes the table', () => {
    expect(tableInfo()).toEqual({ source: table.source, captured: table.captured, line_count: 24 });
  });
});
