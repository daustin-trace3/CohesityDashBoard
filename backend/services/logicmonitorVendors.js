// LogicMonitor vendor keys (derived platforms, round 1). ICC's own classification of a device into
// a vendor_key (f5, cisco, paloalto, ...) and a vendor_kind (bigip, gtm, f5os, firewall, ...),
// stored on lm_devices by migration v14. A derived platform (F5 today, Cisco later) keys on
// vendor_key, never on the LM group tree and never on template DataSources (Cisco_CUCM_Processes
// sits on 169 devices of five vendors on CG). This module also holds the ownership rule: which
// platform a device scoped alert or issue belongs to (a present derived platform, else LogicMonitor).
// This module must not require logicmonitorApi at load time (Api requires this file); the legacy
// category and sysinfo tables are read lazily inside classifyVendorKey.
const { memoByDbState } = require('../core/dbMemo');

const VENDOR_KEYS = ['f5', 'cisco', 'paloalto', 'meraki', 'zscaler', 'oracle', 'netscout', 'brocade',
  'juniper', 'arista', 'fortinet', 'aruba', 'ubiquiti', 'microsoft', 'netsnmp'];

const VENDOR_LABELS = {
  f5: 'F5', cisco: 'Cisco', paloalto: 'Palo Alto Networks', meraki: 'Cisco Meraki', zscaler: 'Zscaler', oracle: 'Oracle',
  netscout: 'NetScout', brocade: 'Brocade', juniper: 'Juniper', arista: 'Arista', fortinet: 'Fortinet', aruba: 'Aruba',
  ubiquiti: 'Ubiquiti', microsoft: 'Microsoft', netsnmp: 'Net-SNMP host',
};

// IANA enterprise number (the integer after 1.3.6.1.4.1.) to vendor key.
const ENTERPRISE = {
  9: 'cisco', 2636: 'juniper', 30065: 'arista', 25461: 'paloalto', 12356: 'fortinet', 14823: 'aruba', 47196: 'aruba',
  29671: 'meraki', 41112: 'ubiquiti', 1588: 'brocade', 3375: 'f5', 12276: 'f5', 9148: 'oracle', 8072: 'netsnmp', 311: 'microsoft',
};

// The legacy vendor strings of logicmonitorApi mapped to keys.
const STRING_TO_KEY = {
  Cisco: 'cisco', Juniper: 'juniper', Arista: 'arista', 'Palo Alto': 'paloalto', Fortinet: 'fortinet', Aruba: 'aruba',
  'Aruba CX': 'aruba', Meraki: 'meraki', Ubiquiti: 'ubiquiti', Brocade: 'brocade', F5: 'f5', 'Net-SNMP': 'netsnmp',
  Microsoft: 'microsoft', NetScout: 'netscout', Zscaler: 'zscaler', Oracle: 'oracle',
};

// Text hints over categories + sysinfo + model + name, first hit wins (reason hint:<word>). The NetScout
// pattern also knows the PFOS and Infinistream model text (CG census, 8 devices); the Zscaler pattern also
// knows the NSS host naming (zsclr). UNVERIFIED against more than the CG export.
const VENDOR_HINTS = [
  [/netscout|infinistream|ngenius|\bPFOS\b|\bPFS[\s-]?\d/i, 'netscout', 'netscout'],
  [/zscaler|zsclr/i, 'zscaler', 'zscaler'],
  [/acme.?packet|ntm_sbc|oracle.{0,20}(sbc|session border)/i, 'oracle', 'oracle'],
];

// DataSource name hints for devices the sysoid and text rules left unclassified. Deliberately NOT:
// Cisco_CUCM_Processes, Cisco_IPSLA*, CiscoSLA_*, HostStatus, Ping, SNMP_*, BGP-, OSPF_* (template-applied).
const DS_VENDOR_HINTS = [
  [/^(F5_|f5_|F5OS)/, 'f5', 'F5_'],
  [/^PaloAlto_/, 'paloalto', 'PaloAlto_'],
  [/^ntm_zpa_|^Zscaler/i, 'zscaler', 'zpa'],
  [/^ntm_sbc_/, 'oracle', 'ntm_sbc_'],
  [/^ntm_meraki_/, 'meraki', 'ntm_meraki_'],
  [/^(Cisco_ISE_|ntm_ise_|ntm_cisco_ise_|Cisco_Wireless_|ntm_wlc_|CiscoASA|Cisco_ASA_|ntm_asa_|Cisco_Nexus_|Cisco_SIP_)/, 'cisco', 'Cisco_'],
];

const labelOf = (key) => VENDOR_LABELS[key] || key;

/** The integer after 1.3.6.1.4.1. in a sysoid, or null. */
function enterpriseOf(sysoid) {
  if (sysoid == null) return null;
  const m = /(?:^|\.)1\.3\.6\.1\.4\.1\.(\d+)/.exec(String(sysoid));
  return m ? Number(m[1]) : null;
}

/** F5OS (rSeries, VELOS) by enterprise 12276 or banner text; role load-balancer, kind f5os. */
function isF5os({ sysoid, sysinfo, model } = {}) {
  if (enterpriseOf(sysoid) === 12276) return true;
  return /f5-?os|rseries|velos/i.test(`${sysinfo || ''} ${model || ''}`);
}

const splitCats = (categories) => {
  if (Array.isArray(categories)) return categories.map(String).map((c) => c.trim()).filter(Boolean);
  return String(categories || '').split(',').map((c) => c.trim()).filter(Boolean);
};

function hintHit(text) {
  for (const [re, key, word] of VENDOR_HINTS) if (re.test(text)) return { key, reason: `hint:${word}` };
  return null;
}

/** Legacy category and sysinfo tables of logicmonitorApi (rule 3), mapped to keys. Skips netsnmp tokens. */
function legacyHit(categories, sysinfo) {
  let api;
  try { api = require('./logicmonitorApi'); } catch { return null; }
  const cats = splitCats(categories);
  const keyOf = (vendor) => STRING_TO_KEY[vendor] || null;
  for (const [token, vendor] of api.CATEGORY_VENDORS || []) {
    if (cats.includes(token) && keyOf(vendor) && keyOf(vendor) !== 'netsnmp') return { key: keyOf(vendor), reason: `category:${token}` };
  }
  for (const [token, vendor] of api.CATEGORY_VENDORS || []) {
    const lt = token.toLowerCase();
    if (cats.some((c) => c.toLowerCase().startsWith(lt)) && keyOf(vendor) && keyOf(vendor) !== 'netsnmp') return { key: keyOf(vendor), reason: `category:${token}` };
  }
  const first = String(sysinfo || '').trim().split(/[\s,]+/)[0];
  if (first) {
    const lower = first.toLowerCase();
    const v = (api.SYSINFO_VENDORS || {})[lower];
    if (v && keyOf(v) && keyOf(v) !== 'netsnmp') return { key: keyOf(v), reason: `sysinfo:${lower}` };
  }
  return null;
}

/**
 * First hit wins: (0) NetScout text, (1) sysoid enterprise number, (2) the text hints, (3) the legacy
 * category and sysinfo tables, (4) null. Net-SNMP (8072) is weak: rules 2 and 3 override it. An enterprise
 * number nobody mapped leaves the key null and the reason 'sysoid-unknown:<n>' for Governance.
 */
function classifyVendorKey({ sysoid, categories, sysinfo, model, name } = {}) {
  const text = `${splitCats(categories).join(' ')} ${sysinfo || ''} ${model || ''} ${name || ''}`;
  // A NetScout probe can carry a Cisco category or sysoid; its model text is the stronger evidence.
  if (VENDOR_HINTS[0][0].test(text)) return { key: 'netscout', reason: 'hint:netscout' };
  const ent = enterpriseOf(sysoid);
  const byOid = ent != null ? ENTERPRISE[ent] : null;
  if (byOid && byOid !== 'netsnmp') return { key: byOid, reason: `sysoid:${ent}` };
  const hint = hintHit(text);
  if (hint) return hint;
  const legacy = legacyHit(categories, sysinfo);
  if (legacy) return legacy;
  if (byOid === 'netsnmp') return { key: 'netsnmp', reason: `sysoid:${ent}` };
  if (ent != null && !byOid) return { key: null, reason: `sysoid-unknown:${ent}` };
  return { key: null, reason: null };
}

/** DataSource names to { key, reason } only when every hinted name agrees on one vendor. */
function vendorKeyFromDatasources(names) {
  const keys = new Set();
  let first = null;
  for (const n of names || []) {
    const name = String(n || '');
    for (const [re, key, label] of DS_VENDOR_HINTS) {
      if (re.test(name)) {
        keys.add(key);
        if (!first) first = label;
        break;
      }
    }
  }
  if (keys.size !== 1) return { key: null, reason: null };
  return { key: [...keys][0], reason: `datasource:${first}` };
}

const hasDs = (names, re) => (names || []).some((n) => re.test(String(n)));
const SWITCH_MODEL = /^(N[0-9]K|C9[0-9]{3}|WS-C|C3[0-9]{3}|C2960|C1000|CBS|IE-)/i;

/** vendor_kind for a keyed device. datasources (names) is optional; the DataSource rules re-run in the post-store pass. */
function classifyVendorKind({ key, role, categories, model, sysinfo, sysoid, name, datasources } = {}) {
  const cats = splitCats(categories);
  const mdl = String(model || '');
  const info = String(sysinfo || '');
  switch (key) {
    case 'f5':
      if (isF5os({ sysoid, sysinfo, model })) return 'f5os';
      // A combined LTM+GTM box (CG's "gltm" pairs) stays bigip; only a DNS-only
      // appliance with GTM DataSources and no local pools is kind gtm.
      if (hasDs(datasources, /^F5_GTM_/i) && !hasDs(datasources, /^F5_BigIP_(PoolMemberStats|SSL_VIP_Certs)/i)) return 'gtm';
      return 'bigip';
    case 'cisco': {
      const nexus = /^N[0-9]K-/i.test(mdl) || /NX-OS/i.test(info);
      // ISE nodes carry role firewall on CG, so the product kinds are tested before the role.
      if (/^SNS-/i.test(mdl) || hasDs(datasources, /^(Cisco_ISE_|ntm_ise_|ntm_cisco_ise_)/)) return 'ise';
      if (cats.some((c) => /^CiscoESA/i.test(c)) || /ironport|esa/i.test(mdl)) return 'esa';
      if (cats.some((c) => /^CiscoUCS/i.test(c))) return 'ucs';
      if (role === 'wireless') return 'wireless';
      if (role === 'firewall' || cats.some((c) => /^(CiscoASA|Cisco_FTD)$/i.test(c))) return 'firewall';
      if (hasDs(datasources, /^Cisco_SIP_/) && !nexus && !SWITCH_MODEL.test(mdl)) return 'voice';
      if (role === 'router') return 'router';
      if (nexus) return 'nexus';
      return 'switch';
    }
    case 'paloalto':
      return /^M-[0-9]+/i.test(mdl) || /panorama/i.test(info) ? 'panorama' : 'firewall';
    case 'meraki':
      if (/^MX/i.test(mdl)) return 'mx';
      if (/^MS/i.test(mdl)) return 'ms';
      if (/^(MR|CW)/i.test(mdl)) return 'mr';
      return 'other';
    case 'zscaler':
      return hasDs(datasources, /^ntm_zpa_|^Zscaler ZPA/i) || /zpa/i.test(String(name || '')) ? 'zpa' : 'nss';
    case 'oracle':
      return 'sbc';
    case 'netscout':
      return /infinistream|ngenius/i.test(`${mdl} ${info}`) ? 'infinistream' : 'pfs';
    default:
      return null;
  }
}

// ---- Ownership ------------------------------------------------------------

// Device scoped issue types: a DEVICE (not a link, circuit, site, check or collector) is at fault, so the
// vendor platform that owns the device owns the item. Stays with LogicMonitor: interface-*, port-*, circuit-*,
// site-*, link-*, location-latency, link-burst, latency-*, loss-*, check-*, collector-*, source-*,
// unmonitored-neighbor, cloud-circuit-*, interface-flapping, circuit-flap-pattern.
const DEVICE_SCOPED_ISSUE_TYPES = new Set([
  'device-dead', 'device-cpu-high', 'device-memory-high', 'hardware-fault', 'device-ping-loss', 'ntp-unsynced',
  'stack-member-degraded', 'device-rebooted', 'filesystem-inaccessible', 'optic-power-low', 'bgp-peer-down',
  'ospf-neighbor-down', 'raw-threshold',
  'lb-cert-expiring', 'lb-daemon-down', 'lb-failover-degraded', 'lb-pool-degraded',
  'fw-config-unsynced', 'fw-ha-degraded', 'fw-session-high', 'fw-tunnel-down',
  'wlan-ap-availability-low', 'wlan-ap-down', 'wlan-ap-uplink-errors', 'wlan-channel-util-high', 'wlan-client-capacity-high',
  'wlan-ha-degraded', 'wlan-mobility-down', 'wlan-radio-down', 'wlan-radius-unresponsive',
  'ise-cert-expiring', 'ise-node-down', 'zpa-connector-down', 'zpa-port-exhaustion', 'asa-license-unauthorized',
  'voice-sbc-degraded', 'voice-sip-errors', 'app-capacity-high', 'app-queue-high', 'app-service-down',
  'server-filesystem-full', 'server-nfs-mount-down', 'server-service-stopped',
  'cohesity-capacity-high', 'cohesity-hardware-fault', 'cohesity-node-down', 'cohesity-service-down',
]);
const DEVICE_SCOPED_PREFIX = /^(lb|fw|wlan|ise|zpa|asa|voice|app|server|cohesity)-/;

function isDeviceScopedIssueType(type) {
  const t = String(type || '');
  return DEVICE_SCOPED_ISSUE_TYPES.has(t) || DEVICE_SCOPED_PREFIX.test(t);
}

const registryOf = (opts) => {
  if (opts && opts.registry) return opts.registry;
  try { return require('../core/registry'); } catch { return null; }
};
const derivedFor = (reg, key) => (reg && typeof reg.derivedPlatformFor === 'function' ? reg.derivedPlatformFor(key) : null);

function buildOwnerIndex(db, reg) {
  const idx = { empty: true, byDevice: new Map(), byDeviceAny: new Map(), byName: new Map(), anyName: new Map() };
  let keys;
  try { keys = db.prepare('SELECT DISTINCT vendor_key FROM lm_devices WHERE stale = 0 AND vendor_key IS NOT NULL').all().map((r) => r.vendor_key); } catch { return idx; }
  const platformOf = new Map();
  for (const k of keys) {
    let p = null;
    try { p = derivedFor(reg, k); } catch { p = null; }
    if (p) platformOf.set(k, p);
  }
  if (!platformOf.size) return idx;
  idx.empty = false;
  const ph = [...platformOf.keys()].map(() => '?').join(',');
  const rows = db.prepare(`SELECT source_id, lm_device_id, name, display_name, vendor_key FROM lm_devices WHERE stale = 0 AND vendor_key IN (${ph})`).all(...platformOf.keys());
  for (const r of rows) {
    const p = platformOf.get(r.vendor_key);
    idx.byDevice.set(`${r.source_id}:${r.lm_device_id}`, p);
    if (!idx.byDeviceAny.has(r.lm_device_id)) idx.byDeviceAny.set(r.lm_device_id, p);
    for (const n of [r.display_name, r.name]) {
      if (!n) continue;
      const low = String(n).toLowerCase();
      if (!idx.byName.has(`${r.source_id}|${low}`)) idx.byName.set(`${r.source_id}|${low}`, p);
      if (!idx.anyName.has(low)) idx.anyName.set(low, p);
    }
  }
  return idx;
}

/** Issue target to a device name: exact name, else the longest prefix followed by space, colon or slash. */
function resolveTarget(idx, sourceId, target) {
  const low = String(target || '').trim().toLowerCase();
  if (!low) return null;
  const look = (s) => (sourceId != null ? idx.byName.get(`${sourceId}|${s}`) : idx.anyName.get(s)) || null;
  const whole = look(low);
  if (whole) return whole;
  for (let i = low.length - 1; i > 0; i -= 1) {
    if (low[i] !== ' ' && low[i] !== ':' && low[i] !== '/') continue;
    const hit = look(low.slice(0, i));
    if (hit) return hit;
  }
  return null;
}

/**
 * A resolver fn({ lmDeviceId, sourceId, issueType, target }) -> 'logicmonitor' | '<derived id>'. The device to
 * owner map is memoized per db state (opts.registry skips the memo: tests pass a fake).
 */
function ownerResolver(db, opts = {}) {
  const reg = registryOf(opts);
  const idx = opts.registry ? buildOwnerIndex(db, reg) : memoByDbState(db, 'lmOwnerIndex', () => buildOwnerIndex(db, reg));
  return ({ lmDeviceId, sourceId, issueType, target } = {}) => {
    if (idx.empty) return 'logicmonitor';
    if (issueType && !isDeviceScopedIssueType(issueType)) return 'logicmonitor';
    let owner = null;
    if (lmDeviceId != null && lmDeviceId !== '') {
      owner = sourceId != null ? idx.byDevice.get(`${sourceId}:${lmDeviceId}`) : idx.byDeviceAny.get(Number(lmDeviceId));
    } else if (target) {
      owner = resolveTarget(idx, sourceId == null ? null : sourceId, target);
    }
    return owner || 'logicmonitor';
  };
}

function ownerPlatformFor(db, args, opts = {}) {
  return ownerResolver(db, opts)(args || {});
}

// ---- Post-store pass ---------------------------------------------------------

const DS_KINDS = new Set(['gtm', 'ise', 'voice', 'zpa']);

/**
 * After the DataSource rows of a tick are stored: for devices with no vendor_key (or only the weak
 * netsnmp key) try the DataSource hints; for every keyed device re-run the kind rules that read
 * DataSource names. Computes first, then writes only the rows that changed in one short transaction.
 * Returns { checked, changed }.
 */
function applyDatasourceVendors(db, sourceId) {
  const devices = db.prepare(`
    SELECT lm_device_id, name, display_name, role, ert, categories, model, sysinfo, sysoid, vendor_key, vendor_kind, vendor_reason
    FROM lm_devices WHERE source_id = ? AND stale = 0
  `).all(sourceId);
  const byDev = new Map();
  for (const r of db.prepare('SELECT lm_device_id, datasource_name FROM lm_device_datasources WHERE source_id = ?').all(sourceId)) {
    let a = byDev.get(r.lm_device_id);
    if (!a) { a = []; byDev.set(r.lm_device_id, a); }
    a.push(r.datasource_name);
  }
  const updates = [];
  for (const d of devices) {
    const names = byDev.get(d.lm_device_id) || [];
    let key = d.vendor_key;
    let reason = d.vendor_reason;
    if (!key || key === 'netsnmp') {
      const hit = vendorKeyFromDatasources(names);
      if (hit.key && hit.key !== key) { key = hit.key; reason = hit.reason; }
    }
    if (!key) continue;
    const kind = classifyVendorKind({ key, role: d.role, categories: d.categories, model: d.model, sysinfo: d.sysinfo, sysoid: d.sysoid, name: d.display_name || d.name, datasources: names });
    if (key !== d.vendor_key || kind !== d.vendor_kind || reason !== d.vendor_reason) updates.push({ id: d.lm_device_id, key, kind, reason });
  }
  if (updates.length) {
    const stmt = db.prepare('UPDATE lm_devices SET vendor_key = ?, vendor_kind = ?, vendor_reason = ? WHERE source_id = ? AND lm_device_id = ?');
    db.transaction(() => { for (const u of updates) stmt.run(u.key, u.kind, u.reason, sourceId, u.id); })();
  }
  return { checked: devices.length, changed: updates.length };
}

module.exports = {
  VENDOR_KEYS, VENDOR_LABELS, ENTERPRISE, VENDOR_HINTS, DS_VENDOR_HINTS, DEVICE_SCOPED_ISSUE_TYPES, DS_KINDS,
  labelOf, enterpriseOf, isF5os, classifyVendorKey, classifyVendorKind, vendorKeyFromDatasources,
  isDeviceScopedIssueType, buildOwnerIndex, resolveTarget, ownerResolver, ownerPlatformFor, applyDatasourceVendors,
};
