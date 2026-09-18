import { describe, it, expect } from 'vitest';
import { safeHttpsUrl, safeReturnTo } from './safeUrl';

describe('safeHttpsUrl', () => {
  it('returns the string for https URLs', () => {
    expect(safeHttpsUrl('https://example.com')).toBe('https://example.com');
    expect(safeHttpsUrl('https://example.com/path?query=1')).toBe('https://example.com/path?query=1');
  });

  it('returns null for http URLs', () => {
    expect(safeHttpsUrl('http://example.com')).toBeNull();
  });

  it('returns null for javascript: URLs', () => {
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
  });

  it('returns null for data: URLs', () => {
    expect(safeHttpsUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('returns null for protocol-relative URLs', () => {
    expect(safeHttpsUrl('//evil.com')).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(safeHttpsUrl('garbage')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(safeHttpsUrl(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(safeHttpsUrl(null)).toBeNull();
  });

  it('returns null for non-string', () => {
    expect(safeHttpsUrl(123)).toBeNull();
    expect(safeHttpsUrl({})).toBeNull();
  });
});

describe('safeReturnTo', () => {
  it('accepts valid /path routes', () => {
    expect(safeReturnTo('/ops', '/default')).toBe('/ops');
    expect(safeReturnTo('/ops?x=1#y', '/default')).toBe('/ops?x=1#y');
  });

  it('rejects // protocol-relative URLs', () => {
    expect(safeReturnTo('//evil.com', '/default')).toBe('/default');
  });

  it('rejects paths with backslash', () => {
    expect(safeReturnTo('/\\evil.com', '/default')).toBe('/default');
  });

  it('rejects absolute URLs', () => {
    expect(safeReturnTo('https://evil.com', '/default')).toBe('/default');
  });

  it('rejects empty string', () => {
    expect(safeReturnTo('', '/default')).toBe('/default');
  });

  it('rejects null', () => {
    expect(safeReturnTo(null, '/default')).toBe('/default');
  });

  it('rejects undefined', () => {
    expect(safeReturnTo(undefined, '/default')).toBe('/default');
  });

  it('rejects paths with control characters', () => {
    expect(safeReturnTo('/a\nb', '/default')).toBe('/default');
  });
});
