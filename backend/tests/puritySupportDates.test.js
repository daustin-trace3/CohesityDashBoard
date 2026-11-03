import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { lookup, tableInfo, parsePurityVersion } = require('../services/puritySupportDates');
const table = require('../services/puritySupportTable.json');

const at = (iso) => new Date(`${iso}T12:00:00Z`);
const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

describe('puritySupportDates parsing', () => {
  it('reads plain, patch and prefixed version strings', () => {
    expect(lookup('6.7.9').line).toBe('6.7');
    expect(lookup('6.5.11').line).toBe('6.5');
    expect(lookup('Purity//FA 6.9.4').line).toBe('6.9');
    expect(lookup('6.10.2').line).toBe('6.10');
    expect(lookup('6.5').line).toBe('6.5');
  });

  it('keeps 6.1 and 6.10 apart', () => {
    expect(parsePurityVersion('6.10.2')).toEqual({ major: 6, minor: 10, micro: 2 });
    expect(lookup('6.1.0').phase).toBe('unknown');
  });

  it('returns unknown for lines not in the table and for garbage', () => {
    for (const v of ['6.11.1', '4.1.2', '5.3.0', 'Purity//FA', 'nonsense', '', null, undefined]) {
      const r = lookup(v, at('2026-11-03'));
      expect(r.phase).toBe('unknown');
      expect(r.line).toBeNull();
      expect(r.end_of_development).toBeNull();
      expect(r.days_to_eol).toBeNull();
    }
  });
});

describe('puritySupportDates phases', () => {
  const llr65 = table.lines.find((l) => l.line === '6.5');

  it('is eol the day after end of development, supported through the end day', () => {
    const prev = new Date(Date.parse(`${llr65.end_of_development}T12:00:00Z`) - 86400000);
    expect(lookup('6.5.1', prev, 0).phase).toBe('supported');
    expect(lookup('6.5.1', at(llr65.end_of_development), 180).phase).toBe('approaching');
    expect(lookup('6.5.1', at(llr65.end_of_development), 180).days_to_eol).toBe(0);
    expect(lookup('6.5.1', at(nextDay(llr65.end_of_development)), 180).phase).toBe('eol');
  });

  it('reports approaching inside the warning window and supported outside it', () => {
    // 6.7 ends 2027-10-31. 100 days before is 2027-07-23.
    expect(lookup('6.7.9', at('2027-07-23'), 180).phase).toBe('approaching');
    expect(lookup('6.7.9', at('2027-07-23'), 90).phase).toBe('supported');
    expect(lookup('6.7.9', at('2027-07-23'), 180).days_to_eol).toBe(100);
  });

  it('counts days to end of development and goes negative afterwards', () => {
    const r = lookup('6.5.11', at('2026-11-03'));
    expect(r.end_of_development).toBe('2026-09-30');
    expect(r.days_to_eol).toBe(-34);
    expect(r.phase).toBe('eol');
    expect(r.kind).toBe('llr');
    expect(lookup('6.8.0', at('2026-11-03')).phase).toBe('eol');
    expect(lookup('6.8.0', at('2026-11-03')).kind).toBe('feature');
  });

  it('uses 180 days as the default warning window', () => {
    // 6.9 ends 2028-06-30; 180 days before is 2028-01-02.
    expect(lookup('6.9.4', at('2028-01-02')).phase).toBe('approaching');
    expect(lookup('6.9.4', at('2028-01-01')).phase).toBe('supported');
  });

  it('holds the five documented lines and labels its source', () => {
    expect(table.lines.map((l) => l.line)).toEqual(['6.5', '6.7', '6.8', '6.9', '6.10']);
    const info = tableInfo();
    expect(info.line_count).toBe(5);
    expect(info.captured).toBe('2026-11-03');
    expect(info.source).toMatch(/community/i);
  });
});
