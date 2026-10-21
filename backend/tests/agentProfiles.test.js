import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const registry = require('../core/registry');
const { setSetting, getSetting } = require('../services/settings');
const profiles = require('../services/agentProfiles');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
let app;
beforeAll(() => { app = createApp({ licenseGate: (req, res, next) => next() }); });

beforeEach(() => {
  setSetting(profiles.SETTING_KEY, '');
  setSetting('platform_cohesity_enabled', '1');
  setSetting('llm_estate_context', '');
});

const bad = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const evidenceOf = (...platforms) => ({
  incident: { platforms },
  alerts: platforms.flatMap((p, i) => Array.from({ length: platforms.length - i }, () => ({ platform: p, cleared: false }))),
});

describe('profile resolution: default < manifest < override', () => {
  afterEach(() => { registry.unregisterPlugin('proffake'); });

  it('serves the shipped default and labels its source', () => {
    const c = profiles.profileFor('cohesity');
    expect(c.focusSource).toBe('default');
    expect(c.ports.source).toEqual([{ port: 443, label: 'HTTPS REST', expect: true }]);
    expect(c.evidenceBudget).toEqual({ alerts: 20, failedBackupJobs: 10, networkBlocks: 3 });
    for (const id of ['aws', 'eon']) expect(profiles.profileFor(id).ports).toEqual({ source: [], host: [] });
    for (const [id, p] of Object.entries(require('../services/agentProfiles/defaults').DEFAULTS)) {
      expect(p.focus.length, `${id} focus length`).toBeLessThanOrEqual(600);
      expect(/^[\x20-\x7E\n]*$/.test(p.focus), `${id} focus is ASCII`).toBe(true);
    }
  });

  it('a manifest layers over the default and a user override layers over the manifest', () => {
    registry.registerPlugin({
      id: 'proffake', name: 'ProfFake', apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
      agentProfile: { focus: 'manifest focus', ports: { source: [{ port: 1234, label: 'api', expect: true }] }, evidenceBudget: { alerts: 7 } },
    });
    let p = profiles.profileFor('proffake');
    expect(p).toMatchObject({ focus: 'manifest focus', focusSource: 'manifest', portsSource: 'manifest' });
    expect(p.ports.source).toEqual([{ port: 1234, label: 'api', expect: true }]);
    expect(p.ports.host).toEqual([{ port: 443, label: 'HTTPS', expect: true }]); // generic base survives
    expect(p.evidenceBudget).toEqual({ alerts: 7, failedBackupJobs: 10, networkBlocks: 3 });

    profiles.saveOverrides({ proffake: { focus: 'my focus' } }, 'tester');
    p = profiles.profileFor('proffake');
    expect(p).toMatchObject({ focus: 'my focus', focusSource: 'custom', portsSource: 'manifest' });

    profiles.saveOverrides({ proffake: { focus: null } }, 'tester');
    expect(profiles.profileFor('proffake')).toMatchObject({ focus: 'manifest focus', focusSource: 'manifest' });
  });

  it('an unknown platform gets the generic profile', () => {
    const p = profiles.profileFor('nothing-here');
    expect(p.focus).toBe('');
    expect(p.ports).toEqual({ source: [{ port: 443, label: 'HTTPS', expect: true }], host: [{ port: 443, label: 'HTTPS', expect: true }] });
    expect(p.evidenceBudget).toEqual({ alerts: 15, failedBackupJobs: 10, networkBlocks: 3 });
  });

  it('listProfiles covers enabled platforms with defaults beside the current values', () => {
    profiles.saveOverrides({ cohesity: { focus: 'changed' } }, 'tester');
    const list = profiles.listProfiles();
    const c = list.find((x) => x.id === 'cohesity');
    expect(c).toMatchObject({ name: 'Cohesity', focus: 'changed', focusSource: 'custom', maxFocus: 600 });
    expect(c.focusDefault).toMatch(/^Alert categories/);
    expect(c.relations[0]).toMatchObject({ id: 'cohesity_vm' });
    setSetting('platform_cohesity_enabled', '0');
    expect(profiles.listProfiles().find((x) => x.id === 'cohesity')).toBeUndefined();
  });
});

describe('validation', () => {
  it('rejects a port out of range, 13 entries, a 601 char focus, a long label and a repeated port', () => {
    const entry = (port) => ({ port, label: 'x', expect: true });
    let e = bad(() => profiles.saveOverrides({ pure: { ports: { source: [entry(70000)] } } }, 't'));
    expect(e).toMatchObject({ code: 'BAD_PROFILE', field: 'pure.ports.source[0].port' });
    e = bad(() => profiles.saveOverrides({ pure: { ports: { host: Array.from({ length: 13 }, (_, i) => entry(1000 + i)) } } }, 't'));
    expect(e).toMatchObject({ code: 'BAD_PROFILE', field: 'pure.ports.host' });
    e = bad(() => profiles.saveOverrides({ pure: { focus: 'a'.repeat(601) } }, 't'));
    expect(e).toMatchObject({ code: 'BAD_PROFILE', field: 'pure.focus' });
    e = bad(() => profiles.saveOverrides({ pure: { ports: { source: [{ port: 22, label: 'l'.repeat(41), expect: true }] } } }, 't'));
    expect(e).toMatchObject({ field: 'pure.ports.source[0].label' });
    e = bad(() => profiles.saveOverrides({ pure: { ports: { source: [entry(22), entry(22)] } } }, 't'));
    expect(e).toMatchObject({ field: 'pure.ports.source[1].port' });
    e = bad(() => profiles.saveOverrides({ pure: { guestPorts: { windows: [entry(0)] } } }, 't'));
    expect(e).toMatchObject({ field: 'pure.guestPorts.windows[0].port' });
    e = bad(() => profiles.saveOverrides({ 'Bad Id!': { focus: 'x' } }, 't'));
    expect(e).toMatchObject({ code: 'BAD_PROFILE' });
  });

  it('a rejected body changes nothing, even for the valid platforms in it', () => {
    bad(() => profiles.saveOverrides({ pure: { focus: 'fine' }, netapp: { focus: 'a'.repeat(601) } }, 't'));
    expect(getSetting(profiles.SETTING_KEY) || '').toBe('');
  });

  it('accepts a 600 char focus and 12 ports, null drops a field, {} drops the platform', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ port: 2000 + i, label: '', expect: false }));
    profiles.saveOverrides({ pure: { focus: 'a'.repeat(600), ports: { host: twelve } } }, 't');
    expect(profiles.profileFor('pure')).toMatchObject({ focusSource: 'custom', portsSource: 'custom' });
    expect(profiles.profileFor('pure').ports.host).toHaveLength(12);
    profiles.saveOverrides({ pure: { ports: null } }, 't');
    expect(profiles.profileFor('pure')).toMatchObject({ focusSource: 'custom', portsSource: 'default' });
    profiles.saveOverrides({ pure: {} }, 't');
    expect(profiles.profileFor('pure')).toMatchObject({ focusSource: 'default' });
  });
});

describe('buildSystemPrompt', () => {
  it('keeps the core under 450 words and carries the relations sentence', () => {
    expect(profiles.coreWordCount()).toBeLessThan(450);
    const { system } = profiles.buildSystemPrompt({ platforms: [], evidence: evidenceOf() });
    expect(system).toMatch(/relations lists how the systems in this incident connect/);
    expect(system).toMatch(/Platform notes below apply only to the platforms in this incident/);
    expect(system).not.toMatch(/Platform notes, /);
  });

  it('includes notes only for platforms present, and the backup text only with a backup platform', () => {
    const a = profiles.buildSystemPrompt({ platforms: ['vcenter'], evidence: evidenceOf('vcenter') });
    expect(a.focusUsed).toEqual(['vcenter']);
    expect(a.system).toMatch(/Platform notes, vCenter:/);
    expect(a.system).not.toMatch(/Cohesity|failedBackupJobs|NetBackup/);
    const b = profiles.buildSystemPrompt({ platforms: ['cohesity'], evidence: evidenceOf('cohesity') });
    expect(b.system).toMatch(/Platform notes, Cohesity:/);
    expect(b.system).toMatch(/failedBackupJobs/);
    expect(b.system).not.toMatch(/vCenter/);
  });

  it('caps at three platforms, most open alerts first, and skips blank focus', () => {
    const ev = evidenceOf('pure', 'netapp', 'vcenter', 'dell');
    const r = profiles.buildSystemPrompt({ platforms: ['dell', 'vcenter', 'netapp', 'pure', 'nothing-here'], evidence: ev });
    expect(r.focusUsed).toEqual(['pure', 'netapp', 'vcenter']);
  });

  it('truncates notes from the last platform backwards past 6000 characters', () => {
    const long = 'w'.repeat(600);
    profiles.saveOverrides({ pure: { focus: long }, netapp: { focus: long }, vcenter: { focus: long } }, 't');
    const ev = evidenceOf('pure', 'netapp', 'vcenter');
    const free = profiles.buildSystemPrompt({ platforms: ['pure', 'netapp', 'vcenter'], evidence: ev });
    expect(free.chars).toBeLessThanOrEqual(6000);
    expect(free.focusUsed).toHaveLength(3);
    const tight = profiles.buildSystemPrompt({ platforms: ['pure', 'netapp', 'vcenter'], evidence: ev, reserve: 6000 - free.chars + 900 });
    expect(tight.chars + (6000 - free.chars + 900)).toBeLessThanOrEqual(6000);
    expect(tight.focusUsed.length).toBeLessThan(3);
    expect(tight.focusUsed[0]).toBe('pure');
  });
});

describe('portsForTarget and budgetFor', () => {
  it('picks the list by target kind', () => {
    const nums = (a) => a.map((e) => e.port);
    expect(nums(profiles.portsForTarget({ platform: 'dell', kind: 'source' }))).toEqual([443]);
    expect(nums(profiles.portsForTarget({ platform: 'vcenter', kind: 'esx' }))).toEqual([443, 902, 22, 903]);
    expect(nums(profiles.portsForTarget({ platform: 'vcenter', kind: 'vm', osFamily: 'windows' }))).toEqual([3389, 445, 5985]);
    expect(nums(profiles.portsForTarget({ platform: 'vcenter', kind: 'vm', osFamily: 'linux' }))).toEqual([22]);
    expect(nums(profiles.portsForTarget({ platform: 'vcenter', kind: 'vm', osFamily: 'weird' }))).toEqual([443]);
    expect(nums(profiles.portsForTarget({ platform: 'dell', kind: 'device' }))).toEqual([443, 22, 5900]);
    expect(nums(profiles.portsForTarget({ platform: 'nothing-here', kind: 'device' }))).toEqual([443]);
    expect(nums(profiles.portsForTarget({ platform: 'aws', kind: 'source' }))).toEqual([]);
  });

  it('maps guest_os strings to a family', () => {
    expect(profiles.osFamilyOf('Microsoft Windows Server 2022 (64-bit)')).toBe('windows');
    for (const os of ['Ubuntu Linux (64-bit)', 'Red Hat Enterprise Linux 9 (64-bit)', 'SUSE Linux Enterprise 15 (64-bit)', 'CentOS 7 (64-bit)', 'Debian GNU/Linux 12']) expect(profiles.osFamilyOf(os)).toBe('linux');
    expect(profiles.osFamilyOf('FreeBSD')).toBe('other');
    expect(profiles.osFamilyOf(null)).toBe('other');
  });

  it('fills the evidence budget defaults', () => {
    const b = profiles.budgetFor(['cohesity', 'vcenter', 'aria', 'nothing-here']);
    expect(b.cohesity).toEqual({ alerts: 20, failedBackupJobs: 10, networkBlocks: 3 });
    expect(b.vcenter.alerts).toBe(15);
    expect(b.aria.alerts).toBe(10);
    expect(b['nothing-here']).toEqual({ alerts: 15, failedBackupJobs: 10, networkBlocks: 3 });
  });
});

describe('routes', () => {
  const get = (p) => request(app).get(`/api/ops-agent${p}`).set('x-api-key', API_KEY);

  it('GET /profiles has the documented shape', async () => {
    const res = await get('/profiles');
    expect(res.status).toBe(200);
    expect(res.body.maxFocus).toBe(600);
    expect(res.body.osFamilies).toEqual(['windows', 'linux', 'other']);
    const c = res.body.profiles.find((x) => x.id === 'cohesity');
    expect(c).toEqual(expect.objectContaining({ name: 'Cohesity', focusSource: 'default', evidenceBudget: expect.any(Object), ports: expect.any(Object), relations: expect.any(Array) }));
  });

  it('GET /prompt-preview 404s on an unknown incident and describes a known one', async () => {
    expect((await get('/prompt-preview?incidentId=999999')).status).toBe(404);
    db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents;');
    const now = '2026-10-21T12:00:00.000Z';
    const id = db.prepare(`INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, evidence_json)
      VALUES ('host:esx-1', 't', 'esx-1', '["vcenter"]', 'critical', 'notified', ?, ?, ?, ?)`)
      .run(now, now, now, JSON.stringify({ incident: { platforms: ['vcenter'] }, alerts: [{ platform: 'vcenter', cleared: false }], relations: ['VM a runs on host b'] })).lastInsertRowid;
    const res = await get(`/prompt-preview?incidentId=${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ focusUsed: ['vcenter'], relations: ['VM a runs on host b'] });
    expect(res.body.chars).toBe(res.body.system.length);
    expect(res.body.approxTokens).toBe(Math.ceil(res.body.chars / 4));
    expect(res.body.evidenceChars).toBeGreaterThan(10);
    db.exec('DELETE FROM ops_incidents;');
  });

  it('PUT /api/settings answers 400 with the field named, and saves a good body', async () => {
    const put = (body) => request(app).put('/api/settings').set('x-api-key', API_KEY).send(body);
    const badRes = await put({ opsAgent: { platformProfiles: { pure: { ports: { source: [{ port: 70000, label: '', expect: true }] } } } } });
    expect(badRes.status).toBe(400);
    expect(badRes.body.field).toBe('pure.ports.source[0].port');
    const ok = await put({ opsAgent: { platformProfiles: { pure: { focus: 'saved through the route' } } } });
    expect(ok.status).toBeLessThan(300);
    expect(profiles.profileFor('pure')).toMatchObject({ focus: 'saved through the route', focusSource: 'custom' });
  });
});
