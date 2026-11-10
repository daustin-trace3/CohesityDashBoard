/**
 * Backend for the "What's New" popup: CHANGELOG.md parser (services/releaseNotes.js)
 * and the read-only GET /api/release-notes route.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

const require = createRequire(import.meta.url);

const FIXTURE = `# Changelog

## [1.1.0] - 2026-08-03
### Added
- Proxmox VE platform (nodes, VMs/containers, storage, backups)
- A feature with a bullet that
  wraps onto a continuation line
### Fixed
- Failed polls no longer wipe stored inventory
### Changed
- Overview trend charts split into CPU / memory / IO-wait

## [1.0.0] - 2026-07-30
### Added
- Initial release
`;

function freshReleaseNotes() {
  delete require.cache[require.resolve('../services/releaseNotes')];
  return require('../services/releaseNotes');
}

describe('services/releaseNotes', () => {
  let tmpDir;
  let fixturePath;
  const originalEnv = process.env.RELEASE_NOTES_CHANGELOG_PATH;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-changelog-'));
    fixturePath = path.join(tmpDir, 'CHANGELOG.md');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.RELEASE_NOTES_CHANGELOG_PATH;
    else process.env.RELEASE_NOTES_CHANGELOG_PATH = originalEnv;
    freshReleaseNotes();
  });

  it('parses a fixture: multi-category, multi-line bullet, version+date, previousVersion', () => {
    fs.writeFileSync(fixturePath, FIXTURE, 'utf8');
    process.env.RELEASE_NOTES_CHANGELOG_PATH = fixturePath;
    const { getLatest, getAll } = freshReleaseNotes();

    const latest = getLatest();
    expect(latest.version).toBe('1.1.0');
    expect(latest.date).toBe('2026-08-03');
    expect(latest.previousVersion).toBe('1.0.0');
    expect(latest.sections).toEqual([
      {
        title: 'Added',
        items: [
          'Proxmox VE platform (nodes, VMs/containers, storage, backups)',
          'A feature with a bullet that wraps onto a continuation line',
        ],
      },
      { title: 'Fixed', items: ['Failed polls no longer wipe stored inventory'] },
      { title: 'Changed', items: ['Overview trend charts split into CPU / memory / IO-wait'] },
    ]);

    const all = getAll();
    expect(all.length).toBe(2);
    expect(all[0].version).toBe('1.1.0');
    expect(all[1].version).toBe('1.0.0');
  });

  it('missing file falls back to pkg version with null date/previousVersion and no sections', () => {
    process.env.RELEASE_NOTES_CHANGELOG_PATH = path.join(tmpDir, 'does-not-exist.md');
    const { getLatest, getAll } = freshReleaseNotes();
    const pkg = require('../../package.json');

    const latest = getLatest();
    expect(latest).toEqual({ version: pkg.version, date: null, previousVersion: null, sections: [] });
    expect(getAll()).toEqual([]);
  });
});

describe('GET /api/release-notes', () => {
  const API_KEY = 'test-api-key';
  let app;

  beforeAll(() => {
    delete process.env.RELEASE_NOTES_CHANGELOG_PATH;
    freshReleaseNotes();
    delete require.cache[require.resolve('../app')];
    const { createApp } = require('../app');
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('returns 200 with the pinned shape', async () => {
    const res = await request(app).get('/api/release-notes').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('appVersion');
    expect(res.body).toHaveProperty('latest');
    expect(res.body.latest).toHaveProperty('version');
    expect(res.body.latest).toHaveProperty('date');
    expect(res.body.latest).toHaveProperty('previousVersion');
    expect(res.body.latest).toHaveProperty('sections');
    expect(Array.isArray(res.body.latest.sections)).toBe(true);
  });
});
