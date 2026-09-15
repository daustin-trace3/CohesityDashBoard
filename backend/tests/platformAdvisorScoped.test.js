// Scoped (per-object) reports in the shared advisor engine: cache rows keyed
// <reportKey>:<scope>, BAD_SCOPE before any LLM concern, SCOPE_NOT_FOUND when
// gather() finds nothing, and unscoped reports untouched.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { createPlatformAdvisor } = require('../services/platformAdvisor');

const TABLE = 'scoped_test_ai_reports';
let advisor;

beforeAll(() => {
  process.env.OPENAI_TOKEN = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GITHUB_MODELS_TOKEN = '';
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    report_key TEXT PRIMARY KEY, model TEXT, content TEXT NOT NULL, generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare(`DELETE FROM ${TABLE}`).run();
  advisor = createPlatformAdvisor({
    platform: 'scopedtest', feature: 'Scoped Test', table: TABLE,
    reports: {
      fleet: { system: 'x', gather: () => ({ n: 1 }), noun: 'fleet report' },
      device_360: {
        scoped: true, system: 'x',
        gather: ({ scope }) => (scope === 'ABC1234' ? { tag: scope } : null),
        noun: ({ scope }) => `device report for ${scope}`,
      },
    },
  });
});

describe('scoped advisor reports', () => {
  it('exposes SCOPED and isScoped alongside REPORTS', () => {
    expect(advisor.REPORTS).toEqual(['fleet', 'device_360']);
    expect(advisor.SCOPED).toEqual(['device_360']);
    expect(advisor.isScoped('device_360')).toBe(true);
    expect(advisor.isScoped('fleet')).toBe(false);
  });

  it('caches scoped rows per object and reads them back with the scope', () => {
    db.prepare(`INSERT INTO ${TABLE} (report_key, model, content, generated_at) VALUES (?, ?, ?, ?)`)
      .run('device_360:ABC1234', 'm', 'hello', new Date().toISOString());
    const row = advisor.getCachedReport('device_360', { scope: 'ABC1234' });
    expect(row).toMatchObject({ reportKey: 'device_360', scope: 'ABC1234', content: 'hello', stale: false });
    expect(advisor.getCachedReport('device_360', { scope: 'OTHER' })).toBeNull();
    expect(advisor.getCachedReport('device_360')).toBeNull(); // no scope, no row
    expect(advisor.getCachedReport('fleet')).toBeNull(); // unscoped key unaffected
  });

  it('rejects a scoped report without a scope before checking the LLM', async () => {
    await expect(advisor.generateReport('device_360')).rejects.toMatchObject({ code: 'BAD_SCOPE' });
    await expect(advisor.generateReport('device_360', { scope: '  ' })).rejects.toMatchObject({ code: 'BAD_SCOPE' });
  });

  it('still reports LLM_NOT_CONFIGURED for a well-formed scoped request with no token', async () => {
    await expect(advisor.generateReport('device_360', { scope: 'ABC1234' })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
    await expect(advisor.generateReport('fleet')).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });

  it('BAD_REPORT for unknown keys, scoped or not', async () => {
    await expect(advisor.generateReport('nope', { scope: 'x' })).rejects.toMatchObject({ code: 'BAD_REPORT' });
    expect(advisor.getCachedReport('nope', { scope: 'x' })).toBeNull();
  });
});
