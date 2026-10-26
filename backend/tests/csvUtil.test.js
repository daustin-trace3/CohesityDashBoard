import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { csvCell, sendCsv } = require('../utils/csv');

describe('csvCell', () => {
  it('handles null, numbers and plain strings', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell('plain')).toBe('plain');
  });

  it('quotes cells with commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
  });

  it('guards formula starters with a leading apostrophe', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('=a,b')).toBe('"\'=a,b"');
  });

  it('does not guard negative numbers', () => {
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('sendCsv', () => {
  it('sets headers and joins with CRLF', () => {
    const headers = {};
    let body;
    const res = { setHeader: (k, v) => { headers[k] = v; }, send: (b) => { body = b; } };
    sendCsv(res, 'x.csv', ['A', 'B'], [[1, 'two'], [null, '=x']]);
    expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(headers['Content-Disposition']).toBe('attachment; filename="x.csv"');
    expect(body).toBe("A,B\r\n1,two\r\n,'=x\r\n");
  });
});
