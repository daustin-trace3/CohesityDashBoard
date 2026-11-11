// Permission catalog for the grants editor (Users & Access > Groups, Users).
// Describes every namespace a grant can name, grouped by platform category,
// with the sections each platform exposes. Built from the registry (manifest
// category and sections, the express router of compiled-in platforms) plus a
// host fallback map, and from the grants already stored so an existing grant
// always renders even when no route reveals its section.
const registry = require('../core/registry');
const { BUILTIN_PLATFORMS } = require('./platformList');

const CATEGORY_LABELS = [
  ['backup', 'Backup'],
  ['storage', 'Storage and SAN'],
  ['virtualization', 'Virtualization and cloud'],
  ['network', 'Network'],
  ['dr', 'DR and replication'],
  ['other', 'Other platforms'],
];

// Host fallback when a manifest names no category (built-ins are not edited).
const CATEGORY_FALLBACK = {
  cohesity: 'backup', netbackup: 'backup', eon: 'backup', rubrik: 'backup',
  pure: 'storage', netapp: 'storage', brocade: 'storage', dell: 'storage',
  vcenter: 'virtualization', hyperv: 'virtualization', nutanix: 'virtualization',
  proxmox: 'virtualization', aria: 'virtualization', ariaops: 'virtualization', aws: 'virtualization',
  logicmonitor: 'network', unifi: 'network', bluecat: 'network', f5: 'network', cisco: 'network',
  zerto: 'dr',
};

// The names app.js passes to cohesityPermission, plus the poller trigger
// (cohesity:poller:manage). tests/permissionCatalog.test.js keeps this list
// equal to the names app.js really enforces.
const COHESITY_SECTIONS = [
  'advisor', 'alerts', 'analytics', 'clusters', 'dashboard', 'gflags', 'governance',
  'hardware', 'helios', 'import', 'insights', 'licensing', 'metrics', 'poller',
  'replication', 'views', 'workloads',
];

// Sections enforced as admin:<x>:... in app.js and backend/routes.
const ADMIN_SECTIONS = ['ai-audit', 'plugins', 'settings', 'users'];

const LABEL_OVERRIDES = {
  'ai-audit': 'AI audit',
  gflags: 'GFlags',
  'object-360': 'Object 360',
  'backup-history': 'Backup history',
  server360: 'Server 360',
  finops: 'FinOps',
  pure1: 'Pure1',
};

const SEGMENT = /^[a-z0-9_.-]+$/;
const MAX_LABEL = 24;

function humanize(key) {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  const words = String(key).replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(key);
}

function stripExt(seg) {
  const m = /^(.+)\.[a-z0-9]+$/i.exec(seg);
  return m ? m[1] : seg;
}

function cleanSegment(seg) {
  if (typeof seg !== 'string' || !seg || seg.startsWith(':') || seg.includes('*')) return null;
  const s = stripExt(seg);
  return SEGMENT.test(s) ? s : null;
}

function firstSegment(p) {
  if (typeof p !== 'string') return null;
  return cleanSegment(p.split('/').filter(Boolean)[0]);
}

const LITERAL_PREFIX = /^\^\\\/([a-z0-9_.-]+)/;

/** First path segments an express Router answers. Nested routers contribute
 *  their literal mount segment; a nested router mounted at the root is
 *  walked one level further. Anything else (bare functions, packs) yields []. */
function walkRouter(router, depth = 0) {
  const out = new Set();
  const stack = router && Array.isArray(router.stack) ? router.stack : null;
  if (!stack) return [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        const seg = firstSegment(p);
        if (seg) out.add(seg);
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      const src = layer.regexp && layer.regexp.source ? layer.regexp.source : '';
      const m = LITERAL_PREFIX.exec(src);
      if (m) {
        const seg = cleanSegment(m[1]);
        if (seg) out.add(seg);
      } else if (depth < 1) {
        for (const seg of walkRouter(layer.handle, depth + 1)) out.add(seg);
      }
    }
  }
  return Array.from(out);
}

function builtinLabel(id) {
  const row = BUILTIN_PLATFORMS.find((p) => p.id === id);
  return row ? row.label : null;
}

function pickLabel(id, name) {
  const fromList = builtinLabel(id);
  if (fromList && String(name || '').length > MAX_LABEL) return fromList;
  return name || fromList || id;
}

function normalizeManifestSections(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (typeof item === 'string') out.push({ key: item, label: null });
    else if (item && typeof item.key === 'string') out.push({ key: item.key, label: item.label || null });
  }
  return out;
}

function categoryOf(id, manifest, byId) {
  const keys = CATEGORY_LABELS.map((c) => c[0]);
  if (manifest && keys.includes(manifest.category)) return manifest.category;
  if (CATEGORY_FALLBACK[id]) return CATEGORY_FALLBACK[id];
  if (manifest && manifest.derivedFrom) {
    const connector = byId.get(manifest.derivedFrom);
    const connectorManifest = connector ? connector.manifest : null;
    if (connectorManifest && keys.includes(connectorManifest.category)) return connectorManifest.category;
    if (CATEGORY_FALLBACK[manifest.derivedFrom]) return CATEGORY_FALLBACK[manifest.derivedFrom];
  }
  return 'other';
}

let memo = { key: null, platforms: null };

function derivePlatforms() {
  const entries = registry.listEntries();
  const pub = new Map(registry.listPlugins().map((p) => [p.id, p]));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const cohesitySynthetic = !byId.has('cohesity') && registry.isBuiltinPresent('cohesity');
  const key = entries
    .map((e) => {
      const p = pub.get(e.id) || {};
      const stackLen = e.router && Array.isArray(e.router.stack) ? e.router.stack.length : 'x';
      return `${e.id}@${(e.manifest && e.manifest.version) || ''}:${e.status}:${p.enabled ? 1 : 0}:${stackLen}`;
    })
    .sort()
    .join('|') + (cohesitySynthetic ? '|+cohesity' : '');
  if (memo.key === key) return memo.platforms;

  const rows = [];
  for (const e of entries) {
    const p = pub.get(e.id) || {};
    const manifest = e.manifest || {};
    let sections = normalizeManifestSections(manifest.sections);
    if (!sections.length) {
      if (e.id === 'cohesity') sections = COHESITY_SECTIONS.map((k) => ({ key: k, label: null }));
      else sections = walkRouter(e.router).map((k) => ({ key: k, label: null }));
    }
    rows.push({
      id: e.id,
      label: pickLabel(e.id, manifest.name),
      color: manifest.color || null,
      derived: !!manifest.derivedFrom,
      derivedFrom: manifest.derivedFrom || null,
      enabled: p.enabled !== undefined ? !!p.enabled : true,
      category: categoryOf(e.id, manifest, byId),
      sections,
    });
  }
  if (cohesitySynthetic) {
    rows.push({
      id: 'cohesity', label: builtinLabel('cohesity') || 'Cohesity', color: null,
      derived: false, derivedFrom: null, enabled: true, category: categoryOf('cohesity', null, byId),
      sections: COHESITY_SECTIONS.map((k) => ({ key: k, label: null })),
    });
  }
  memo = { key, platforms: rows };
  return rows;
}

function storedSections(storedGrants) {
  const map = new Map(); // ns -> Set(section)
  for (const g of storedGrants || []) {
    if (typeof g !== 'string') continue;
    const parts = g.split(':');
    if (parts.length !== 3) continue;
    const [ns, section] = parts;
    if (section === '*' || !section) continue;
    if (!map.has(ns)) map.set(ns, new Set());
    map.get(ns).add(section);
  }
  return map;
}

function finishSections(base, extraKeys) {
  const seen = new Map();
  for (const s of base) {
    const key = stripExt(s.key);
    if (key === '*' || !key || seen.has(key)) continue;
    seen.set(key, s.label || humanize(key));
  }
  for (const k of extraKeys || []) {
    if (k === '*' || !k || seen.has(k)) continue;
    seen.set(k, humanize(k));
  }
  return Array.from(seen.entries())
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/** @param {{ storedGrants?: string[] }} [opts] */
function buildCatalog(opts = {}) {
  const stored = storedSections(opts.storedGrants);
  const platforms = derivePlatforms();
  const byCategory = new Map(CATEGORY_LABELS.map(([k]) => [k, []]));
  for (const p of platforms) {
    byCategory.get(p.category).push({
      id: p.id,
      label: p.label,
      color: p.color,
      derived: p.derived,
      derivedFrom: p.derivedFrom,
      enabled: p.enabled,
      sections: finishSections(p.sections, stored.get(p.id)),
    });
  }
  const categories = [];
  for (const [key, label] of CATEGORY_LABELS) {
    const list = byCategory.get(key);
    if (!list.length && key === 'other') continue;
    list.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    categories.push({ key, label, platforms: list });
  }
  return {
    categories,
    ops: {
      ns: 'ops',
      label: 'Ops',
      hint: 'Ops Agent, Estate Advisor and Service Status analyses. Rollup pages need only a platform grant.',
      sections: finishSections([], stored.get('ops')),
    },
    admin: {
      ns: 'admin',
      label: 'Administration',
      hint: 'settings, users, plugins, licensing, AI audit',
      sections: finishSections(ADMIN_SECTIONS.map((k) => ({ key: k, label: null })), stored.get('admin')),
    },
    all: {
      ns: '*',
      label: 'All platforms',
      hint: 'every platform and Ops, now and in future. Administration is separate.',
    },
  };
}

function _resetMemo() { memo = { key: null, platforms: null }; }

module.exports = {
  buildCatalog, CATEGORY_FALLBACK, COHESITY_SECTIONS, ADMIN_SECTIONS, walkRouter, humanize, _resetMemo,
};
