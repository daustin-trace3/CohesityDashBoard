// BlueCat Address Manager demo scope: one source (BAM-DEMO) with 2
// configurations, 3 views, ~14 zones (2 reverse + 1 ExternalHostsZone per
// view), ~180 mixed-type records (some FQDNs reuse vcenter demo VM names for
// Server 360 cross-hits), 6 nested blocks, ~40 IPv4 + 2 IPv6 networks with
// deliberate trouble (3 low-space, 1 full, 1 no-gateway, 2 non-.1 gateways,
// 1 gateway override with a note, 1 exclude_low_space override on a /30),
// DHCP ranges on ~15 networks (2 low, 1 full), 25 devices, 4 servers (1
// disconnected, 1 failed deploy), and 24 metrics rows. Addresses are written
// first; counts are then derived with the SAME math as bluecatIssues.js /
// bluecatPoller.js (contract section 5) so numbers agree.
//
// Cross-hit hostnames (contract section 10): vra-prod, vra-dr,
// vrops-nyc-01, vrli-nyc-01, vrlcm-nyc-01, vrni-nyc-01 match VM names in
// backend/demo/generators/vcenter.js (and the unifi wired-client names) so
// Server 360 correlates across platforms.
const { randInt, pick, chance, rngFor } = require('./core');

const SOURCE_NAME = 'BAM-DEMO';
const DOMAIN_ROOT = 'demo.local';

const CONFIGURATIONS = [
  { id: 1, name: 'Production' },
  { id: 2, name: 'Corporate' },
];

// ── Views + zones plan ──────────────────────────────────────────────────
// zoneType per contract section 2: Zone | ExternalHostsZone | EnumZone |
// InternalRootZone | RPZone. Reverse zones use zoneType 'Zone' with an
// in-addr.arpa absoluteName (BAM does not have a distinct reverse type).
const VIEWS = [
  {
    id: 1, configurationId: 1, name: 'Production',
    zones: [
      { id: 101, name: DOMAIN_ROOT, absoluteName: DOMAIN_ROOT, zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 102, name: 'test', absoluteName: `test.${DOMAIN_ROOT}`, zoneType: 'Zone', deploymentEnabled: 1, parentZoneId: 101 },
      { id: 103, name: 'icc.demo', absoluteName: 'icc.demo', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 104, name: '128.168.192.in-addr.arpa', absoluteName: '128.168.192.in-addr.arpa', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 105, name: 'ExternalHosts', absoluteName: 'externalhosts', zoneType: 'ExternalHostsZone', deploymentEnabled: 0 },
    ],
  },
  {
    id: 2, configurationId: 1, name: 'DR',
    zones: [
      { id: 201, name: `dr.${DOMAIN_ROOT}`, absoluteName: `dr.${DOMAIN_ROOT}`, zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 202, name: 'sub.icc.demo', absoluteName: 'sub.icc.demo', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 203, name: '20.168.192.in-addr.arpa', absoluteName: '20.168.192.in-addr.arpa', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 204, name: 'ExternalHosts', absoluteName: 'externalhosts', zoneType: 'ExternalHostsZone', deploymentEnabled: 0 },
    ],
  },
  {
    id: 3, configurationId: 2, name: 'Corp',
    zones: [
      { id: 301, name: 'corp.local', absoluteName: 'corp.local', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 302, name: 'mgmt.corp.local', absoluteName: 'mgmt.corp.local', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 303, name: 'lab.corp.local', absoluteName: 'lab.corp.local', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 304, name: 'vpn.corp.local', absoluteName: 'vpn.corp.local', zoneType: 'Zone', deploymentEnabled: 1 },
      { id: 305, name: 'ExternalHosts', absoluteName: 'externalhosts', zoneType: 'ExternalHostsZone', deploymentEnabled: 0 },
    ],
  },
];

// Hostnames reused from other demo generators (vcenter VMs, unifi clients)
// so a Server 360 lookup on these names cross-hits BlueCat too.
const CROSS_HIT_HOSTS = ['vra-prod', 'vra-dr', 'vrops-nyc-01', 'vrli-nyc-01', 'vrlcm-nyc-01', 'vrni-nyc-01'];

const RR_TYPES = ['A', 'CNAME', 'TXT', 'MX', 'SRV'];

function ipFromOffset(base, offset) {
  // base = [a,b,c,d] network address; offset is a small host offset.
  const n = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const v = (n + offset) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

function parseCidr(cidr) {
  const [ip, prefixStr] = cidr.split('/');
  const base = ip.split('.').map(Number);
  return { base, prefix: Number(prefixStr) };
}

function capacityFor(prefix) {
  if (prefix >= 31) return prefix === 31 ? 2 : 1;
  return 2 ** (32 - prefix) - 2;
}

// ── Blocks plan (6, nested one level) ───────────────────────────────────
const BLOCKS = [
  { id: 1, parentBlockId: null, configurationId: 1, name: 'RFC1918-10', range: '10.0.0.0/8', locationName: 'HQ Datacenter' },
  { id: 2, parentBlockId: 1, configurationId: 1, name: 'Production Nets', range: '10.20.0.0/16', locationName: 'HQ Datacenter' },
  { id: 3, parentBlockId: 1, configurationId: 1, name: 'DR Nets', range: '10.40.0.0/16', locationName: 'DR Site' },
  { id: 4, parentBlockId: null, configurationId: 1, name: 'RFC1918-172', range: '172.16.0.0/12', locationName: 'HQ Datacenter' },
  { id: 5, parentBlockId: 4, configurationId: 1, name: 'Lab Nets', range: '172.16.10.0/20', locationName: 'Lab' },
  { id: 6, parentBlockId: null, configurationId: 2, name: 'RFC1918-192', range: '192.168.0.0/16', locationName: 'Corp' },
];

// ── Network plan builder ────────────────────────────────────────────────
// Each entry: { blockId, configurationId, defaultViewId, cidr, locationName,
//   profile, hasRange }. profile drives address/gateway generation below.
function buildNetworkPlan() {
  const plan = [];
  let nid = 1000;

  const push = (blockId, configurationId, defaultViewId, cidr, locationName, profile, hasRange) => {
    plan.push({ id: nid++, blockId, configurationId, defaultViewId, cidr, locationName, profile, hasRange });
  };

  // Block 2 (10.20.x.0/24): 20 networks, production, most with DHCP ranges.
  for (let i = 0; i < 20; i++) {
    const cidr = `10.20.${i}.0/24`;
    let profile = 'normal';
    if (i === 0) profile = 'low1';
    else if (i === 1) profile = 'low2';
    else if (i === 2) profile = 'full';
    else if (i === 3) profile = 'no-gateway';
    else if (i === 4) profile = 'gateway-254';
    else if (i === 5) profile = 'gateway-129';
    else if (i === 6) profile = 'override-gateway';
    else if (i === 7) profile = 'range-low2';
    else if (i === 15) profile = 'low-pct';
    push(2, 1, 1, cidr, 'HQ Datacenter', profile, i < 12);
  }

  // Block 3 (10.40.x.0/24): 10 DR networks.
  for (let i = 0; i < 10; i++) {
    const cidr = `10.40.${i}.0/24`;
    let profile = 'normal';
    if (i === 0) profile = 'low3';
    else if (i === 1) profile = 'low4';
    push(3, 1, 2, cidr, 'DR Site', profile, i < 3);
  }

  // Block 5 (172.16.10.x/27): 5 small lab networks, one is the /30 override-exclude.
  for (let i = 0; i < 5; i++) {
    if (i === 4) {
      push(5, 1, 3, '172.16.10.240/30', 'Lab', 'override-exclude', false);
    } else {
      const cidr = `172.16.10.${i * 32}/27`;
      push(5, 1, 3, cidr, 'Lab', 'normal', false);
    }
  }

  // Block 6 (192.168.x.0/24): 5 corp networks.
  for (let i = 1; i <= 5; i++) {
    push(6, 2, 3, `192.168.${i}.0/24`, 'Corp', 'normal', false);
  }

  return plan;
}

const IPV6_NETWORKS = [
  { id: 2001, blockId: 6, configurationId: 2, defaultViewId: 3, cidr: '2001:db8:1::/64', name: 'Corp-v6-1', locationName: 'Corp' },
  { id: 2002, blockId: 6, configurationId: 2, defaultViewId: 3, cidr: '2001:db8:2::/64', name: 'Corp-v6-2', locationName: 'Corp' },
];

// ── Devices / servers plan ──────────────────────────────────────────────
const DEVICE_TYPES = [
  { type: 'Router', subtype: 'Core' }, { type: 'Switch', subtype: 'Access' },
  { type: 'Firewall', subtype: 'Perimeter' }, { type: 'Printer', subtype: 'Network' },
  { type: 'Wireless AP', subtype: 'Indoor' }, { type: 'Load Balancer', subtype: 'App' },
];

const SERVER_PLAN = [
  { id: 1, name: 'bam-dns-01', profile: 'BAM_DNS_DHCP_SERVER_20', connected: 1, lastDeployStatus: 'DONE' },
  { id: 2, name: 'bam-dns-02', profile: 'BAM_DNS_DHCP_SERVER_20', connected: 1, lastDeployStatus: 'DONE' },
  { id: 3, name: 'bam-dr-dns-01', profile: 'BAM_DNS_DHCP_SERVER_20', connected: 0, lastDeployStatus: 'DONE' },
  { id: 4, name: 'bam-lab-dns-01', profile: 'MICROSOFT_SERVER_50', connected: 1, lastDeployStatus: 'FAILED' },
];

function seedBluecat(db, { now, encrypt }) {
  const agoStmt = db.prepare("SELECT datetime('now', ?) d");
  const ago = (offset) => agoStmt.get(offset).d;
  const nowIso = new Date(now).toISOString();

  const setDemoSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  setDemoSetting.run('platform_bluecat_enabled');

  // ── Source ─────────────────────────────────────────────────────────
  const insertSource = db.prepare(`
    INSERT INTO bluecat_sources (name, host, port, encrypted_credentials, ssl_verify,
      polling_interval_minutes, enumerate_interval_minutes, bam_version, configurations_json,
      last_poll_status, last_poll_error, last_poll_at, last_enumerate_at, last_enumerate_error, created_at)
    VALUES (@name, @host, 443, @encrypted_credentials, 0, 30, 60, @bam_version, @configurations_json,
      'ok', NULL, @last_poll_at, @last_enumerate_at, NULL, @created_at)
  `);
  const srcInfo = insertSource.run({
    name: SOURCE_NAME, host: 'bam.demo.local',
    encrypted_credentials: encrypt(JSON.stringify({ username: 'demo-admin', password: 'demo-not-real' })),
    bam_version: '9.6.0-123.GA.bcn',
    configurations_json: JSON.stringify(CONFIGURATIONS),
    last_poll_at: ago('-6 minutes'),
    last_enumerate_at: ago('-18 minutes'),
    created_at: nowIso,
  });
  const sourceId = srcInfo.lastInsertRowid;

  // ── Views ──────────────────────────────────────────────────────────
  const insertView = db.prepare(`
    INSERT INTO bluecat_views (source_id, view_id, configuration_id, configuration_name, name, zone_count, record_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const viewRowId = {}; // view_id -> row id (unused but kept for clarity)
  const configName = (id) => (CONFIGURATIONS.find((c) => c.id === id) || {}).name || null;
  for (const v of VIEWS) {
    const info = insertView.run(sourceId, v.id, v.configurationId, configName(v.configurationId), v.name, v.zones.length, 0);
    viewRowId[v.id] = info.lastInsertRowid;
  }

  // ── Zones ──────────────────────────────────────────────────────────
  const insertZone = db.prepare(`
    INSERT INTO bluecat_zones (source_id, zone_id, view_id, parent_zone_id, name, absolute_name,
      zone_type, deployment_enabled, dynamic_update_enabled, signed, record_count, raw_json)
    VALUES (@source_id, @zone_id, @view_id, @parent_zone_id, @name, @absolute_name,
      @zone_type, @deployment_enabled, @dynamic_update_enabled, @signed, @record_count, @raw_json)
  `);
  const zonesByViewId = {}; // view_id -> [{id (zone_id), absoluteName, zoneType}]
  let zoneTotal = 0;
  for (const v of VIEWS) {
    zonesByViewId[v.id] = [];
    for (const z of v.zones) {
      const rng = rngFor(`bluecat-zone-${z.id}`);
      insertZone.run({
        source_id: sourceId, zone_id: z.id, view_id: v.id, parent_zone_id: z.parentZoneId || null,
        name: z.name, absolute_name: z.absoluteName, zone_type: z.zoneType,
        deployment_enabled: z.deploymentEnabled, dynamic_update_enabled: chance(rng, 0.6) ? 1 : 0,
        signed: chance(rng, 0.3) ? 1 : 0, record_count: 0,
        raw_json: JSON.stringify({ id: z.id, type: z.zoneType, name: z.name, absoluteName: z.absoluteName }),
      });
      zonesByViewId[v.id].push({ id: z.id, absoluteName: z.absoluteName, zoneType: z.zoneType });
      zoneTotal++;
    }
  }

  // ── Records (~180) ────────────────────────────────────────────────
  const insertRecord = db.prepare(`
    INSERT INTO bluecat_records (source_id, record_id, zone_id, view_id, name, absolute_name,
      record_type, rr_type, rdata, ttl, addresses_json, comment)
    VALUES (@source_id, @record_id, @zone_id, @view_id, @name, @absolute_name,
      @record_type, @rr_type, @rdata, @ttl, @addresses_json, @comment)
  `);
  const recordTypeForRr = { A: 'HostRecord', CNAME: 'AliasRecord', TXT: 'TXTRecord', MX: 'MXRecord', SRV: 'SRVRecord' };
  let recordId = 5000;
  let recordTotal = 0;
  const recordCountByZone = {};
  const recordCountByView = {};

  // Forward (non-reverse, non-external) zones eligible for host records.
  const forwardZones = [];
  for (const v of VIEWS) {
    for (const z of v.zones) {
      if (z.zoneType === 'Zone' && !z.absoluteName.endsWith('in-addr.arpa')) {
        forwardZones.push({ viewId: v.id, zoneId: z.id, absoluteName: z.absoluteName });
      }
    }
  }

  // Seed the 6 cross-hit hostnames as HostRecords in the first Production zone.
  const primaryZone = forwardZones[0];
  CROSS_HIT_HOSTS.forEach((host, i) => {
    const rng = rngFor(`bluecat-crosshit-${host}`);
    const addr = ipFromOffset([10, 20, 6, 0], 10 + i);
    const rid = recordId++;
    insertRecord.run({
      source_id: sourceId, record_id: rid, zone_id: primaryZone.zoneId, view_id: primaryZone.viewId,
      name: host, absolute_name: `${host}.${primaryZone.absoluteName}`, record_type: 'HostRecord',
      rr_type: 'A', rdata: addr, ttl: pick(rng, [null, 3600, 300]),
      addresses_json: JSON.stringify([{ address: addr, type: 'IPv4Address', state: 'STATIC' }]),
      comment: 'demo cross-platform host',
    });
    recordCountByZone[primaryZone.zoneId] = (recordCountByZone[primaryZone.zoneId] || 0) + 1;
    recordCountByView[primaryZone.viewId] = (recordCountByView[primaryZone.viewId] || 0) + 1;
    recordTotal++;
  });

  const HOST_PREFIXES = ['web', 'app', 'db', 'sql', 'file', 'nas', 'print', 'mail', 'vpn', 'mon', 'log', 'dc', 'dns', 'proxy', 'cache'];
  const TARGET_RECORDS = 180;
  while (recordTotal < TARGET_RECORDS) {
    const rng = rngFor(`bluecat-record-${recordId}`);
    const zoneRef = pick(rng, forwardZones);
    const rrType = pick(rng, RR_TYPES);
    const recordType = recordTypeForRr[rrType];
    const shortName = `${pick(rng, HOST_PREFIXES)}-${randInt(rng, 1, 99)}`;
    const absoluteName = `${shortName}.${zoneRef.absoluteName}`;
    let rdata; let addressesJson = null;
    if (rrType === 'A') {
      const addr = `10.20.${randInt(rng, 0, 19)}.${randInt(rng, 10, 250)}`;
      rdata = addr;
      addressesJson = JSON.stringify([{ address: addr, type: 'IPv4Address', state: 'STATIC' }]);
    } else if (rrType === 'CNAME') {
      rdata = `${pick(rng, CROSS_HIT_HOSTS)}.${primaryZone.absoluteName}`;
    } else if (rrType === 'TXT') {
      rdata = pick(rng, ['v=spf1 include:_spf.demo.local ~all', 'demo-verification=abc123', 'MS=ms12345678']);
    } else if (rrType === 'MX') {
      rdata = `mail.${zoneRef.absoluteName}`;
    } else {
      rdata = `_sip._tcp.${zoneRef.absoluteName}`;
    }
    const rid = recordId++;
    insertRecord.run({
      source_id: sourceId, record_id: rid, zone_id: zoneRef.zoneId, view_id: zoneRef.viewId,
      name: shortName, absolute_name: absoluteName, record_type: recordType, rr_type: rrType,
      rdata, ttl: chance(rng, 0.7) ? null : pick(rng, [300, 3600, 86400]),
      addresses_json: addressesJson, comment: chance(rng, 0.1) ? 'legacy - do not delete' : null,
    });
    recordCountByZone[zoneRef.zoneId] = (recordCountByZone[zoneRef.zoneId] || 0) + 1;
    recordCountByView[zoneRef.viewId] = (recordCountByView[zoneRef.viewId] || 0) + 1;
    recordTotal++;
  }

  // A couple of ExternalHostRecords in each ExternalHostsZone.
  for (const v of VIEWS) {
    const ext = v.zones.find((z) => z.zoneType === 'ExternalHostsZone');
    if (!ext) continue;
    for (let i = 0; i < 2; i++) {
      const rng = rngFor(`bluecat-ext-${v.id}-${i}`);
      const shortName = `ext-${pick(rng, ['partner', 'saas', 'vendor'])}-${i + 1}`;
      const rid = recordId++;
      insertRecord.run({
        source_id: sourceId, record_id: rid, zone_id: ext.id, view_id: v.id,
        name: shortName, absolute_name: `${shortName}.externalhosts`, record_type: 'ExternalHostRecord',
        rr_type: 'A', rdata: `203.0.113.${randInt(rng, 10, 250)}`, ttl: null, addresses_json: null,
        comment: null,
      });
      recordCountByZone[ext.id] = (recordCountByZone[ext.id] || 0) + 1;
      recordCountByView[v.id] = (recordCountByView[v.id] || 0) + 1;
      recordTotal++;
    }
  }

  // Update zone.record_count and view.record_count/zone_count.
  const updateZoneCount = db.prepare('UPDATE bluecat_zones SET record_count = ? WHERE source_id = ? AND zone_id = ?');
  for (const [zoneId, count] of Object.entries(recordCountByZone)) {
    updateZoneCount.run(count, sourceId, Number(zoneId));
  }
  const updateViewCount = db.prepare('UPDATE bluecat_views SET record_count = ? WHERE source_id = ? AND view_id = ?');
  for (const v of VIEWS) {
    updateViewCount.run(recordCountByView[v.id] || 0, sourceId, v.id);
  }

  // ── Blocks ─────────────────────────────────────────────────────────
  const insertBlock = db.prepare(`
    INSERT INTO bluecat_blocks (source_id, block_id, parent_block_id, configuration_id, name, range,
      prefix, ip_version, location_name, usage_json)
    VALUES (@source_id, @block_id, @parent_block_id, @configuration_id, @name, @range,
      @prefix, @ip_version, @location_name, @usage_json)
  `);
  for (const b of BLOCKS) {
    const { prefix } = parseCidr(b.range);
    insertBlock.run({
      source_id: sourceId, block_id: b.id, parent_block_id: b.parentBlockId, configuration_id: b.configurationId,
      name: b.name, range: b.range, prefix, ip_version: 4, location_name: b.locationName, usage_json: null,
    });
  }

  // ── Networks + ranges + addresses (free-space math per contract sec.5) ─
  const insertNetwork = db.prepare(`
    INSERT INTO bluecat_networks (source_id, network_id, block_id, configuration_id, name, range, prefix,
      ip_version, capacity, gateway, gateway_source, default_view_id, location_name, ping_before_assign,
      low_water_mark, high_water_mark, used_static, dhcp_pool, dhcp_used, free_static, free_pct,
      counts_source, enumerated_at, usage_json, raw_json)
    VALUES (@source_id, @network_id, @block_id, @configuration_id, @name, @range, @prefix,
      @ip_version, @capacity, @gateway, @gateway_source, @default_view_id, @location_name, @ping_before_assign,
      @low_water_mark, @high_water_mark, @used_static, @dhcp_pool, @dhcp_used, @free_static, @free_pct,
      @counts_source, @enumerated_at, @usage_json, @raw_json)
  `);
  const insertRange = db.prepare(`
    INSERT INTO bluecat_ranges (source_id, range_id, network_id, name, range_type, start_ip, end_ip, size,
      dhcp_used, free_dhcp, raw_json)
    VALUES (@source_id, @range_id, @network_id, @name, @range_type, @start_ip, @end_ip, @size,
      @dhcp_used, @free_dhcp, @raw_json)
  `);
  const insertAddress = db.prepare(`
    INSERT INTO bluecat_addresses (source_id, address_id, network_id, address, state, name, mac, in_range_id, device_id)
    VALUES (@source_id, @address_id, @network_id, @address, @state, @name, @mac, @in_range_id, @device_id)
  `);
  const insertOverride = db.prepare(`
    INSERT INTO bluecat_network_overrides (source_id, network_id, range, gateway, exclude_low_space, note, updated_by, updated_at)
    VALUES (@source_id, @network_id, @range, @gateway, @exclude_low_space, @note, @updated_by, @updated_at)
  `);

  const networkPlan = buildNetworkPlan();
  let addressId = 20000;
  let rangeId = 8000;
  let addressTotal = 0;
  let rangeTotal = 0;
  let networkTotal = 0;
  let networksLowSpace = 0;
  let rangesLowSpace = 0;

  for (const net of networkPlan) {
    const rng = rngFor(`bluecat-network-${net.id}`);
    const { base, prefix } = parseCidr(net.cidr);
    const capacity = capacityFor(prefix);

    // Gateway resolution (bam field only here; override applied after).
    // Placed at a fixed high offset so it never falls inside the DHCP range
    // (which always starts at offset 1 and stays small).
    let gateway = null;
    let gatewaySource = null;
    let gatewayOffset = null;
    if (net.profile === 'gateway-254') { gatewayOffset = 254; gatewaySource = 'bam'; }
    else if (net.profile === 'gateway-129') { gatewayOffset = 129; gatewaySource = 'bam'; }
    else if (net.profile === 'no-gateway' || net.profile === 'override-gateway') { gatewayOffset = null; }
    else if (prefix <= 30) { gatewayOffset = capacity; gatewaySource = 'bam'; }
    if (gatewayOffset != null) gateway = ipFromOffset(base, gatewayOffset);

    // Decide DHCP pool size for this network (if it gets a range).
    let dhcpPoolTarget = 0;
    let rangeSize = 0;
    if (net.hasRange) {
      rangeSize = net.profile === 'low1' ? 20 : net.profile === 'full' ? 10 : randInt(rng, 30, 60);
      dhcpPoolTarget = rangeSize;
    }

    const gatewayBit = gatewaySource === 'bam' ? 1 : 0;

    // Decide plain used_static target (addresses outside the range and
    // excluding the gateway address, which is counted separately below).
    let plainStaticTarget;
    if (net.profile === 'low2' || net.profile === 'low3' || net.profile === 'low4') {
      plainStaticTarget = capacity - dhcpPoolTarget - gatewayBit - randInt(rng, 5, 15);
    } else if (net.profile === 'full') {
      plainStaticTarget = capacity - dhcpPoolTarget - gatewayBit; // free_static lands on 0
    } else if (net.profile === 'low-pct') {
      plainStaticTarget = capacity - dhcpPoolTarget - gatewayBit - 25; // free_pct < 10%, free_static >= 20
    } else {
      plainStaticTarget = randInt(rng, Math.min(20, capacity - 5), Math.max(20, Math.floor((capacity - dhcpPoolTarget) * 0.6)));
    }
    plainStaticTarget = Math.max(0, Math.min(plainStaticTarget, capacity - dhcpPoolTarget - gatewayBit));

    // Write plain used_static addresses: offsets after the range, up to
    // capacity, skipping the gateway's offset.
    let plainWritten = 0;
    for (let off = rangeSize + 1; off <= capacity && plainWritten < plainStaticTarget; off++) {
      if (off === gatewayOffset) continue;
      const addr = ipFromOffset(base, off);
      const state = pick(rng, ['STATIC', 'STATIC', 'RESERVED']);
      insertAddress.run({
        source_id: sourceId, address_id: addressId++, network_id: net.id, address: addr, state,
        name: chance(rng, 0.4) ? `host-${net.id}-${off}` : null, mac: null, in_range_id: null, device_id: null,
      });
      addressTotal++;
      plainWritten++;
    }

    if (gateway && gatewaySource === 'bam') {
      // Write the gateway as its own address row (GATEWAY state, not in a range).
      insertAddress.run({
        source_id: sourceId, address_id: addressId++, network_id: net.id, address: gateway, state: 'GATEWAY',
        name: 'gateway', mac: null, in_range_id: null, device_id: null,
      });
      addressTotal++;
    }

    // Range + its addresses.
    let dhcpPool = 0;
    let dhcpUsed = 0;
    let rowRangeId = null;
    if (net.hasRange) {
      rowRangeId = rangeId++;
      const startIp = ipFromOffset(base, 1);
      const endIp = ipFromOffset(base, rangeSize);
      let excluded = 0;
      let usedInRange;
      if (net.profile === 'full') usedInRange = rangeSize; // free_dhcp = 0
      else if (net.profile === 'low1' || net.profile === 'range-low2') usedInRange = rangeSize - randInt(rng, 5, 15);
      else usedInRange = randInt(rng, Math.floor(rangeSize * 0.3), Math.floor(rangeSize * 0.7));
      usedInRange = Math.max(0, Math.min(usedInRange, rangeSize));
      if (net.profile !== 'full' && net.profile !== 'low1' && net.profile !== 'range-low2' && chance(rng, 0.3)) {
        excluded = randInt(rng, 1, 3);
        usedInRange = Math.max(0, usedInRange - excluded);
      }
      let written = 0;
      for (let off = 1; off <= rangeSize && written < usedInRange; off++, written++) {
        const addr = ipFromOffset(base, off);
        insertAddress.run({
          source_id: sourceId, address_id: addressId++, network_id: net.id, address: addr,
          state: 'DHCP_ALLOCATED', name: null, mac: null, in_range_id: rowRangeId, device_id: null,
        });
        addressTotal++;
      }
      for (let off = rangeSize; off > rangeSize - excluded && off >= 1; off--) {
        const addr = ipFromOffset(base, off);
        insertAddress.run({
          source_id: sourceId, address_id: addressId++, network_id: net.id, address: addr,
          state: 'DHCP_EXCLUDED', name: null, mac: null, in_range_id: rowRangeId, device_id: null,
        });
        addressTotal++;
      }
      dhcpPool = rangeSize;
      dhcpUsed = usedInRange;
      const freeDhcp = rangeSize - excluded - usedInRange;
      if (freeDhcp < 20) rangesLowSpace++;
      insertRange.run({
        source_id: sourceId, range_id: rowRangeId, network_id: net.id, name: `${net.name || net.cidr} DHCP`,
        range_type: 'DHCPv4Range', start_ip: startIp, end_ip: endIp, size: rangeSize,
        dhcp_used: dhcpUsed, free_dhcp: freeDhcp, raw_json: JSON.stringify({ range: `${startIp}-${endIp}` }),
      });
      rangeTotal++;
    }

    // used_static per contract section 5: addresses NOT inside any range
    // with a static-ish state (here: the plain writes plus the gateway).
    const usedStatic = plainWritten + gatewayBit;
    const freeStatic = Math.max(0, capacity - dhcpPool - usedStatic);
    const freePct = capacity ? Math.round((freeStatic / capacity) * 10000) / 100 : null;
    if (freeStatic > 0 && freeStatic < 20) networksLowSpace++;

    insertNetwork.run({
      source_id: sourceId, network_id: net.id, block_id: net.blockId, configuration_id: net.configurationId,
      name: `Net-${net.id}`, range: net.cidr, prefix, ip_version: 4, capacity,
      gateway, gateway_source: gatewaySource, default_view_id: net.defaultViewId, location_name: net.locationName,
      ping_before_assign: chance(rng, 0.5) ? 1 : 0,
      low_water_mark: 10, high_water_mark: 90,
      used_static: usedStatic, dhcp_pool: dhcpPool, dhcp_used: dhcpUsed,
      free_static: freeStatic, free_pct: freePct, counts_source: 'enumerated',
      enumerated_at: ago(`-${randInt(rng, 5, 90)} minutes`), usage_json: null,
      raw_json: JSON.stringify({ id: net.id, range: net.cidr }),
    });
    networkTotal++;

    // Overrides.
    if (net.profile === 'override-gateway') {
      const overrideGw = ipFromOffset(base, 254);
      insertOverride.run({
        source_id: sourceId, network_id: net.id, range: net.cidr, gateway: overrideGw,
        exclude_low_space: 0, note: 'Manually set - BAM has no gateway defined for this segment',
        updated_by: 'demo', updated_at: ago('-2 days'),
      });
      db.prepare('UPDATE bluecat_networks SET gateway = ?, gateway_source = ? WHERE source_id = ? AND network_id = ?')
        .run(overrideGw, 'override', sourceId, net.id);
    }
    if (net.profile === 'override-exclude') {
      insertOverride.run({
        source_id: sourceId, network_id: net.id, range: net.cidr, gateway: null,
        exclude_low_space: 1, note: 'Point-to-point /30 - low space is expected, exclude from alerts',
        updated_by: 'demo', updated_at: ago('-5 days'),
      });
    }
  }

  // IPv6 networks: no capacity/counts/ranges (contract: v6 skipped by issue rules).
  for (const net of IPV6_NETWORKS) {
    const { prefix } = { prefix: 64 };
    insertNetwork.run({
      source_id: sourceId, network_id: net.id, block_id: net.blockId, configuration_id: net.configurationId,
      name: net.name, range: net.cidr, prefix, ip_version: 6, capacity: null,
      gateway: null, gateway_source: null, default_view_id: net.defaultViewId, location_name: net.locationName,
      ping_before_assign: 0, low_water_mark: null, high_water_mark: null,
      used_static: null, dhcp_pool: null, dhcp_used: null, free_static: null, free_pct: null,
      counts_source: null, enumerated_at: null, usage_json: null,
      raw_json: JSON.stringify({ id: net.id, range: net.cidr }),
    });
    networkTotal++;
  }

  // ── Devices (25) ───────────────────────────────────────────────────
  const insertDevice = db.prepare(`
    INSERT INTO bluecat_devices (source_id, device_id, configuration_id, name, device_type, device_subtype,
      description, addresses_json, raw_json)
    VALUES (@source_id, @device_id, @configuration_id, @name, @device_type, @device_subtype,
      @description, @addresses_json, @raw_json)
  `);
  let deviceTotal = 0;
  for (let i = 1; i <= 25; i++) {
    const rng = rngFor(`bluecat-device-${i}`);
    const dt = pick(rng, DEVICE_TYPES);
    const addr = `192.168.${randInt(rng, 1, 5)}.${randInt(rng, 10, 250)}`;
    insertDevice.run({
      source_id: sourceId, device_id: 9000 + i, configuration_id: pick(rng, [1, 2]),
      name: `${dt.type.toLowerCase().replace(/\s+/g, '-')}-${String(i).padStart(2, '0')}`,
      device_type: dt.type, device_subtype: dt.subtype,
      description: chance(rng, 0.3) ? `Demo ${dt.type}` : null,
      addresses_json: JSON.stringify([{ address: addr, state: 'STATIC' }]),
      raw_json: JSON.stringify({ id: 9000 + i, name: `device-${i}` }),
    });
    deviceTotal++;
  }

  // ── Servers (4) ────────────────────────────────────────────────────
  const insertServer = db.prepare(`
    INSERT INTO bluecat_servers (source_id, server_id, configuration_id, name, address, profile, version,
      connected, state, interfaces_json, roles_json, last_deploy_status, last_deploy_at, raw_json)
    VALUES (@source_id, @server_id, @configuration_id, @name, @address, @profile, @version,
      @connected, @state, @interfaces_json, @roles_json, @last_deploy_status, @last_deploy_at, @raw_json)
  `);
  let serverTotal = 0;
  let serversDown = 0;
  for (const s of SERVER_PLAN) {
    const rng = rngFor(`bluecat-server-${s.id}`);
    const addr = `10.20.${randInt(rng, 0, 9)}.${randInt(rng, 5, 20)}`;
    if (s.connected === 0) serversDown++;
    insertServer.run({
      source_id: sourceId, server_id: 7000 + s.id, configuration_id: 1, name: s.name, address: addr,
      profile: s.profile, version: '9.6.0-123.GA.bcn', connected: s.connected,
      state: s.connected ? 'RUNNING' : 'UNREACHABLE',
      interfaces_json: JSON.stringify([{ type: 'PRIMARY', managementAddress: addr, address: addr }]),
      roles_json: JSON.stringify([{ roleType: 'MASTER', type: 'DNSDeploymentRole', target: s.name }]),
      last_deploy_status: s.lastDeployStatus, last_deploy_at: ago(`-${randInt(rng, 1, 5)} hours`),
      raw_json: JSON.stringify({ id: 7000 + s.id, name: s.name }),
    });
    serverTotal++;
  }

  // ── Metrics history (24 hourly rows) ────────────────────────────────
  const insertMetric = db.prepare(`
    INSERT INTO bluecat_metrics_history (source_id, captured_at, views, zones, records, networks,
      networks_low_space, ranges_low_space, devices, servers, servers_down)
    VALUES (@source_id, @captured_at, @views, @zones, @records, @networks,
      @networks_low_space, @ranges_low_space, @devices, @servers, @servers_down)
  `);
  for (let h = 23; h >= 0; h--) {
    const rng = rngFor(`bluecat-metric-${h}`);
    insertMetric.run({
      source_id: sourceId, captured_at: ago(`-${h} hours`),
      views: VIEWS.length, zones: zoneTotal, records: recordTotal, networks: networkTotal,
      networks_low_space: Math.max(0, networksLowSpace + randInt(rng, -1, 1)),
      ranges_low_space: Math.max(0, rangesLowSpace + randInt(rng, -1, 1)),
      devices: deviceTotal, servers: serverTotal, servers_down: serversDown,
    });
  }

  // ── Issue history: computeIssues() + reconcileIssueHistory() from
  //    services/bluecatIssues.js (WP1). Fall back to representative rows if
  //    that module is not present yet (WPs build in parallel). ───────────
  // Deviation flag (WP5): contract section 10 fixes last_poll_status='ok' on
  // the sole demo source, but the source-unreachable rule (section 6) can
  // only fire when last_poll_status='error'. A single-source demo with
  // status 'ok' can therefore never produce that rule via computeIssues().
  // Since the task requires every rule to have >=1 open row, source-unreachable
  // (and any other rule computeIssues() happens not to produce, e.g. if the
  // low-pct network's numbers round differently than intended) is topped up
  // with a manually-inserted representative row below, regardless of whether
  // the real bluecatIssues.js ran or the fallback list was used.
  let issueRules = [];
  let issueFallback = false;
  try {
    // eslint-disable-next-line global-require
    const bluecatIssues = require('../../services/bluecatIssues');
    bluecatIssues.reconcileIssueHistory();
    issueRules = db.prepare("SELECT DISTINCT type FROM bluecat_issue_history WHERE status = 'open'").all().map((r) => r.type);
  } catch (err) {
    issueFallback = true;
  }

  const REQUIRED_RULES = {
    'source-unreachable': ['critical', SOURCE_NAME, 'bam.demo.local', 'BlueCat source BAM-DEMO is unreachable: connection timed out'],
    'server-disconnected': ['critical', SOURCE_NAME, 'bam-dr-dns-01', 'Server bam-dr-dns-01 is disconnected'],
    'server-deploy-failed': ['warning', SOURCE_NAME, 'bam-lab-dns-01', 'Server bam-lab-dns-01 last deploy FAILED'],
    'network-full': ['critical', SOURCE_NAME, '10.20.2.0/24', 'Network 10.20.2.0/24 is full (0 free)'],
    'network-low-space': ['warning', SOURCE_NAME, '10.20.1.0/24', 'Network 10.20.1.0/24 is low on free addresses'],
    'network-low-pct': ['warning', SOURCE_NAME, '10.20.15.0/24', 'Network 10.20.15.0/24 is below the low-space percentage threshold'],
    'dhcp-range-full': ['critical', SOURCE_NAME, '10.20.2.1-10.20.2.10 in 10.20.2.0/24', 'DHCP range full'],
    'dhcp-range-low-space': ['warning', SOURCE_NAME, '10.20.0.1-10.20.0.20 in 10.20.0.0/24', 'DHCP range low on free addresses'],
    'gateway-unknown': ['info', SOURCE_NAME, '10.20.3.0/24', 'Network 10.20.3.0/24 has no known gateway'],
  };
  const insertIssue = db.prepare(`
    INSERT INTO bluecat_issue_history (issue_key, source, severity, type, target, message, status, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
  `);
  for (const [type, [severity, source, target, message]] of Object.entries(REQUIRED_RULES)) {
    if (issueRules.includes(type)) continue;
    insertIssue.run(`${type}|${source}|${target}`, source, severity, type, target, message);
    issueRules.push(type);
  }

  return {
    sources: 1,
    views: VIEWS.length,
    zones: zoneTotal,
    records: recordTotal,
    blocks: BLOCKS.length,
    networks: networkTotal,
    ranges: rangeTotal,
    addresses: addressTotal,
    devices: deviceTotal,
    servers: serverTotal,
    metrics: 24,
    issueRules: [...new Set(issueRules)],
    issueFallback,
  };
}

module.exports = { seedBluecat };
