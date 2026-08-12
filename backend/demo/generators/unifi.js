// UniFi scope demo data: 2 controllers ("AustinHome" UDM Pro Max, "Lakehouse"
// UDM SE) with gateways/switches/APs/ports/clients/wlans/networks/rogue APs/
// events/WAN/topology/metrics history, and deliberate trouble exercising
// EVERY rule in services/unifiIssues.js: an offline switch, a PoE fault, a
// port with climbing rx_errors in the trailing 24h, a flapping port, a
// gateway at 93% cpu, an overheating switch, WAN latency/availability
// breaches on Lakehouse, a rogue (evil-twin) AP, IPS disabled on Lakehouse,
// 4 low-satisfaction wireless clients, and an upgradable AP. Wired client
// names vra-prod/vra-dr/vrops-nyc-01/vrli-nyc-01 mirror the vcenter demo VMs
// for cross-platform Server 360 hits.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

const GIB = 1024 ** 3;

function randMac(rng) {
  const byte = () => Math.floor(rng() * 256).toString(16).padStart(2, '0');
  return `${byte()}:${byte()}:${byte()}:${byte()}:${byte()}:${byte()}`;
}

const OUIS = ['Apple, Inc.', 'Ubiquiti Networks Inc.', 'Dell Inc.', 'Google, Inc.', 'Samsung Electronics', 'Intel Corporate', 'Amazon Technologies Inc.'];

const SOURCES = [
  {
    name: 'AustinHome', host: '192.168.128.1', controllerVersion: '9.1.120',
    isp: 'Google Fiber', ispOrg: 'Google Fiber Inc.', asn: 16591,
    ipsEnabled: true, wanIp: '71.42.18.9', latencyMs: 12, availabilityPct: 99.9,
  },
  {
    name: 'Lakehouse', host: '192.168.20.1', controllerVersion: '9.0.108',
    isp: 'Comcast Business', ispOrg: 'Comcast Cable Communications', asn: 7922,
    ipsEnabled: false, wanIp: '73.15.204.211', latencyMs: 120, availabilityPct: 97.5,
  },
];

// Device plan per source. `uplinkTo` is a device key within the same source.
const SRC1_DEVICES = [
  { key: 'gw1', name: 'AustinHome-UDM', model: 'UDMPROMAX', shortname: 'UDMPROMAX', type: 'udm', isGateway: true, portCount: 11 },
  { key: 'sw1', name: 'IDF-Switch-16', model: 'USL16LP', shortname: 'USL16LP', type: 'usw', portCount: 16, uplinkTo: 'gw1' },
  { key: 'sw2', name: 'Garage-Switch-8', model: 'USL8LP', shortname: 'USL8LP', type: 'usw', portCount: 8, uplinkTo: 'gw1' },
  { key: 'sw3', name: 'Media-Switch-10', model: 'USWED76', shortname: 'USWED76', type: 'usw', portCount: 10, uplinkTo: 'gw1' },
  { key: 'ap1', name: 'Living-Room-AP', model: 'UAL6', shortname: 'UAL6', type: 'uap', uplinkTo: 'sw1' },
  { key: 'ap2', name: 'Office-AP', model: 'UAPA6A4', shortname: 'UAPA6A4', type: 'uap', uplinkTo: 'sw2' },
  { key: 'ap3', name: 'Garage-AP', model: 'UAPA6A4', shortname: 'UAPA6A4', type: 'uap', uplinkTo: 'sw2' },
  { key: 'sw4', name: 'Basement-Switch-8', model: 'USL8LP', shortname: 'USL8LP', type: 'usw', portCount: 8, uplinkTo: 'gw1', offline: true },
  { key: 'ap4', name: 'Backyard-AP', model: 'UAL6', shortname: 'UAL6', type: 'uap', uplinkTo: 'sw3', upgradable: true },
];
const SRC2_DEVICES = [
  { key: 'gw2', name: 'Lakehouse-UDM', model: 'UDMSE', shortname: 'UDMSE', type: 'udm', isGateway: true, portCount: 9, cpuHigh: true },
  { key: 'sw5', name: 'Dock-Switch-8', model: 'USL8LP', shortname: 'USL8LP', type: 'usw', portCount: 8, uplinkTo: 'gw2', overheating: true },
  { key: 'sw6', name: 'Boathouse-Switch-8', model: 'USL8LP', shortname: 'USL8LP', type: 'usw', portCount: 8, uplinkTo: 'gw2' },
  { key: 'ap5', name: 'Dock-AP', model: 'UAL6', shortname: 'UAL6', type: 'uap', uplinkTo: 'sw5' },
];

const CROSS_HIT_NAMES = ['vra-prod', 'vra-dr', 'vrops-nyc-01', 'vrli-nyc-01'];

// Trouble ports (device key + port_idx) exercising the port-errors / port-poe / port-flapping rules.
const POE_FAULT = { device: 'sw1', port: 3 };
const ERR_RAMP = { device: 'sw2', port: 2 };
const FLAP = { device: 'sw3', port: 5 };

function buildGatewayPorts(rng, portCount) {
  const ports = [];
  for (let i = 1; i <= portCount - 2; i++) {
    const up = chance(rng, 0.85);
    ports.push({
      port_idx: i, name: `Port ${i}`, media: 'GE', up: up ? 1 : 0, speed: up ? 1000 : 0,
      full_duplex: up ? 1 : 0, is_uplink: 0, poe_capable: 0, poe_enable: 0, poe_good: null,
      poe_power: null, poe_current: null, poe_voltage: null, poe_class: null,
      rx_bytes: randInt(rng, 1e8, 5e10), tx_bytes: randInt(rng, 1e8, 5e10),
      rx_errors: randInt(rng, 0, 50), tx_errors: randInt(rng, 0, 50),
      rx_dropped: randInt(rng, 0, 100), tx_dropped: randInt(rng, 0, 100),
      network_name: 'Default', speed_caps: 1000, aggregated_by: 0,
    });
  }
  ports.push({
    port_idx: portCount - 1, name: 'WAN', media: 'SFP+', up: 1, speed: 10000, full_duplex: 1, is_uplink: 1,
    poe_capable: 0, poe_enable: 0, poe_good: null, poe_power: null, poe_current: null, poe_voltage: null, poe_class: null,
    rx_bytes: randInt(rng, 1e10, 9e11), tx_bytes: randInt(rng, 1e10, 9e11),
    rx_errors: randInt(rng, 0, 4000), tx_errors: randInt(rng, 0, 2000),
    rx_dropped: randInt(rng, 0, 4200), tx_dropped: randInt(rng, 0, 500),
    network_name: 'WAN', speed_caps: 10000, aggregated_by: 0,
  });
  ports.push({
    port_idx: portCount, name: 'SFP+ 2', media: 'SFP+', up: 0, speed: 0, full_duplex: 0, is_uplink: 0,
    poe_capable: 0, poe_enable: 0, poe_good: null, poe_power: null, poe_current: null, poe_voltage: null, poe_class: null,
    rx_bytes: 0, tx_bytes: 0, rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0,
    network_name: null, speed_caps: 10000, aggregated_by: 0,
  });
  return ports;
}

function buildSwitchPorts(rng, portCount, offline) {
  const ports = [];
  ports.push({
    port_idx: 1, name: 'Uplink', media: 'GE', up: offline ? 0 : 1, speed: offline ? 0 : 1000,
    full_duplex: offline ? 0 : 1, is_uplink: 1, poe_capable: 0, poe_enable: 0, poe_good: null,
    poe_power: null, poe_current: null, poe_voltage: null, poe_class: null,
    rx_bytes: offline ? 0 : randInt(rng, 1e8, 2e10), tx_bytes: offline ? 0 : randInt(rng, 1e8, 2e10),
    rx_errors: offline ? 0 : randInt(rng, 0, 20), tx_errors: offline ? 0 : randInt(rng, 0, 20),
    rx_dropped: offline ? 0 : randInt(rng, 0, 50), tx_dropped: offline ? 0 : randInt(rng, 0, 50),
    network_name: 'Default', speed_caps: 1000, aggregated_by: 0,
  });
  for (let i = 2; i <= portCount; i++) {
    const poeCapable = chance(rng, 0.8);
    const up = offline ? false : chance(rng, 0.75);
    const poeEnable = poeCapable && up && chance(rng, 0.6);
    ports.push({
      port_idx: i, name: `Port ${i}`, media: 'GE', up: up ? 1 : 0, speed: up ? 1000 : 0,
      full_duplex: up ? 1 : 0, is_uplink: 0,
      poe_capable: poeCapable ? 1 : 0, poe_enable: poeEnable ? 1 : 0,
      poe_good: poeEnable ? 1 : null,
      poe_power: poeEnable ? randFloat(rng, 3, 8, 2) : null,
      poe_current: poeEnable ? randFloat(rng, 60, 200, 0) : null,
      poe_voltage: poeEnable ? randFloat(rng, 52, 56, 2) : null,
      poe_class: poeEnable ? pick(rng, ['Class 3', 'Class 4']) : null,
      rx_bytes: up ? randInt(rng, 1e6, 5e9) : 0, tx_bytes: up ? randInt(rng, 1e6, 5e9) : 0,
      rx_errors: up ? randInt(rng, 0, 30) : 0, tx_errors: up ? randInt(rng, 0, 30) : 0,
      rx_dropped: up ? randInt(rng, 0, 80) : 0, tx_dropped: up ? randInt(rng, 0, 80) : 0,
      network_name: pick(rng, ['Default', 'IoT', 'Cameras']), speed_caps: 1000, aggregated_by: 0,
    });
  }
  return ports;
}

// Client plan: per-device wired/wireless counts, keyed by device key.
const SRC1_CLIENT_PLAN = { sw1: 6, sw2: 3, sw3: 3, ap1: 8, ap2: 7, ap3: 6, ap4: 6, guest: 6 };
const SRC2_CLIENT_PLAN = { sw5: 3, sw6: 3, ap5: 7, guest: 2 };
// { source device key -> [satisfaction override, ...] } low-satisfaction (<50) wireless clients.
const LOW_SATISFACTION = [
  { device: 'ap2', satisfaction: 32, source: 'AustinHome' },
  { device: 'ap2', satisfaction: 41, source: 'AustinHome' },
  { device: 'ap3', satisfaction: 45, source: 'AustinHome' },
  { device: 'ap5', satisfaction: 38, source: 'Lakehouse' },
];

const RADIO_BANDS = [
  { radio: 'ng', channels: [1, 6, 11] },
  { radio: 'na', channels: [36, 44, 149] },
  { radio: '6e', channels: [37, 53, 69] },
];

function seedUnifi(db, { now, encrypt }) {
  const agoStmt = db.prepare("SELECT datetime('now', ?) d");
  const ago = (offset) => agoStmt.get(offset).d;
  const nowIso = new Date(now).toISOString();

  // Demo enables everything: the platform flag AND all optional feature
  // modules (they default OFF in shipping settings — demo showcases them).
  const setDemoSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const key of ['platform_unifi_enabled', 'unifi_feature_protect', 'unifi_feature_wifi', 'unifi_feature_security']) {
    setDemoSetting.run(key);
  }

  const insertSource = db.prepare(`
    INSERT INTO unifi_sources (name, host, port, encrypted_credentials, ssl_verify, polling_interval_minutes,
      sites_json, controller_version, health_json, last_poll_status, last_poll_error, last_poll_at, created_at)
    VALUES (@name, @host, 443, @encrypted_credentials, 0, 10, @sites_json, @controller_version, @health_json,
      'success', NULL, @last_poll_at, @created_at)
  `);
  const insertDevice = db.prepare(`
    INSERT INTO unifi_devices (source_id, site, mac, device_id, name, model, shortname, type, ip, version,
      state, adopted, upgradable, overheating, serial, uptime, cpu_pct, mem_pct, temps_json, satisfaction,
      num_sta, tx_bytes, rx_bytes, uplink_mac, uplink_port, uplink_type, radios_json, is_gateway, last_seen)
    VALUES (@source_id, 'default', @mac, @device_id, @name, @model, @shortname, @type, @ip, @version,
      @state, 1, @upgradable, @overheating, @serial, @uptime, @cpu_pct, @mem_pct, @temps_json, @satisfaction,
      @num_sta, @tx_bytes, @rx_bytes, @uplink_mac, @uplink_port, @uplink_type, @radios_json, @is_gateway, @last_seen)
  `);
  const insertPort = db.prepare(`
    INSERT INTO unifi_ports (source_id, device_mac, port_idx, name, media, up, speed, full_duplex, is_uplink,
      poe_capable, poe_enable, poe_good, poe_power, poe_current, poe_voltage, poe_class,
      rx_bytes, tx_bytes, rx_errors, tx_errors, rx_dropped, tx_dropped, network_name, speed_caps, aggregated_by)
    VALUES (@source_id, @device_mac, @port_idx, @name, @media, @up, @speed, @full_duplex, @is_uplink,
      @poe_capable, @poe_enable, @poe_good, @poe_power, @poe_current, @poe_voltage, @poe_class,
      @rx_bytes, @tx_bytes, @rx_errors, @tx_errors, @rx_dropped, @tx_dropped, @network_name, @speed_caps, @aggregated_by)
  `);
  const insertPortHistory = db.prepare(`
    INSERT INTO unifi_port_history (source_id, device_mac, port_idx, captured_at, up, speed,
      poe_power, poe_voltage, rx_bytes, tx_bytes, rx_errors, tx_errors, rx_dropped, tx_dropped)
    VALUES (@source_id, @device_mac, @port_idx, @captured_at, @up, @speed,
      @poe_power, @poe_voltage, @rx_bytes, @tx_bytes, @rx_errors, @tx_errors, @rx_dropped, @tx_dropped)
  `);
  const insertClient = db.prepare(`
    INSERT INTO unifi_clients (source_id, site, mac, name, hostname, ip, is_wired, is_guest, network,
      essid, ap_mac, sw_mac, sw_port, channel, radio, rssi, signal, noise, satisfaction,
      tx_rate, rx_rate, wired_rate_mbps, uptime, tx_bytes, rx_bytes, oui)
    VALUES (@source_id, 'default', @mac, @name, @hostname, @ip, @is_wired, @is_guest, @network,
      @essid, @ap_mac, @sw_mac, @sw_port, @channel, @radio, @rssi, @signal, @noise, @satisfaction,
      @tx_rate, @rx_rate, @wired_rate_mbps, @uptime, @tx_bytes, @rx_bytes, @oui)
  `);
  const insertWlan = db.prepare(`
    INSERT INTO unifi_wlans (source_id, wlan_id, name, enabled, security, wpa_mode, is_guest, hide_ssid, posture_json)
    VALUES (@source_id, @wlan_id, @name, @enabled, @security, @wpa_mode, @is_guest, @hide_ssid, @posture_json)
  `);
  const insertFirewallRule = db.prepare(`
    INSERT INTO unifi_firewall_rules (source_id, rule_id, kind, ruleset, rule_index, name, action, enabled,
      protocol, src, dst, logging, raw_json)
    VALUES (@source_id, @rule_id, @kind, @ruleset, @rule_index, @name, @action, @enabled,
      @protocol, @src, @dst, @logging, @raw_json)
  `);
  const insertNetwork = db.prepare(`
    INSERT INTO unifi_networks (source_id, network_id, name, purpose, vlan, subnet, enabled)
    VALUES (@source_id, @network_id, @name, @purpose, @vlan, @subnet, @enabled)
  `);
  const insertRogue = db.prepare(`
    INSERT INTO unifi_rogue_aps (source_id, bssid, essid, channel, signal, security, oui, is_rogue, last_seen, first_seen_at)
    VALUES (@source_id, @bssid, @essid, @channel, @signal, @security, @oui, @is_rogue, @last_seen, @first_seen_at)
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO unifi_events (source_id, event_id, category, event_key, event_type, message, raw_json, occurred_at)
    VALUES (@source_id, @event_id, @category, @event_key, @event_type, @message, @raw_json, @occurred_at)
  `);
  const insertWan = db.prepare(`
    INSERT INTO unifi_wan (source_id, wan_name, isp_name, isp_organization, asn, wan_ip, gateway_ip,
      latency_ms, availability_pct, uptime_sec, drops, xput_down, xput_up, speedtest_ping, speedtest_down,
      speedtest_up, speedtest_at, uplink_media, uplink_speed, uplink_max_speed, tx_rate, rx_rate)
    VALUES (@source_id, 'WAN', @isp_name, @isp_organization, @asn, @wan_ip, @gateway_ip,
      @latency_ms, @availability_pct, @uptime_sec, @drops, @xput_down, @xput_up, @speedtest_ping, @speedtest_down,
      @speedtest_up, @speedtest_at, @uplink_media, @uplink_speed, @uplink_max_speed, @tx_rate, @rx_rate)
  `);
  const insertTopology = db.prepare(`
    INSERT INTO unifi_topology (source_id, captured_at, vertices_json, edges_json, has_unknown_switch)
    VALUES (@source_id, @captured_at, @vertices_json, @edges_json, @has_unknown_switch)
  `);
  const insertMetric = db.prepare(`
    INSERT INTO unifi_metrics_history (source_id, captured_at, devices_total, devices_online, clients_total,
      clients_wired, clients_wireless, clients_guest, wan_latency_ms, wan_availability_pct, wan_tx_rate,
      wan_rx_rate, gw_cpu_pct, gw_mem_pct, max_temp_c)
    VALUES (@source_id, @captured_at, @devices_total, @devices_online, @clients_total,
      @clients_wired, @clients_wireless, @clients_guest, @wan_latency_ms, @wan_availability_pct, @wan_tx_rate,
      @wan_rx_rate, @gw_cpu_pct, @gw_mem_pct, @max_temp_c)
  `);

  // ── Sources ──────────────────────────────────────────────────────────
  const sourceIds = {};
  SOURCES.forEach((s) => {
    const rng = rngFor(`unifi-source-${s.name}`);
    const sitesJson = JSON.stringify([{
      id: `site-${s.name.toLowerCase()}`, internalReference: 'default', name: 'Default',
    }]);
    // health_json.ips.enabled is the additive column unifiIssues.js reads for
    // the ips-disabled rule (contract's schema had no dedicated IPS column).
    const healthJson = JSON.stringify({
      ips: {
        enabled: s.ipsEnabled,
        categories: s.ipsEnabled ? ['botnet', 'trojan', 'exploit-kit', 'scan'] : [],
      },
      // Protect runs on the first (AustinHome) controller only — mirrors the
      // poller's health_json.protect stamp read by /protect and the breach rule.
      protect: s.name === 'AustinHome' ? {
        applicationVersion: '6.0.21',
        nvr: {
          name: 'UDM Pro Max',
          armMode: { status: 'disabled', armedAt: null, breachDetectedAt: null, breachEventCount: 0 },
          doorbell: { defaultMessage: 'WELCOME' },
        },
      } : null,
    });
    const info = insertSource.run({
      name: s.name, host: s.host,
      encrypted_credentials: encrypt(JSON.stringify({ apiKey: `demo-not-real-${s.name.toLowerCase()}` })),
      sites_json: sitesJson, controller_version: s.controllerVersion, health_json: healthJson,
      last_poll_at: ago(`-${randInt(rng, 2, 9)} minutes`), created_at: nowIso,
    });
    sourceIds[s.name] = info.lastInsertRowid;
  });

  // ── Devices + ports ──────────────────────────────────────────────────
  const devicesByKey = {}; // key -> { mac, sourceId, sourceName, type, portCount, ...plan }
  let deviceTotal = 0, portTotal = 0;

  [{ source: SOURCES[0], plan: SRC1_DEVICES, clientPlan: SRC1_CLIENT_PLAN },
    { source: SOURCES[1], plan: SRC2_DEVICES, clientPlan: SRC2_CLIENT_PLAN }].forEach(({ source, plan, clientPlan }) => {
    plan.forEach((d) => {
      const rng = rngFor(`unifi-device-${source.name}-${d.key}`);
      devicesByKey[d.key] = {
        ...d, mac: randMac(rng), sourceId: sourceIds[source.name], sourceName: source.name,
        numSta: clientPlan[d.key] || 0,
      };
    });
  });

  Object.values(devicesByKey).forEach((d) => {
    const rng = rngFor(`unifi-device-insert-${d.sourceName}-${d.key}`);
    const uplink = d.uplinkTo ? devicesByKey[d.uplinkTo] : null;
    const offline = !!d.offline;
    const overheating = !!d.overheating;
    const cpuPct = d.cpuHigh ? 93 : randFloat(rng, 8, 55, 1);
    const memPct = d.cpuHigh ? randFloat(rng, 55, 70, 1) : randFloat(rng, 30, 65, 1);
    const temps = d.isGateway || overheating
      ? JSON.stringify([{ name: 'Local', type: 'board', value: overheating ? 84 : randInt(rng, 40, 62) }])
      : null;
    const ip = d.isGateway ? d.mac /* placeholder unused */ : null;
    insertDevice.run({
      source_id: d.sourceId, mac: d.mac, device_id: d.mac.replace(/:/g, ''),
      name: d.name, model: d.model, shortname: d.shortname, type: d.type,
      ip: `192.168.${d.isGateway ? 128 : 129}.${randInt(rng, 2, 250)}`,
      version: pick(rng, ['9.1.120', '9.0.108', '8.6.10']),
      state: offline ? 0 : 1, upgradable: d.upgradable ? 1 : 0, overheating: overheating ? 1 : 0,
      serial: `${d.model}${randInt(rng, 100000, 999999)}`,
      uptime: offline ? 0 : randInt(rng, 3600, 60 * 86400),
      cpu_pct: cpuPct, mem_pct: memPct, temps_json: temps,
      satisfaction: offline ? null : randInt(rng, 80, 100),
      num_sta: offline ? 0 : d.numSta,
      tx_bytes: randInt(rng, 1e9, 9e11), rx_bytes: randInt(rng, 1e9, 9e11),
      uplink_mac: uplink ? uplink.mac : null,
      uplink_port: uplink ? 1 : null,
      uplink_type: uplink ? 'wire' : null,
      radios_json: d.type === 'uap' ? JSON.stringify(RADIO_BANDS.map((b) => ({
        name: b.radio, radio: b.radio, channel: pick(rng, b.channels), tx_power: randInt(rng, 12, 24), num_sta: randInt(rng, 0, 10),
      }))) : null,
      is_gateway: d.isGateway ? 1 : 0,
      last_seen: offline ? Math.round(now / 1000) - randInt(rng, 3600, 7200) : Math.round(now / 1000) - randInt(rng, 5, 120),
    });
    deviceTotal++;

    if (d.portCount) {
      let ports = d.isGateway ? buildGatewayPorts(rng, d.portCount) : buildSwitchPorts(rng, d.portCount, offline);
      if (POE_FAULT.device === d.key) {
        const p = ports.find((x) => x.port_idx === POE_FAULT.port);
        if (p) { p.up = 1; p.poe_capable = 1; p.poe_enable = 1; p.poe_good = 0; p.poe_power = 0; p.poe_current = 0; p.poe_voltage = 0; p.poe_class = 'Class 4'; }
      }
      if (ERR_RAMP.device === d.key) {
        const p = ports.find((x) => x.port_idx === ERR_RAMP.port);
        if (p) { p.up = 1; p.rx_errors = 850; p.tx_errors = 85; }
      }
      if (FLAP.device === d.key) {
        const p = ports.find((x) => x.port_idx === FLAP.port);
        if (p) p.up = 1;
      }
      ports.forEach((p) => {
        // One deliberate below-capability link (GE negotiated at 100 Mbps =
        // classic bad-cable tell) for the Overview port-health insight.
        if (d.key === 'sw1' && p.port_idx === 7 && p.up) { p.speed = 100; }
        insertPort.run({ source_id: d.sourceId, device_mac: d.mac, ...p });
        portTotal++;
      });
      devicesByKey[d.key].ports = ports;
    }
  });

  // ── Port history: error-ramp port (7d hourly, ramps hard in trailing 24h)
  //    and flapping port (last 24h, alternating up/down). ────────────────
  let portHistoryTotal = 0;
  {
    const errDevice = devicesByKey[ERR_RAMP.device];
    for (let h = 168; h >= 0; h--) {
      let rx;
      if (h > 24) {
        rx = 100 + Math.round((168 - h) * 0.2);
      } else {
        rx = 130 + (24 - h) * 30;
      }
      const tx = Math.round(rx * 0.1);
      insertPortHistory.run({
        source_id: errDevice.sourceId, device_mac: errDevice.mac, port_idx: ERR_RAMP.port,
        captured_at: ago(`-${h} hours`), up: 1, speed: 1000, poe_power: null, poe_voltage: null,
        rx_bytes: randInt(rngFor(`unifi-errhist-${h}`), 1e6, 5e8), tx_bytes: randInt(rngFor(`unifi-errhist-tx-${h}`), 1e6, 5e8),
        rx_errors: rx, tx_errors: tx, rx_dropped: 0, tx_dropped: 0,
      });
      portHistoryTotal++;
    }

    const flapDevice = devicesByKey[FLAP.device];
    const flapPattern = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
    const flapHours = [24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2, 0];
    flapHours.forEach((h, i) => {
      const up = flapPattern[i];
      insertPortHistory.run({
        source_id: flapDevice.sourceId, device_mac: flapDevice.mac, port_idx: FLAP.port,
        captured_at: ago(`-${h} hours`), up, speed: up ? 1000 : 0, poe_power: null, poe_voltage: null,
        rx_bytes: up ? randInt(rngFor(`unifi-flaphist-${h}`), 1e6, 5e8) : 0,
        tx_bytes: up ? randInt(rngFor(`unifi-flaphist-tx-${h}`), 1e6, 5e8) : 0,
        rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0,
      });
      portHistoryTotal++;
    });
  }

  // ── Networks + WLANs ────────────────────────────────────────────────
  const NETWORK_PLAN = {
    AustinHome: [
      { id: 'net-default', name: 'Default', purpose: 'corporate', vlan: 1, subnet: '192.168.1.0/24' },
      { id: 'net-iot', name: 'IoT', purpose: 'corporate', vlan: 20, subnet: '192.168.20.0/24' },
      { id: 'net-cameras', name: 'Cameras', purpose: 'corporate', vlan: 30, subnet: '192.168.30.0/24' },
      { id: 'net-guest', name: 'Guest', purpose: 'guest', vlan: 40, subnet: '192.168.40.0/24' },
    ],
    Lakehouse: [
      { id: 'net-default-lh', name: 'Default', purpose: 'corporate', vlan: 1, subnet: '192.168.21.0/24' },
      { id: 'net-guest-lh', name: 'Guest', purpose: 'guest', vlan: 40, subnet: '192.168.61.0/24' },
    ],
  };
  const WLAN_PLAN = {
    AustinHome: [
      { id: 'wlan-5g', name: 'AustinHome-5G', security: 'wpapsk', wpa_mode: 'wpa3', is_guest: 0, hide_ssid: 0,
        wpa3_support: 1, wpa3_transition: 1, pmf_mode: 'required', l2_isolation: 0, bss_transition: 1, fast_roaming_enabled: 1, minrate_ng_enabled: 0 },
      // Deliberate posture warning: WPA2-only, no WPA3 transition (WiFi Security Posture panel).
      { id: 'wlan-iot', name: 'AustinHome-IoT', security: 'wpapsk', wpa_mode: 'wpa2', is_guest: 0, hide_ssid: 0,
        wpa3_support: 0, wpa3_transition: 0, pmf_mode: 'optional', l2_isolation: 1, bss_transition: 0, fast_roaming_enabled: 0, minrate_ng_enabled: 1 },
      { id: 'wlan-cam', name: 'AustinHome-Cameras', security: 'wpapsk', wpa_mode: 'wpa2', is_guest: 0, hide_ssid: 1,
        wpa3_support: 0, wpa3_transition: 0, pmf_mode: 'optional', l2_isolation: 1, bss_transition: 0, fast_roaming_enabled: 0, minrate_ng_enabled: 0 },
      { id: 'wlan-guest', name: 'AustinHome-Guest', security: 'wpapsk', wpa_mode: 'wpa2', is_guest: 1, hide_ssid: 0,
        wpa3_support: 0, wpa3_transition: 0, pmf_mode: 'disabled', l2_isolation: 1, bss_transition: 0, fast_roaming_enabled: 0, minrate_ng_enabled: 0 },
    ],
    Lakehouse: [
      { id: 'wlan-lh-main', name: 'Lakehouse-5G', security: 'wpapsk', wpa_mode: 'wpa3', is_guest: 0, hide_ssid: 0,
        wpa3_support: 1, wpa3_transition: 1, pmf_mode: 'required', l2_isolation: 0, bss_transition: 1, fast_roaming_enabled: 1, minrate_ng_enabled: 0 },
      { id: 'wlan-lh-guest', name: 'Lakehouse-Guest', security: 'wpapsk', wpa_mode: 'wpa2', is_guest: 1, hide_ssid: 0,
        wpa3_support: 0, wpa3_transition: 0, pmf_mode: 'disabled', l2_isolation: 1, bss_transition: 0, fast_roaming_enabled: 0, minrate_ng_enabled: 0 },
    ],
  };
  let networkTotal = 0, wlanTotal = 0;
  SOURCES.forEach((s) => {
    NETWORK_PLAN[s.name].forEach((n) => {
      insertNetwork.run({ source_id: sourceIds[s.name], network_id: n.id, name: n.name, purpose: n.purpose, vlan: n.vlan, subnet: n.subnet, enabled: 1 });
      networkTotal++;
    });
    WLAN_PLAN[s.name].forEach((w) => {
      const posture = JSON.stringify({
        wpa_mode: w.wpa_mode, wpa3_support: w.wpa3_support, wpa3_transition: w.wpa3_transition,
        pmf_mode: w.pmf_mode, hide_ssid: w.hide_ssid, l2_isolation: w.l2_isolation,
        bss_transition: w.bss_transition, fast_roaming_enabled: w.fast_roaming_enabled, minrate_ng_enabled: w.minrate_ng_enabled,
      });
      insertWlan.run({ source_id: sourceIds[s.name], wlan_id: w.id, name: w.name, enabled: 1, security: w.security, wpa_mode: w.wpa_mode, is_guest: w.is_guest, hide_ssid: w.hide_ssid, posture_json: posture });
      wlanTotal++;
    });
  });

  // ── Firewall + traffic rules (~8 firewall incl. 'NAS Germany', 3 traffic) ─
  let firewallRuleTotal = 0;
  const FIREWALL_RULES = [
    { ruleset: 'WAN_IN', index: 2000, name: 'NAS Germany', action: 'drop', enabled: 1, protocol: 'all', src: '85.214.0.0/16', dst: 'any', logging: 1 },
    { ruleset: 'WAN_IN', index: 2001, name: 'Block Telnet', action: 'drop', enabled: 1, protocol: 'tcp', src: 'any', dst: 'any:23', logging: 0 },
    { ruleset: 'WAN_IN', index: 2002, name: 'Allow established/related', action: 'accept', enabled: 1, protocol: 'all', src: 'any', dst: 'any', logging: 0 },
    { ruleset: 'LAN_IN', index: 3000, name: 'Guest to LAN block', action: 'drop', enabled: 1, protocol: 'all', src: 'Guest', dst: 'Default', logging: 1 },
    { ruleset: 'LAN_IN', index: 3001, name: 'IoT to LAN block', action: 'drop', enabled: 1, protocol: 'all', src: 'IoT', dst: 'Default', logging: 1 },
    { ruleset: 'LAN_IN', index: 3002, name: 'Cameras to WAN block', action: 'drop', enabled: 1, protocol: 'all', src: 'Cameras', dst: 'any', logging: 0 },
    { ruleset: 'WAN_OUT', index: 2100, name: 'Block known scanners', action: 'reject', enabled: 1, protocol: 'tcp', src: 'any', dst: 'any', logging: 1 },
    { ruleset: 'WAN_LOCAL', index: 2200, name: 'Allow VPN', action: 'accept', enabled: 0, protocol: 'udp', src: 'any', dst: 'any:51820', logging: 0 },
  ];
  const TRAFFIC_RULES = [
    { description: 'Block social media on IoT', action: 'BLOCK', enabled: 1, matching_target: 'IoT' },
    { description: 'Block ads network-wide', action: 'BLOCK', enabled: 1, matching_target: 'Default' },
    { description: 'Allow smart TV streaming', action: 'ALLOW', enabled: 1, matching_target: 'Default' },
  ];
  SOURCES.forEach((s) => {
    const sourceId = sourceIds[s.name];
    FIREWALL_RULES.forEach((r, i) => {
      insertFirewallRule.run({
        source_id: sourceId, rule_id: `fwrule-${s.name.toLowerCase()}-${i}`, kind: 'firewall',
        ruleset: r.ruleset, rule_index: r.index, name: r.name, action: r.action, enabled: r.enabled,
        protocol: r.protocol, src: r.src, dst: r.dst, logging: r.logging, raw_json: JSON.stringify(r),
      });
      firewallRuleTotal++;
    });
    TRAFFIC_RULES.forEach((r, i) => {
      insertFirewallRule.run({
        source_id: sourceId, rule_id: `trrule-${s.name.toLowerCase()}-${i}`, kind: 'traffic',
        ruleset: null, rule_index: null, name: r.description, action: r.action, enabled: r.enabled,
        protocol: null, src: r.matching_target, dst: null, logging: null, raw_json: JSON.stringify(r),
      });
      firewallRuleTotal++;
    });
  });

  // ── Clients ──────────────────────────────────────────────────────────
  let clientTotal = 0;
  function genClientsForSource(source, clientPlan) {
    const sourceId = sourceIds[source.name];
    const switches = Object.values(devicesByKey).filter((d) => d.sourceName === source.name && d.type === 'usw' && !d.offline);
    const aps = Object.values(devicesByKey).filter((d) => d.sourceName === source.name && d.type === 'uap');
    const networks = NETWORK_PLAN[source.name];
    const guestWlan = WLAN_PLAN[source.name].find((w) => w.is_guest);
    const nonGuestWlans = WLAN_PLAN[source.name].filter((w) => !w.is_guest);
    let idx = 0;
    let crossHitIdx = 0;

    for (const [deviceKey, count] of Object.entries(clientPlan)) {
      if (deviceKey === 'guest') continue;
      const device = devicesByKey[deviceKey];
      if (!device) continue;
      const isWired = device.type === 'usw';
      for (let i = 0; i < count; i++) {
        const rng = rngFor(`unifi-client-${source.name}-${deviceKey}-${i}`);
        const useCrossHit = source.name === 'AustinHome' && isWired && deviceKey === 'sw1' && crossHitIdx < CROSS_HIT_NAMES.length;
        const name = useCrossHit ? CROSS_HIT_NAMES[crossHitIdx] : `${source.name.toLowerCase()}-${isWired ? 'wd' : 'wl'}-${String(idx + 1).padStart(3, '0')}`;
        if (useCrossHit) crossHitIdx++;
        const network = pick(rng, networks).name;
        const low = LOW_SATISFACTION.find((l) => l.device === deviceKey && l.source === source.name && !l._used);
        if (low) low._used = true;

        if (isWired) {
          insertClient.run({
            source_id: sourceId, mac: randMac(rng), name, hostname: name,
            ip: `192.168.1.${randInt(rng, 10, 250)}`, is_wired: 1, is_guest: 0, network,
            essid: null, ap_mac: null, sw_mac: device.mac, sw_port: 2 + (idx % Math.max(1, (device.portCount || 8) - 1)),
            channel: null, radio: null, rssi: null, signal: null, noise: null,
            satisfaction: randInt(rng, 85, 100),
            tx_rate: null, rx_rate: null, wired_rate_mbps: pick(rng, [1000, 1000, 2500]),
            uptime: randInt(rng, 3600, 30 * 86400), tx_bytes: randInt(rng, 1e7, 5e10), rx_bytes: randInt(rng, 1e7, 5e10),
            oui: pick(rng, OUIS),
          });
        } else {
          const band = pick(rng, RADIO_BANDS);
          const satisfaction = low ? low.satisfaction : randInt(rng, 70, 100);
          insertClient.run({
            source_id: sourceId, mac: randMac(rng), name, hostname: name,
            ip: `192.168.1.${randInt(rng, 10, 250)}`, is_wired: 0, is_guest: 0, network,
            essid: pick(rng, nonGuestWlans).name, ap_mac: device.mac, sw_mac: null, sw_port: null,
            channel: pick(rng, band.channels), radio: band.radio,
            rssi: -randInt(rng, 40, 78), signal: -randInt(rng, 40, 78), noise: -randInt(rng, 85, 95),
            satisfaction,
            tx_rate: pick(rng, [144, 300, 433, 867, 1200]), rx_rate: pick(rng, [144, 300, 433, 867, 1200]),
            wired_rate_mbps: null, uptime: randInt(rng, 600, 20 * 86400),
            tx_bytes: randInt(rng, 1e6, 2e10), rx_bytes: randInt(rng, 1e6, 2e10), oui: pick(rng, OUIS),
          });
        }
        clientTotal++;
        idx++;
      }
    }

    const guestCount = clientPlan.guest || 0;
    const guestAp = aps[0];
    for (let i = 0; i < guestCount; i++) {
      const rng = rngFor(`unifi-client-${source.name}-guest-${i}`);
      const band = pick(rng, RADIO_BANDS);
      insertClient.run({
        source_id: sourceId, mac: randMac(rng), name: `guest-${String(i + 1).padStart(2, '0')}`, hostname: null,
        ip: `192.168.40.${randInt(rng, 10, 250)}`, is_wired: 0, is_guest: 1, network: 'Guest',
        essid: guestWlan ? guestWlan.name : null, ap_mac: guestAp ? guestAp.mac : null, sw_mac: null, sw_port: null,
        channel: pick(rng, band.channels), radio: band.radio,
        rssi: -randInt(rng, 45, 80), signal: -randInt(rng, 45, 80), noise: -randInt(rng, 85, 95),
        satisfaction: randInt(rng, 60, 95),
        tx_rate: pick(rng, [72, 144, 300]), rx_rate: pick(rng, [72, 144, 300]),
        wired_rate_mbps: null, uptime: randInt(rng, 300, 43200),
        tx_bytes: randInt(rng, 1e5, 5e9), rx_bytes: randInt(rng, 1e5, 5e9), oui: pick(rng, OUIS),
      });
      clientTotal++;
    }
  }
  genClientsForSource(SOURCES[0], SRC1_CLIENT_PLAN);
  genClientsForSource(SOURCES[1], SRC2_CLIENT_PLAN);

  // ── Rogue / neighboring APs (~30 total, 1 flagged is_rogue on AustinHome).
  //    Most first-seen 30d back; 2 rows first-seen 3d back for the
  //    "N new this week" rogueChanges chip. ───────────────────────────────
  let rogueTotal = 0;
  const NEIGHBOR_ESSIDS = ['NETGEAR87', 'ATT-WIFI-4521', 'xfinitywifi', 'Linksys00234', 'HP-Print-9C-Office', 'MySpectrumWiFi-8821', 'DIRECT-4B-HP', 'TP-Link_2.4G'];
  let rogueNewThisWeekLeft = 2;
  SOURCES.forEach((s, sIdx) => {
    const rng = rngFor(`unifi-rogue-${s.name}`);
    const count = sIdx === 0 ? 20 : 10;
    for (let i = 0; i < count; i++) {
      const isNew = rogueNewThisWeekLeft > 0 && i === 0;
      if (isNew) rogueNewThisWeekLeft--;
      insertRogue.run({
        source_id: sourceIds[s.name], bssid: randMac(rng), essid: pick(rng, NEIGHBOR_ESSIDS),
        channel: pick(rng, [1, 6, 11, 36, 44, 149]), signal: -randInt(rng, 55, 90),
        security: pick(rng, ['WPA2-Personal (AES/CCMP)', 'WPA3-Personal (SAE)', 'Open']),
        oui: pick(rng, OUIS), is_rogue: 0, last_seen: Math.round(now / 1000) - randInt(rng, 60, 3600),
        first_seen_at: ago(isNew ? '-3 days' : '-30 days'),
      });
      rogueTotal++;
    }
  });
  insertRogue.run({
    source_id: sourceIds.AustinHome, bssid: randMac(rngFor('unifi-rogue-evil-twin')),
    essid: 'AustinHome-5G', channel: 6, signal: -38, security: 'Open',
    oui: 'Unknown', is_rogue: 1, last_seen: Math.round(now / 1000) - 300, first_seen_at: ago('-3 days'),
  });
  rogueTotal++;

  // ── Events (~60, >=12 SECURITY, >=6 carrying rich parameters incl. a
  //    'NAS Germany' TRIGGER, plus 4 CLIENT roam/disconnect events below) ──
  const EVENT_DEFS = [
    { category: 'SECURITY', event: 'BLOCKED_BY_FIREWALL', msg: (h) => `Traffic blocked by firewall rule from ${h}` },
    { category: 'SECURITY', event: 'IPS_ALERT', msg: (h) => `IPS alert triggered for connection from ${h}` },
    { category: 'SECURITY', event: 'HONEYPOT_DETECTED', msg: () => 'Rogue AP flagged as evil twin' },
    { category: 'CLIENT', event: 'EVT_WC_Connected', msg: (h) => `Client ${h} connected` },
    { category: 'CLIENT', event: 'EVT_WC_Disconnected', msg: (h) => `Client ${h} disconnected` },
    { category: 'DEVICE', event: 'EVT_SW_PoeDisconnect', msg: (h) => `PoE device disconnected on ${h}` },
    { category: 'DEVICE', event: 'EVT_AP_Restarted', msg: (h) => `Access point ${h} restarted` },
    { category: 'ADMIN', event: 'EVT_AD_Login', msg: () => 'Admin logged into controller' },
  ];
  const SECURITY_TRIGGERS = ['NAS Germany', 'Block Telnet', 'Guest to LAN block'];
  let eventTotal = 0;
  let eventIdx = 0;
  SOURCES.forEach((s) => {
    const rng = rngFor(`unifi-events-${s.name}`);
    const securityCount = s.name === 'AustinHome' ? 8 : 5;
    for (let i = 0; i < securityCount; i++) {
      const def = EVENT_DEFS[i % 3];
      const srcIp = `192.168.1.${randInt(rng, 10, 250)}`;
      // First 3 SECURITY events per source carry parsed parameters (>=6 total).
      const rich = i < 3;
      const parameters = rich ? {
        SRC_CLIENT: { id: randMac(rng), ip: srcIp, name: `${s.name.toLowerCase()}-wd-00${i + 1}` },
        DST_IP: { ip: `85.214.${randInt(rng, 1, 254)}.${randInt(rng, 1, 254)}` },
        TRIGGER: { name: pick(rng, SECURITY_TRIGGERS) },
      } : {};
      insertEvent.run({
        source_id: sourceIds[s.name], event_id: `evt-${s.name}-${eventIdx}`, category: def.category,
        event_key: def.event, event_type: def.event, message: def.msg(srcIp),
        raw_json: JSON.stringify({ category: def.category, event: def.event, parameters }),
        occurred_at: ago(`-${randInt(rng, 5, 10080)} minutes`),
      });
      eventTotal++;
      eventIdx++;
    }
    const otherCount = s.name === 'AustinHome' ? 20 : 14;
    for (let i = 0; i < otherCount; i++) {
      const def = pick(rng, EVENT_DEFS.slice(3));
      insertEvent.run({
        source_id: sourceIds[s.name], event_id: `evt-${s.name}-${eventIdx}`, category: def.category,
        event_key: def.event, event_type: def.event, message: def.msg(`${s.name}-node-${randInt(rng, 1, 6)}`),
        raw_json: JSON.stringify({ category: def.category, event: def.event }),
        occurred_at: ago(`-${randInt(rng, 5, 10080)} minutes`),
      });
      eventTotal++;
      eventIdx++;
    }
  });

  // ── CLIENT roam/disconnect events tied to real seeded wireless clients
  //    (Roaming & Stability table + sticky-client detection). ─────────────
  {
    const roamRng = rngFor('unifi-roam-events');
    const wirelessClients = db.prepare(`
      SELECT mac, name FROM unifi_clients WHERE source_id = ? AND is_wired = 0 ORDER BY id LIMIT 4
    `).all(sourceIds.AustinHome);
    const ROAM_DEFS = ['EVT_WC_RoamRadio', 'EVT_WC_Roam', 'EVT_WC_Disconnected', 'EVT_WC_Disconnected'];
    wirelessClients.forEach((c, i) => {
      const key = ROAM_DEFS[i % ROAM_DEFS.length];
      const isRoam = /ROAM/i.test(key);
      insertEvent.run({
        source_id: sourceIds.AustinHome, event_id: `evt-roam-${i}`, category: 'CLIENT',
        event_key: key, event_type: key,
        message: isRoam ? `Client ${c.name || c.mac} roamed to a new AP` : `Client ${c.name || c.mac} disconnected`,
        raw_json: JSON.stringify({ category: 'CLIENT', event: key, parameters: { CLIENT: { mac: c.mac, name: c.name } } }),
        occurred_at: ago(`-${randInt(roamRng, 5, 1400)} minutes`),
      });
      eventTotal++;
    });
  }

  // ── WAN ──────────────────────────────────────────────────────────────
  SOURCES.forEach((s) => {
    const rng = rngFor(`unifi-wan-${s.name}`);
    insertWan.run({
      source_id: sourceIds[s.name], isp_name: s.isp, isp_organization: s.ispOrg, asn: s.asn,
      wan_ip: s.wanIp, gateway_ip: `${s.host.split('.').slice(0, 3).join('.')}.1`,
      latency_ms: s.latencyMs, availability_pct: s.availabilityPct,
      uptime_sec: randInt(rng, 86400, 90 * 86400), drops: randInt(rng, 0, 50),
      xput_down: randFloat(rng, 300, 950, 1), xput_up: randFloat(rng, 100, 400, 1),
      speedtest_ping: randFloat(rng, 5, 20, 1), speedtest_down: randFloat(rng, 400, 990, 1),
      speedtest_up: randFloat(rng, 150, 450, 1), speedtest_at: Math.round(now / 1000) - randInt(rng, 600, 7200),
      uplink_media: 'SFP+', uplink_speed: 10000, uplink_max_speed: 10000,
      tx_rate: randInt(rng, 5000, 400000), rx_rate: randInt(rng, 5000, 400000),
    });
  });

  // ── Topology per source ─────────────────────────────────────────────
  SOURCES.forEach((s) => {
    const sourceId = sourceIds[s.name];
    const sourceDevices = Object.values(devicesByKey).filter((d) => d.sourceName === s.name);
    const vertices = sourceDevices.map((d) => ({ mac: d.mac, name: d.name, type: d.type.toUpperCase(), unifiDevice: true }));
    const edges = [];
    sourceDevices.forEach((d) => {
      if (d.uplinkTo) {
        const up = devicesByKey[d.uplinkTo];
        edges.push({ uplinkMac: up.mac, downlinkMac: d.mac, uplinkPortNumber: 1, rateMbps: 1000, type: 'WIRED' });
      }
    });
    const clientRows = db.prepare('SELECT mac, name, is_wired, ap_mac, sw_mac, signal FROM unifi_clients WHERE source_id = ?').all(sourceId);
    clientRows.forEach((c) => {
      vertices.push({ mac: c.mac, name: c.name, type: 'CLIENT', unifiDevice: false });
      const upMac = c.is_wired ? c.sw_mac : c.ap_mac;
      if (upMac) {
        edges.push({
          uplinkMac: upMac, downlinkMac: c.mac,
          rateMbps: c.is_wired ? 1000 : 400, type: c.is_wired ? 'WIRED' : 'WIRELESS',
          ...(c.is_wired ? {} : { signalDbm: c.signal }),
        });
      }
    });
    insertTopology.run({
      source_id: sourceId, captured_at: nowIso, vertices_json: JSON.stringify(vertices),
      edges_json: JSON.stringify(edges), has_unknown_switch: 0,
    });
  });

  // ── Metrics history: 48h @ 30-min steps per source, evening client peaks ─
  let metricsTotal = 0;
  SOURCES.forEach((s) => {
    const rng = rngFor(`unifi-metrics-${s.name}`);
    const sourceId = sourceIds[s.name];
    const sourceDevices = Object.values(devicesByKey).filter((d) => d.sourceName === s.name);
    const devicesOnline = sourceDevices.filter((d) => !d.offline).length;
    const gateway = sourceDevices.find((d) => d.isGateway);
    const totalWired = Object.entries(s.name === 'AustinHome' ? SRC1_CLIENT_PLAN : SRC2_CLIENT_PLAN)
      .filter(([k]) => devicesByKey[k] && devicesByKey[k].type === 'usw').reduce((a, [, v]) => a + v, 0);
    const totalWireless = Object.entries(s.name === 'AustinHome' ? SRC1_CLIENT_PLAN : SRC2_CLIENT_PLAN)
      .filter(([k]) => devicesByKey[k] && devicesByKey[k].type === 'uap').reduce((a, [, v]) => a + v, 0);
    const totalGuest = (s.name === 'AustinHome' ? SRC1_CLIENT_PLAN : SRC2_CLIENT_PLAN).guest || 0;
    for (let step = 95; step >= 0; step--) {
      const minutesAgo = step * 30;
      const hourOfDay = new Date(now - minutesAgo * 60000).getHours();
      const eveningBoost = hourOfDay >= 18 && hourOfDay <= 23 ? 1.25 : hourOfDay >= 0 && hourOfDay <= 6 ? 0.6 : 1.0;
      const jitter = randFloat(rng, 0.85, 1.1, 2);
      const clientsWireless = Math.max(0, Math.round(totalWireless * eveningBoost * jitter));
      const clientsWired = Math.max(0, Math.round(totalWired * jitter));
      const clientsGuest = Math.max(0, Math.round(totalGuest * eveningBoost * jitter));
      const isRecent = minutesAgo <= 60;
      insertMetric.run({
        source_id: sourceId, captured_at: ago(`-${minutesAgo} minutes`),
        devices_total: sourceDevices.length, devices_online: devicesOnline,
        clients_total: clientsWireless + clientsWired + clientsGuest,
        clients_wired: clientsWired, clients_wireless: clientsWireless, clients_guest: clientsGuest,
        wan_latency_ms: Math.round(s.latencyMs * randFloat(rng, 0.9, 1.1, 2)),
        wan_availability_pct: s.availabilityPct,
        wan_tx_rate: randInt(rng, 5000, 300000), wan_rx_rate: randInt(rng, 5000, 300000),
        gw_cpu_pct: gateway && gateway.cpuHigh && isRecent ? randFloat(rng, 88, 94, 1) : randFloat(rng, 10, 40, 1),
        gw_mem_pct: randFloat(rng, 40, 70, 1),
        max_temp_c: randFloat(rng, 48, 62, 1),
      });
      metricsTotal++;
    }
  });

  // ── Client-seen ledger: bootstrap 30 days back, then mark 3 clients as
  // newly joined this week for the new-devices insight ─────────────────
  db.prepare(`
    INSERT INTO unifi_client_seen (source_id, mac, name, first_seen, last_seen)
    SELECT source_id, mac, COALESCE(name, hostname), datetime('now', '-30 days'), datetime('now')
    FROM unifi_clients
  `).run();
  const seenRng = rngFor('unifi-client-seen');
  const recentIds = db.prepare('SELECT id FROM unifi_client_seen ORDER BY id LIMIT 3').all();
  recentIds.forEach((r, i) => {
    db.prepare("UPDATE unifi_client_seen SET first_seen = datetime('now', ?) WHERE id = ?")
      .run(`-${randInt(seenRng, 1, 5)} days`, r.id);
  });

  // ── Protect cameras (AustinHome only; one deliberately DISCONNECTED for
  // the camera-offline rule) — before reconcile so the issue lands in history
  const camRng = rngFor('unifi-cameras');
  const insertCamera = db.prepare(`
    INSERT INTO unifi_cameras (source_id, camera_id, model_key, name, mac, state, is_mic_enabled,
      video_mode, hdr_type, smart_detect_json, has_package_camera)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const CAMERAS = [
    { name: 'Front Door', detect: ['person', 'vehicle'], state: 'CONNECTED' },
    { name: 'Driveway', detect: ['person', 'vehicle', 'animal'], state: 'CONNECTED' },
    { name: 'Backyard', detect: ['person', 'animal'], state: 'CONNECTED' },
    { name: 'Garage', detect: ['person'], state: 'DISCONNECTED' },
  ];
  CAMERAS.forEach((c, i) => {
    insertCamera.run(sourceIds.AustinHome, `demo-cam-${i + 1}`, 'camera', c.name, randMac(camRng),
      c.state, 1, 'default', 'auto', JSON.stringify(c.detect), 0);
  });
  insertCamera.run(sourceIds.AustinHome, 'demo-chime-1', 'chime', 'DoorBell Chime', randMac(camRng),
    'CONNECTED', null, null, null, null, null);
  const cameraTotal = CAMERAS.length + 1;

  // ── Issue history: reconciled live from seeded inventory ──────────────
  let issueHistoryTotal = 0;
  try {
    const { reconcileIssueHistory } = require('../../services/unifiIssues');
    reconcileIssueHistory();
    const histRng = rngFor('unifi-issue-history');
    for (const row of db.prepare("SELECT id FROM unifi_issue_history WHERE status = 'open'").all()) {
      const ageMin = randInt(histRng, 3 * 60, 6 * 24 * 60);
      db.prepare(`
        UPDATE unifi_issue_history SET first_seen = datetime('now', ?), last_seen = datetime('now', '-4 minutes') WHERE id = ?
      `).run(`-${ageMin} minutes`, row.id);
    }
    const insertResolved = db.prepare(`
      INSERT INTO unifi_issue_history (issue_key, source, severity, type, target, message, status, first_seen, last_seen, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, 'resolved', datetime('now', ?), datetime('now', ?), datetime('now', ?))
    `);
    const RESOLVED = [
      ['firmware-upgrade|AustinHome|Living-Room-AP', 'AustinHome', 'info', 'firmware-upgrade', 'Living-Room-AP',
        'Living-Room-AP has a firmware update available', 6 * 24 * 60, 5 * 24 * 60],
      ['wan-latency|Lakehouse|Comcast Business', 'Lakehouse', 'warning', 'wan-latency', 'Comcast Business',
        'WAN latency elevated on Lakehouse', 3 * 24 * 60, 60],
    ];
    for (const [key, source, sev, type, target, msg, openedMinAgo, durationMin] of RESOLVED) {
      const resolvedMinAgo = openedMinAgo - durationMin;
      insertResolved.run(key, source, sev, type, target, msg,
        `-${openedMinAgo} minutes`, `-${resolvedMinAgo} minutes`, `-${resolvedMinAgo} minutes`);
    }
    issueHistoryTotal = db.prepare('SELECT COUNT(*) n FROM unifi_issue_history').get().n;
  } catch (err) {
    console.error(`[seedUnifi] issue history reconcile skipped (WP1 services/unifiIssues.js missing?): ${err.message}`);
  }

  return {
    sources: SOURCES.length, devices: deviceTotal, ports: portTotal, portHistory: portHistoryTotal,
    clients: clientTotal, networks: networkTotal, wlans: wlanTotal, rogueAps: rogueTotal,
    events: eventTotal, metrics: metricsTotal, issueHistory: issueHistoryTotal, cameras: cameraTotal,
    firewallRules: firewallRuleTotal,
  };
}

module.exports = { seedUnifi };
