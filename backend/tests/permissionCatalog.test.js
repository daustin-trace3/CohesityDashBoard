import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const express = require('express');
const registry = require('../core/registry');
const feeds = require('../core/feeds');
const catalogMod = require('../services/permissionCatalog');
const { buildCatalog, walkRouter, CATEGORY_FALLBACK, COHESITY_SECTIONS } = catalogMod;

function manifest(id, extra = {}) {
  return { id, name: `Plat ${id}`, apiVersion: 1, createRouter: () => (req, res, next) => next(), ...extra };
}

function find(cat, id) {
  const c = cat.categories.find((x) => x.platforms.some((p) => p.id === id));
  return { category: c && c.key, row: c && c.platforms.find((p) => p.id === id) };
}

beforeEach(() => {
  registry._reset();
  registry.init();
  catalogMod._resetMemo();
});

describe('permissionCatalog', () => {
  it('uses the host fallback map for known ids and other for unknown ids', () => {
    registry.registerPlugin(manifest('pure'));
    registry.registerPlugin(manifest('zerto'));
    registry.registerPlugin(manifest('mystery'));
    const cat = buildCatalog({ storedGrants: [] });
    expect(find(cat, 'pure').category).toBe('storage');
    expect(find(cat, 'zerto').category).toBe('dr');
    expect(find(cat, 'mystery').category).toBe('other');
    expect(CATEGORY_FALLBACK.cohesity).toBe('backup');
  });

  it('manifest.category wins and an invalid one is ignored', () => {
    registry.registerPlugin(manifest('widget', { category: 'network' }));
    registry.registerPlugin(manifest('gadget', { category: 'bogus' }));
    const cat = buildCatalog({});
    expect(find(cat, 'widget').category).toBe('network');
    expect(find(cat, 'gadget').category).toBe('other');
  });

  it('a derived platform takes the category of its connector platform', () => {
    registry.registerPlugin(manifest('logicmonitor'));
    if (!feeds.hasConnector('logicmonitor')) feeds.registerConnector('logicmonitor', { name: 'LM', register() {} });
    registry.registerPlugin(manifest('derivedy', {
      derivedFrom: 'logicmonitor', vendorKeys: ['dy'], presence: () => true,
    }));
    const { category, row } = find(buildCatalog({}), 'derivedy');
    expect(category).toBe('network');
    expect(row.derived).toBe(true);
    expect(row.derivedFrom).toBe('logicmonitor');
  });

  it('walks an express Router: first segments, extensions stripped, params skipped', () => {
    const r = express.Router();
    r.get('/interfaces.csv', () => {});
    r.get('/devices/:id', () => {});
    r.post('/devices', () => {});
    r.get('/:id', () => {});
    r.get('/', () => {});
    const nested = express.Router();
    nested.get('/x', () => {});
    r.use('/groups', nested);
    expect(walkRouter(r).sort()).toEqual(['devices', 'groups', 'interfaces']);
  });

  it('a bare-function router yields no sections', () => {
    registry.registerPlugin(manifest('barepack'));
    expect(find(buildCatalog({}), 'barepack').row.sections).toEqual([]);
  });

  it('a Router returned by createRouter produces sections in the catalog', () => {
    registry.registerPlugin(manifest('routed', {
      createRouter: () => { const r = express.Router(); r.get('/alpha-beta', () => {}); r.get('/gamma.csv', () => {}); return r; },
    }));
    expect(find(buildCatalog({}), 'routed').row.sections).toEqual([
      { key: 'alpha-beta', label: 'Alpha beta' },
      { key: 'gamma', label: 'Gamma' },
    ]);
  });

  it('storedGrants sections are included for their namespace', () => {
    registry.registerPlugin(manifest('barepack'));
    const cat = buildCatalog({ storedGrants: ['barepack:secret-area:view', 'barepack:*:view', 'ops:agent:manage', 'admin:newthing:view'] });
    expect(find(cat, 'barepack').row.sections).toEqual([{ key: 'secret-area', label: 'Secret area' }]);
    expect(cat.ops.sections).toEqual([{ key: 'agent', label: 'Agent' }]);
    expect(cat.admin.sections.map((s) => s.key)).toContain('newthing');
  });

  it('manifest.sections wins over a router walk; strings and objects accepted', () => {
    registry.registerPlugin(manifest('declared', {
      sections: ['zeta', { key: 'obj-one', label: 'Custom label' }, '*'],
      createRouter: () => { const r = express.Router(); r.get('/ignored', () => {}); return r; },
    }));
    expect(find(buildCatalog({}), 'declared').row.sections).toEqual([
      { key: 'obj-one', label: 'Custom label' },
      { key: 'zeta', label: 'Zeta' },
    ]);
  });

  it('adds a synthetic Cohesity row with the fixed section list when cohesity is built in', () => {
    if (registry.markBuiltin) registry.markBuiltin('cohesity'); // absent on icc-phase1, where cohesity is always built in
    const p = find(buildCatalog({}), 'cohesity');
    expect(p.category).toBe('backup');
    expect(p.row.sections.map((s) => s.key)).toEqual(COHESITY_SECTIONS.slice().sort());
  });

  it('COHESITY_SECTIONS lists every name app.js enforces', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const names = new Set(Array.from(src.matchAll(/cohesityPermission\('([a-z0-9-]+)'\)/g)).map((m) => m[1]));
    for (const m of src.matchAll(/name: '([a-z]+)', oldPath/g)) names.add(m[1]);
    names.add('poller');
    expect(names.size).toBeGreaterThan(10);
    for (const n of names) expect(COHESITY_SECTIONS, n).toContain(n);
  });

  it('humanizes labels, applies overrides, lists the fixed admin sections', () => {
    expect(catalogMod.humanize('ai-audit')).toBe('AI audit');
    expect(catalogMod.humanize('server360')).toBe('Server 360');
    expect(catalogMod.humanize('some_thing-else')).toBe('Some thing else');
    const cat = buildCatalog({});
    expect(cat.admin.sections.map((s) => s.key)).toEqual(['ai-audit', 'plugins', 'settings', 'users']);
    expect(cat.all.ns).toBe('*');
  });

  it('prefers the platformMeta label when the registry name is longer than 24 chars', () => {
    registry.registerPlugin(manifest('ariaops', { name: 'Aria Operations virtualization estate' }));
    expect(find(buildCatalog({}), 'ariaops').row.label).toBe('Aria Operations');
  });
});
