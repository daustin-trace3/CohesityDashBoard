// vCenter guest OS classification and rollups. Pure functions, no db access.
//
// Inputs per VM (any may be null): guest_os (config.guestFullName, the
// CONFIGURED guest, major release only), guest_id (config.guestId enum),
// guest_os_running (guest.guestFullName as Tools reports it), guest_family
// (guest.guestFamily) and guest_detailed (guest.guestDetailedData, Tools 11+,
// one string of key='value' pairs). The shapes come from VMware docs, not a
// live vCenter, so every parser tolerates missing keys and odd quoting and
// never throws.
//
// Precedence: guest_detailed > guest_os_running > guest_id > guest_os. A
// generic answer (Other Linux, Other) never beats a specific one from a lower
// source.

const VENDOR = {
  'Windows Server': 'Microsoft', Windows: 'Microsoft', RHEL: 'Red Hat', SLES: 'SUSE',
  Ubuntu: 'Canonical', CentOS: 'CentOS', 'Oracle Linux': 'Oracle', Debian: 'Debian',
  'Photon OS': 'VMware', 'Rocky Linux': 'Rocky', AlmaLinux: 'AlmaLinux', FreeBSD: 'FreeBSD',
  macOS: 'Apple', 'Other Linux': 'Other', Other: 'Other',
};
const FAMILY = {
  'Windows Server': 'windows', Windows: 'windows', RHEL: 'linux', SLES: 'linux', Ubuntu: 'linux',
  CentOS: 'linux', 'Oracle Linux': 'linux', Debian: 'linux', 'Photon OS': 'linux',
  'Rocky Linux': 'linux', AlmaLinux: 'linux', 'Other Linux': 'linux',
  FreeBSD: 'other', macOS: 'other', Other: 'other',
};

// Version number that is not part of "4/5/6" lists or "64-bit".
const NUM = '(?:(\\d+(?:\\.\\d+)*)(?![\\d/]|-bit))';

// Text rules, first match wins. Used for configured names, Tools-reported
// names, detailed prettyName and distroName. `ver` picks the version capture.
const TEXT_RULES = [
  { re: /windows\s+server\s*(?:version\s*)?(?:(\d{4})\s*(r2)?)?/i, product: 'Windows Server',
    ver: (m) => (m[1] ? (m[2] ? `${m[1]} R2` : m[1]) : null) },
  { re: /windows\s*(?:nt\s*)?(11|10|8\.1|8|7|xp|vista|2000|95|98)\b/i, product: 'Windows',
    ver: (m) => m[1] },
  { re: /windows/i, product: 'Windows', ver: () => null },
  { re: new RegExp(`red\\s*hat\\s+enterprise\\s+linux(?:\\s+(?:server|workstation))?\\s*(?:release\\s*)?${NUM}?`, 'i'),
    product: 'RHEL', ver: (m) => m[1] },
  { re: new RegExp(`\\brhel\\b\\s*${NUM}?`, 'i'), product: 'RHEL', ver: (m) => m[1] },
  { re: new RegExp(`(?:suse\\s+linux\\s+enterprise(?:\\s+server|\\s+desktop)?|\\bsles\\b)\\s*${NUM}?`, 'i'),
    product: 'SLES', ver: (m) => m[1] },
  { re: new RegExp(`centos(?:\\s+linux|\\s+stream)?\\s*${NUM}?`, 'i'), product: 'CentOS', ver: (m) => m[1] },
  { re: new RegExp(`oracle\\s+linux(?:\\s+server)?\\s*${NUM}?`, 'i'), product: 'Oracle Linux', ver: (m) => m[1] },
  { re: /ubuntu(?:\s+linux)?\s*(?:(\d{1,2}\.\d{2}(?:\.\d+)?)(?![\d/]))?/i, product: 'Ubuntu', ver: (m) => m[1] || null },
  { re: new RegExp(`debian(?:\\s+gnu\\/linux)?\\s*${NUM}?`, 'i'), product: 'Debian', ver: (m) => m[1] },
  { re: new RegExp(`photon(?:\\s+os)?\\s*${NUM}?`, 'i'), product: 'Photon OS', ver: (m) => m[1] },
  { re: new RegExp(`rocky(?:\\s+linux)?\\s*${NUM}?`, 'i'), product: 'Rocky Linux', ver: (m) => m[1] },
  { re: new RegExp(`alma\\s*linux\\s*${NUM}?`, 'i'), product: 'AlmaLinux', ver: (m) => m[1] },
  { re: new RegExp(`freebsd\\s*${NUM}?`, 'i'), product: 'FreeBSD', ver: (m) => m[1] },
  { re: /mac\s*os|\bdarwin\b|\bos\s*x\b/i, product: 'macOS', ver: () => null },
  { re: /linux/i, product: 'Other Linux', ver: () => null },
  { re: /^\s*other\b/i, product: 'Other', ver: () => null },
];

// config.guestId table. Each entry returns { product, version } or null.
// windows2019srvNext = Server 2022, windows2022srvNext = Server 2025.
const WIN_NEXT = { 2019: '2022', 2022: '2025' };
const GUEST_ID_RULES = [
  { re: /^windows(\d{4})srv(Next)?_?64Guest$/i,
    to: (m) => ({ product: 'Windows Server', version: m[2] ? (WIN_NEXT[m[1]] || null) : m[1] }) },
  { re: /^windows7Server64Guest$/i, to: () => ({ product: 'Windows Server', version: '2008 R2' }) },
  { re: /^windows8Server64Guest$/i, to: () => ({ product: 'Windows Server', version: '2012' }) },
  { re: /^windows9Server64Guest$/i, to: () => ({ product: 'Windows Server', version: '2016' }) },
  { re: /^windows(?:Hyperv|Server)\w*Guest$/i, to: () => ({ product: 'Windows Server', version: null }) },
  { re: /^windows11_64Guest$/i, to: () => ({ product: 'Windows', version: '11' }) },
  { re: /^windows(?:9|10)(?:_64)?Guest$/i, to: () => ({ product: 'Windows', version: '10' }) },
  { re: /^windows8(?:_64)?Guest$/i, to: () => ({ product: 'Windows', version: '8' }) },
  { re: /^windows7(?:_64)?Guest$/i, to: () => ({ product: 'Windows', version: '7' }) },
  { re: /^rhel(\d+)_(?:64)?Guest$/i, to: (m) => ({ product: 'RHEL', version: m[1] }) },
  { re: /^sles(\d+)?_?(?:64)?Guest$/i, to: (m) => ({ product: 'SLES', version: m[1] || null }) },
  { re: /^centos(\d+)?_?(?:64)?Guest$/i, to: (m) => ({ product: 'CentOS', version: m[1] || null }) },
  { re: /^oracleLinux(\d+)?_?(?:64)?Guest$/i, to: (m) => ({ product: 'Oracle Linux', version: m[1] || null }) },
  { re: /^ubuntu(?:64)?Guest$/i, to: () => ({ product: 'Ubuntu', version: null }) },
  { re: /^debian(\d+)_(?:64)?Guest$/i, to: (m) => ({ product: 'Debian', version: m[1] }) },
  { re: /^vmwarePhoton(?:64)?Guest$/i, to: () => ({ product: 'Photon OS', version: null }) },
  { re: /^rockylinux_?(?:64)?Guest$/i, to: () => ({ product: 'Rocky Linux', version: null }) },
  { re: /^almalinux_?(?:64)?Guest$/i, to: () => ({ product: 'AlmaLinux', version: null }) },
  { re: /^freebsd(\d+)?_?(?:64)?Guest$/i, to: (m) => ({ product: 'FreeBSD', version: m[1] || null }) },
  { re: /^darwin/i, to: () => ({ product: 'macOS', version: null }) },
  { re: /^(?:otherLinux|other\dxLinux)(?:64)?Guest$/i, to: () => ({ product: 'Other Linux', version: null }) },
  { re: /^other(?:\d+)?(?:64)?Guest$/i, to: () => ({ product: 'Other', version: null }) },
];

const FAMILY_BY_GUEST_FAMILY = {
  windowsguest: 'windows', linuxguest: 'linux',
};

const EDITION_RE = /\b(Datacenter|Standard|Enterprise|Essentials|Professional|Pro|Home|Education|Web)\b/i;

const s = (v) => (v == null ? '' : String(v)).trim();

/** key='value' pairs from guest.guestDetailedData. Never throws. */
function parseDetailed(str) {
  const out = {};
  if (typeof str !== 'string' || !str) return out;
  const re = /([A-Za-z]+)=(?:'([^']*)'|"([^"]*)")/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (!(m[1] in out)) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function majorOf(product, version) {
  if (!version) return null;
  if (product === 'Ubuntu') {
    const m = /^(\d+\.\d+)/.exec(version);
    return m ? m[1] : null;
  }
  if (product === 'Windows Server' || product === 'Windows') return version;
  const m = /^\d+/.exec(version);
  return m ? m[0] : null;
}

function bitsOf(text) {
  const t = s(text);
  if (/\b64-?\s?bit|\(64-bit\)/i.test(t)) return '64';
  if (/\b32-?\s?bit|\(32-bit\)/i.test(t)) return '32';
  return null;
}

/** Classify one free-text OS name. Returns a partial result or null. */
function classifyText(text) {
  const t = s(text).replace(/\bor\s+later\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const rule of TEXT_RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    const version = rule.ver(m);
    return {
      product: rule.product, version, major: majorOf(rule.product, version),
      bits: bitsOf(text), edition: null, build: null,
    };
  }
  return null;
}

function classifyGuestId(id) {
  const t = s(id);
  if (!t) return null;
  for (const rule of GUEST_ID_RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    const { product, version } = rule.to(m);
    return {
      product, version, major: majorOf(product, version),
      bits: /64Guest$/i.test(t) ? '64' : (/Guest$/i.test(t) ? '32' : null),
      edition: null, build: null,
    };
  }
  return null;
}

function classifyDetailed(str) {
  const d = parseDetailed(str);
  if (!Object.keys(d).length) return null;
  const pretty = s(d.prettyName);
  let r = null;
  if (/windows/i.test(s(d.familyName)) || /windows/i.test(pretty)) {
    r = classifyText(pretty || 'Windows');
    if (r) {
      const ed = EDITION_RE.exec(pretty);
      if (ed) r.edition = ed[1][0].toUpperCase() + ed[1].slice(1).toLowerCase();
      if (d.buildNumber) r.build = s(d.buildNumber);
      else { const b = /build\s+(\d+)/i.exec(pretty); if (b) r.build = b[1]; }
    }
  } else {
    if (d.distroName) r = classifyText(`${d.distroName} ${s(d.distroVersion)}`);
    if (!r || r.product === 'Other Linux') r = classifyText(pretty) || r;
    if (r && d.distroVersion && r.product !== 'Other Linux' && r.product !== 'Other') {
      const v = s(d.distroVersion);
      if (/^\d/.test(v)) { r.version = v; r.major = majorOf(r.product, v); }
    }
    if (!r && /linux/i.test(s(d.familyName))) r = classifyText('Other Linux');
  }
  if (r) {
    const b = s(d.bitness);
    if (b === '64' || b === '32') r.bits = b;
    else if (!r.bits) r.bits = bitsOf(pretty);
  }
  return r;
}

const isGeneric = (r) => !r || r.product === 'Other Linux' || r.product === 'Other';

/**
 * Classify one VM row. Never throws; garbage in gives the Unknown result.
 * @returns {{family, vendor, product, major, version, label, versionLabel,
 *   edition, build, bits, source}}
 */
function classifyGuestOs(row) {
  const r = row || {};
  let candidates = [];
  try {
    candidates = [
      ['tools-detailed', () => classifyDetailed(r.guest_detailed)],
      ['tools', () => classifyText(r.guest_os_running)],
      ['configured', () => classifyGuestId(r.guest_id)],
      ['configured', () => classifyText(r.guest_os)],
    ].map(([source, fn]) => {
      let res = null;
      try { res = fn(); } catch { res = null; }
      return res ? { source, res } : null;
    }).filter(Boolean);
  } catch { candidates = []; }

  let pick = candidates.find((c) => !isGeneric(c.res)) || candidates[0] || null;
  let family = null;
  if (!pick) {
    // Tools family alone is better than nothing.
    family = FAMILY_BY_GUEST_FAMILY[s(r.guest_family).toLowerCase()] || null;
    if (family) {
      const product = family === 'windows' ? 'Windows' : 'Other Linux';
      pick = { source: 'tools', res: { product, version: null, major: null, bits: null, edition: null, build: null } };
    }
  }
  if (!pick) {
    return {
      family: 'unknown', vendor: null, product: null, major: null, version: null,
      label: 'Unknown', versionLabel: 'Unknown', edition: null, build: null, bits: null, source: 'none',
    };
  }
  const { product, major, version, edition, build } = pick.res;
  // Fill in detail the winning source lacked from lower sources of the same product.
  let bits = pick.res.bits;
  if (!bits) {
    const same = candidates.find((c) => c.res.bits && c.res.product === product);
    bits = same ? same.res.bits : null;
  }
  const ver = version || major || null;
  const label = major ? `${product} ${major}` : product;
  // Windows carries its version in the release name; the Tools detail adds the
  // edition and build ("Windows Server 2019 Standard (build 17763)").
  const isWindows = product === 'Windows Server' || product === 'Windows';
  const versionLabel = isWindows
    ? `${label}${edition ? ` ${edition}` : ''}${build ? ` (build ${build})` : ''}`
    : (ver ? `${product} ${ver}` : label);
  return {
    family: FAMILY[product] || 'other', vendor: VENDOR[product] || null, product,
    major: major || null, version: ver, label, versionLabel,
    edition: edition || null, build: build || null, bits: bits || null, source: pick.source,
  };
}

const isOn = (v) => String(v.power_state || '').toUpperCase() === 'POWERED_ON';
const isOff = (v) => String(v.power_state || '').toUpperCase() === 'POWERED_OFF';
const TOOLS_OUTDATED = new Set([
  'guestToolsNeedUpgrade', 'guestToolsTooOld', 'guestToolsBlacklisted', 'guestToolsSupportedOld',
]);
const FAMILY_ORDER = { windows: 0, linux: 1, other: 2, unknown: 3 };

function byVcenterOf(list, nameById) {
  const m = new Map();
  for (const v of list) m.set(v.vcenter_id, (m.get(v.vcenter_id) || 0) + 1);
  return [...m.entries()]
    .map(([id, vms]) => ({ id, name: nameById.get(id) || v0name(list, id), vms }))
    .sort((a, b) => b.vms - a.vms || String(a.name).localeCompare(String(b.name)));
}
function v0name(list, id) {
  const hit = list.find((v) => v.vcenter_id === id);
  return hit ? hit.vcenter_name : null;
}

/**
 * Rollups over classified VM rows. Each row needs: vcenter_id, vcenter_name,
 * power_state, tools_version_status and the classifyGuestOs fields (family,
 * product, major, version, label, versionLabel, source).
 */
function rollupGuestOs(rows, vcenters) {
  const vms = Array.isArray(rows) ? rows : [];
  const nameById = new Map((vcenters || []).map((v) => [v.id, v.name]));

  const summary = {
    vms: vms.length, poweredOn: 0, poweredOff: 0, windows: 0, linux: 0, other: 0, unknown: 0,
    detailed: 0, toolsReported: 0, configuredOnly: 0, toolsOutdated: 0,
  };
  for (const v of vms) {
    if (isOn(v)) summary.poweredOn++;
    if (isOff(v)) summary.poweredOff++;
    if (v.family === 'windows') summary.windows++;
    else if (v.family === 'linux') summary.linux++;
    else if (v.family === 'unknown') summary.unknown++;
    else summary.other++;
    if (v.source === 'tools-detailed') summary.detailed++;
    else if (v.source === 'tools') summary.toolsReported++;
    else summary.configuredOnly++;
    if (TOOLS_OUTDATED.has(v.tools_version_status)) summary.toolsOutdated++;
  }

  const group = (keyFn) => {
    const m = new Map();
    for (const v of vms) {
      const k = keyFn(v);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(v);
    }
    return m;
  };

  const releases = [...group((v) => v.label).entries()].map(([label, list]) => {
    const first = list[0];
    const vmap = new Map();
    for (const v of list) {
      const k = v.version || 'unknown';
      vmap.set(k, (vmap.get(k) || 0) + 1);
    }
    return {
      label, family: first.family, product: first.product, major: first.major,
      vms: list.length, poweredOn: list.filter(isOn).length,
      byVcenter: byVcenterOf(list, nameById),
      versions: [...vmap.entries()].map(([version, n]) => ({ version, vms: n }))
        .sort((a, b) => b.vms - a.vms || String(a.version).localeCompare(String(b.version))),
    };
  }).sort((a, b) => b.vms - a.vms || a.label.localeCompare(b.label));

  const versions = [...group((v) => v.versionLabel).entries()].map(([versionLabel, list]) => {
    const first = list[0];
    return {
      versionLabel, label: first.label, family: first.family, product: first.product,
      version: first.version, vms: list.length, poweredOn: list.filter(isOn).length,
      byVcenter: byVcenterOf(list, nameById),
      source: {
        detailed: list.filter((v) => v.source === 'tools-detailed').length,
        tools: list.filter((v) => v.source === 'tools').length,
        configured: list.filter((v) => v.source !== 'tools-detailed' && v.source !== 'tools').length,
      },
    };
  }).sort((a, b) => b.vms - a.vms || a.versionLabel.localeCompare(b.versionLabel));

  const families = [...group((v) => v.family).entries()].map(([family, list]) => ({
    family, vms: list.length, poweredOn: list.filter(isOn).length,
  })).sort((a, b) => (FAMILY_ORDER[a.family] ?? 9) - (FAMILY_ORDER[b.family] ?? 9));

  return { summary, releases, versions, families };
}

module.exports = { parseDetailed, classifyGuestOs, rollupGuestOs };
