// UniFi poller — one framework poller task per unifi_sources row (contract).
// Every inventory section is fetched independently per site; a failed
// section SKIPS its DELETE+INSERT so a transient API error never wipes
// previously good rows (nutanixPoller.js trySection pattern). Devices/ports
// and clients carry a `site` column and are written per-site; WLANs/
// networks/rogue APs/events have no site column in this schema and are
// merged across all sites of a source before a single write.
//
// Ported from backend/services/unifiPoller.js. db/logger/createPoller now
// come from coreApi; the framework's `createPoller` is coreApi.createPoller.
//
// Module-scoped singleton: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first and needs to reach the same poller instance for
// schedule/cancel/trigger on source CRUD. getPoller() lazily builds it if not
// yet created, and createUnifiPoller() (the manifest.createPoller entry
// point) reuses it if router.js got there first (nutanix poller.js pattern).
const api = require('./api');
const { reconcileIssueHistory, featureEnabled } = require('./issues');

let pollerInstance = null;

const safeMsg = (e) => api.errMsg(e);

async function trySection(coreApi, label, fn, { required = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    coreApi.logger.warn(`[UnifiPoller] ${label} failed: ${safeMsg(err)}`);
    if (required) throw err;
    return undefined;
  }
}

// ── Store: devices + ports (per site) ───────────────────────────────────────

function buildStoreDevices(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, site, deviceRows) => {
    db.prepare('DELETE FROM unifi_devices WHERE source_id = ? AND site = ?').run(sourceId, site);
    const stmt = db.prepare(`
      INSERT INTO unifi_devices (source_id, site, mac, device_id, name, model, shortname, type, ip, version,
        state, adopted, upgradable, overheating, serial, uptime, cpu_pct, mem_pct, temps_json, satisfaction,
        num_sta, tx_bytes, rx_bytes, uplink_mac, uplink_port, uplink_type, radios_json, is_gateway, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of deviceRows) {
      if (!d.mac) continue;
      stmt.run(sourceId, site, d.mac, d.deviceId, d.name, d.model, d.shortname, d.type, d.ip, d.version,
        d.state, d.adopted, d.upgradable, d.overheating, d.serial, d.uptime, d.cpuPct, d.memPct, d.tempsJson,
        d.satisfaction, d.numSta, d.txBytes, d.rxBytes, d.uplinkMac, d.uplinkPort, d.uplinkType, d.radiosJson,
        d.isGateway, d.lastSeen);
    }
  });
}

function buildStorePorts(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, deviceMacs, portsByMac) => {
    if (deviceMacs.length) {
      const placeholders = deviceMacs.map(() => '?').join(',');
      db.prepare(`DELETE FROM unifi_ports WHERE source_id = ? AND device_mac IN (${placeholders})`).run(sourceId, ...deviceMacs);
    }
    const stmt = db.prepare(`
      INSERT INTO unifi_ports (source_id, device_mac, port_idx, name, media, up, speed, full_duplex, is_uplink,
        poe_capable, poe_enable, poe_good, poe_power, poe_current, poe_voltage, poe_class, rx_bytes, tx_bytes,
        rx_errors, tx_errors, rx_dropped, tx_dropped, network_name, speed_caps, aggregated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [mac, ports] of portsByMac) {
      for (const p of ports) {
        if (p.portIdx == null) continue;
        stmt.run(sourceId, mac, p.portIdx, p.name, p.media, p.up, p.speed, p.fullDuplex, p.isUplink,
          p.poeCapable, p.poeEnable, p.poeGood, p.poePower, p.poeCurrent, p.poeVoltage, p.poeClass,
          p.rxBytes, p.txBytes, p.rxErrors, p.txErrors, p.rxDropped, p.txDropped, p.networkName,
          p.speedCaps, p.aggregatedBy);
      }
    }
  });
}

function buildAppendPortHistory(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, portsByMac) => {
    const stmt = db.prepare(`
      INSERT INTO unifi_port_history (source_id, device_mac, port_idx, up, speed, poe_power, poe_voltage,
        rx_bytes, tx_bytes, rx_errors, tx_errors, rx_dropped, tx_dropped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [mac, ports] of portsByMac) {
      for (const p of ports) {
        if (p.portIdx == null) continue;
        stmt.run(sourceId, mac, p.portIdx, p.up, p.speed, p.poePower, p.poeVoltage,
          p.rxBytes, p.txBytes, p.rxErrors, p.txErrors, p.rxDropped, p.txDropped);
      }
    }
    db.prepare("DELETE FROM unifi_port_history WHERE captured_at < datetime('now', '-30 days')").run();
  });
}

// ── Store: clients (per site) ───────────────────────────────────────────────

function buildStoreClients(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, site, clientRows) => {
    db.prepare('DELETE FROM unifi_clients WHERE source_id = ? AND site = ?').run(sourceId, site);
    const stmt = db.prepare(`
      INSERT INTO unifi_clients (source_id, site, mac, name, hostname, ip, is_wired, is_guest, network,
        essid, ap_mac, sw_mac, sw_port, channel, radio, rssi, signal, noise, satisfaction, tx_rate, rx_rate,
        wired_rate_mbps, uptime, tx_bytes, rx_bytes, oui)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of clientRows) {
      if (!c.mac) continue;
      stmt.run(sourceId, site, c.mac, c.name, c.hostname, c.ip, c.isWired, c.isGuest, c.network,
        c.essid, c.apMac, c.swMac, c.swPort, c.channel, c.radio, c.rssi, c.signal, c.noise, c.satisfaction,
        c.txRate, c.rxRate, c.wiredRateMbps, c.uptime, c.txBytes, c.rxBytes, c.oui);
    }
    // Membership ledger survives the replace above — first_seen powers the
    // new-devices-on-network insight.
    const seen = db.prepare(`
      INSERT INTO unifi_client_seen (source_id, mac, name, first_seen, last_seen)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(source_id, mac) DO UPDATE SET
        last_seen = datetime('now'), name = COALESCE(excluded.name, unifi_client_seen.name)
    `);
    for (const c of clientRows) {
      if (!c.mac) continue;
      seen.run(sourceId, c.mac, c.name || c.hostname || null);
    }
  });
}

// ── Store: source-wide sections (no site column) ────────────────────────────

function buildStoreWlans(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, rows) => {
    db.prepare('DELETE FROM unifi_wlans WHERE source_id = ?').run(sourceId);
    const stmt = db.prepare(`
      INSERT INTO unifi_wlans (source_id, wlan_id, name, enabled, security, wpa_mode, is_guest, hide_ssid, posture_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const w of rows) stmt.run(sourceId, w.wlanId, w.name, w.enabled, w.security, w.wpaMode, w.isGuest, w.hideSsid, w.postureJson);
  });
}

function buildStoreNetworks(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, rows) => {
    db.prepare('DELETE FROM unifi_networks WHERE source_id = ?').run(sourceId);
    const stmt = db.prepare(`
      INSERT INTO unifi_networks (source_id, network_id, name, purpose, vlan, subnet, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const n of rows) stmt.run(sourceId, n.networkId, n.name, n.purpose, n.vlan, n.subnet, n.enabled);
  });
}

function buildStoreRogueAps(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, rows) => {
    const seenBssids = rows.map((r) => r.bssid).filter(Boolean);
    const stmt = db.prepare(`
      INSERT INTO unifi_rogue_aps (source_id, bssid, essid, channel, signal, security, oui, is_rogue, last_seen, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(source_id, bssid) DO UPDATE SET
        essid = excluded.essid, channel = excluded.channel, signal = excluded.signal,
        security = excluded.security, oui = excluded.oui, is_rogue = excluded.is_rogue, last_seen = excluded.last_seen,
        first_seen_at = COALESCE(unifi_rogue_aps.first_seen_at, excluded.first_seen_at)
    `);
    for (const r of rows) {
      if (!r.bssid) continue;
      stmt.run(sourceId, r.bssid, r.essid, r.channel, r.signal, r.security, r.oui, r.isRogue, r.lastSeen);
    }
    if (seenBssids.length) {
      const placeholders = seenBssids.map(() => '?').join(',');
      db.prepare(`
        DELETE FROM unifi_rogue_aps WHERE source_id = ? AND bssid NOT IN (${placeholders})
          AND last_seen < CAST(strftime('%s', datetime('now', '-7 days')) AS INTEGER)
      `).run(sourceId, ...seenBssids);
    }
  });
}

function buildStoreFirewallRules(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, rows) => {
    db.prepare('DELETE FROM unifi_firewall_rules WHERE source_id = ?').run(sourceId);
    const stmt = db.prepare(`
      INSERT INTO unifi_firewall_rules (source_id, rule_id, kind, ruleset, rule_index, name, action, enabled,
        protocol, src, dst, logging, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      if (!r.ruleId) continue;
      stmt.run(sourceId, r.ruleId, r.kind, r.ruleset, r.ruleIndex, r.name, r.action, r.enabled,
        r.protocol, r.src, r.dst, r.logging, r.rawJson);
    }
  });
}

function buildStoreEvents(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, rows) => {
    const stmt = db.prepare(`
      INSERT INTO unifi_events (source_id, event_id, category, event_key, event_type, message, raw_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, event_id) DO UPDATE SET
        category = excluded.category, event_key = excluded.event_key, event_type = excluded.event_type,
        message = excluded.message, raw_json = excluded.raw_json, occurred_at = excluded.occurred_at
    `);
    for (const e of rows) {
      if (!e.eventId) continue;
      stmt.run(sourceId, e.eventId, e.category, e.eventKey, e.eventType, e.message, e.rawJson, e.occurredAt);
    }
    db.prepare("DELETE FROM unifi_events WHERE occurred_at IS NOT NULL AND occurred_at < datetime('now', '-30 days')").run();
  });
}

function buildStoreCameras(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, rows) => {
    db.prepare('DELETE FROM unifi_cameras WHERE source_id = ?').run(sourceId);
    const stmt = db.prepare(`
      INSERT INTO unifi_cameras (source_id, camera_id, model_key, name, mac, state, is_mic_enabled,
        video_mode, hdr_type, smart_detect_json, has_package_camera)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of rows) {
      if (!c.cameraId) continue;
      stmt.run(sourceId, c.cameraId, c.modelKey, c.name, c.mac, c.state, c.isMicEnabled,
        c.videoMode, c.hdrType, c.smartDetectJson, c.hasPackageCamera);
    }
  });
}

// ── WAN + metrics rollup ─────────────────────────────────────────────────────

function pickHealthSubsystem(health, name) {
  return (health || []).find((s) => s?.subsystem === name) || null;
}

function buildUpsertWan(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, wanFacts) => {
    db.prepare(`
      INSERT INTO unifi_wan (source_id, wan_name, isp_name, isp_organization, asn, wan_ip, gateway_ip,
        latency_ms, availability_pct, uptime_sec, drops, xput_down, xput_up, speedtest_ping, speedtest_down,
        speedtest_up, speedtest_at, uplink_media, uplink_speed, uplink_max_speed, tx_rate, rx_rate)
      VALUES (?, 'WAN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, wan_name) DO UPDATE SET
        isp_name=excluded.isp_name, isp_organization=excluded.isp_organization, asn=excluded.asn,
        wan_ip=excluded.wan_ip, gateway_ip=excluded.gateway_ip, latency_ms=excluded.latency_ms,
        availability_pct=excluded.availability_pct, uptime_sec=excluded.uptime_sec, drops=excluded.drops,
        xput_down=excluded.xput_down, xput_up=excluded.xput_up, speedtest_ping=excluded.speedtest_ping,
        speedtest_down=excluded.speedtest_down, speedtest_up=excluded.speedtest_up, speedtest_at=excluded.speedtest_at,
        uplink_media=excluded.uplink_media, uplink_speed=excluded.uplink_speed, uplink_max_speed=excluded.uplink_max_speed,
        tx_rate=excluded.tx_rate, rx_rate=excluded.rx_rate
    `).run(sourceId, wanFacts.ispName, wanFacts.ispOrganization, wanFacts.asn, wanFacts.wanIp, wanFacts.gatewayIp,
      wanFacts.latencyMs, wanFacts.availabilityPct, wanFacts.uptimeSec, wanFacts.drops, wanFacts.xputDown,
      wanFacts.xputUp, wanFacts.speedtestPing, wanFacts.speedtestDown, wanFacts.speedtestUp, wanFacts.speedtestAt,
      wanFacts.uplinkMedia, wanFacts.uplinkSpeed, wanFacts.uplinkMaxSpeed, wanFacts.txRate, wanFacts.rxRate);
  });
}

function buildWanFacts(health, gatewayParsed) {
  const wanSub = pickHealthSubsystem(health, 'wan');
  const wwwSub = pickHealthSubsystem(health, 'www');
  const wan1 = gatewayParsed?.wan1 || {};
  const uplink = gatewayParsed?.uplink || {};
  const speedtest = gatewayParsed?.speedtestStatus || {};
  const rawAvail = api.numOrNull(wan1.availability);
  return {
    ispName: wanSub?.isp_name ?? null,
    ispOrganization: wanSub?.isp_organization ?? null,
    asn: api.numOrNull(wanSub?.asn),
    wanIp: wanSub?.wan_ip ?? null,
    gatewayIp: Array.isArray(wanSub?.gateways) ? (wanSub.gateways[0] ?? null) : null,
    latencyMs: api.numOrNull(wwwSub?.latency ?? wan1.latency),
    availabilityPct: rawAvail != null ? (rawAvail <= 1 ? rawAvail * 100 : rawAvail) : null,
    uptimeSec: api.numOrNull(uplink.uptime),
    drops: api.numOrNull(wwwSub?.drops ?? uplink.drops),
    xputDown: api.numOrNull(wwwSub?.xput_down ?? uplink.xput_down),
    xputUp: api.numOrNull(wwwSub?.xput_up ?? uplink.xput_up),
    speedtestPing: api.numOrNull(wwwSub?.speedtest_ping ?? uplink.speedtest_ping ?? speedtest.ping),
    speedtestDown: api.numOrNull(speedtest.download ?? speedtest.xput_download),
    speedtestUp: api.numOrNull(speedtest.upload ?? speedtest.xput_upload),
    speedtestAt: api.numOrNull(wwwSub?.speedtest_lastrun ?? uplink.speedtest_lastrun),
    uplinkMedia: wan1.media ?? null,
    uplinkSpeed: api.numOrNull(wan1.speed),
    uplinkMaxSpeed: api.numOrNull(wan1.max_speed),
    txRate: api.numOrNull(uplink.tx_rate),
    rxRate: api.numOrNull(uplink.rx_rate),
  };
}

function buildAppendMetricsHistory(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, m) => {
    db.prepare(`
      INSERT INTO unifi_metrics_history (source_id, devices_total, devices_online, clients_total, clients_wired,
        clients_wireless, clients_guest, wan_latency_ms, wan_availability_pct, wan_tx_rate, wan_rx_rate,
        gw_cpu_pct, gw_mem_pct, max_temp_c)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sourceId, m.devicesTotal, m.devicesOnline, m.clientsTotal, m.clientsWired, m.clientsWireless,
      m.clientsGuest, m.wanLatencyMs, m.wanAvailabilityPct, m.wanTxRate, m.wanRxRate, m.gwCpuPct, m.gwMemPct,
      m.maxTempC ?? null);
    db.prepare("DELETE FROM unifi_metrics_history WHERE captured_at < datetime('now', '-90 days')").run();
  });
}

// ── Collect + store per source ──────────────────────────────────────────────

async function pollSource(source, coreApi) {
  const db = coreApi.db;
  const storeDevices = buildStoreDevices(coreApi);
  const storePorts = buildStorePorts(coreApi);
  const appendPortHistory = buildAppendPortHistory(coreApi);
  const storeClients = buildStoreClients(coreApi);
  const storeWlans = buildStoreWlans(coreApi);
  const storeNetworks = buildStoreNetworks(coreApi);
  const storeRogueAps = buildStoreRogueAps(coreApi);
  const storeFirewallRules = buildStoreFirewallRules(coreApi);
  const storeEvents = buildStoreEvents(coreApi);
  const storeCameras = buildStoreCameras(coreApi);
  const upsertWan = buildUpsertWan(coreApi);
  const appendMetricsHistory = buildAppendMetricsHistory(coreApi);

  try {
    const sites = await api.fetchSites(source, coreApi);
    const info = await trySection(coreApi, 'info', () => api.fetchInfo(source, coreApi));
    if (!sites.length) throw new Error('no sites returned');

    const wlanRows = [];
    const networkRows = [];
    const rogueApRows = [];
    const eventRows = [];
    const firewallRows = [];
    let lastHealth = null;
    let lastIps = null;
    let lastTopology = null;
    let gatewayParsed = null;

    // Feature-module toggles: disabled modules are not queried at all.
    const wifiOn = featureEnabled(coreApi, 'wifi');
    const securityOn = featureEnabled(coreApi, 'security');
    const protectOn = featureEnabled(coreApi, 'protect');

    for (let i = 0; i < sites.length; i++) {
      const site = sites[i].internalReference || sites[i].id || 'default';
      const isFirst = i === 0;

      const parsedDevices = await trySection(coreApi, `devices (${site})`, () => api.fetchDevices(source, coreApi, site), { required: isFirst });
      if (parsedDevices) {
        storeDevices(source.id, site, parsedDevices.map((p) => p.device));
        const macs = parsedDevices.map((p) => p.device.mac).filter(Boolean);
        const portsByMac = new Map(parsedDevices.filter((p) => p.device.mac).map((p) => [p.device.mac, p.ports]));
        storePorts(source.id, macs, portsByMac);
        appendPortHistory(source.id, portsByMac);
        const gw = parsedDevices.find((p) => p.device.isGateway === 1);
        if (gw) gatewayParsed = gw;
      }

      const clients = await trySection(coreApi, `clients (${site})`, () => api.fetchClients(source, coreApi, site));
      if (clients) storeClients(source.id, site, clients);

      const wlans = wifiOn ? await trySection(coreApi, `wlans (${site})`, () => api.fetchWlans(source, coreApi, site)) : undefined;
      if (wlans) wlanRows.push(...wlans);

      const networks = await trySection(coreApi, `networks (${site})`, () => api.fetchNetworks(source, coreApi, site));
      if (networks) networkRows.push(...networks);

      const rogues = wifiOn ? await trySection(coreApi, `rogueap (${site})`, () => api.fetchRogueAps(source, coreApi, site)) : undefined;
      if (rogues) rogueApRows.push(...rogues);

      const ips = securityOn ? await trySection(coreApi, `ips (${site})`, () => api.fetchIpsSettings(source, coreApi, site)) : undefined;
      if (ips) lastIps = ips;

      const health = await trySection(coreApi, `health (${site})`, () => api.fetchHealth(source, coreApi, site));
      if (health) lastHealth = health;

      const firewall = securityOn ? await trySection(coreApi, `firewall (${site})`, () => api.fetchFirewallRules(source, coreApi, site)) : undefined;
      if (firewall) firewallRows.push(...firewall.firewall, ...firewall.traffic);

      const log = await trySection(coreApi, `system-log (${site})`, () => api.fetchSystemLog(source, coreApi, site));
      if (log) eventRows.push(...log);

      const topo = await trySection(coreApi, `topology (${site})`, () => api.fetchTopology(source, coreApi, site));
      if (topo) lastTopology = topo;
    }

    if (wlanRows.length || db.prepare('SELECT COUNT(*) n FROM unifi_wlans WHERE source_id = ?').get(source.id).n) storeWlans(source.id, wlanRows);
    if (networkRows.length || db.prepare('SELECT COUNT(*) n FROM unifi_networks WHERE source_id = ?').get(source.id).n) storeNetworks(source.id, networkRows);
    if (rogueApRows.length) storeRogueAps(source.id, rogueApRows);
    if (eventRows.length) storeEvents(source.id, eventRows);
    if (firewallRows.length || db.prepare('SELECT COUNT(*) n FROM unifi_firewall_rules WHERE source_id = ?').get(source.id).n) storeFirewallRules(source.id, firewallRows);
    if (lastTopology) {
      db.prepare(`
        INSERT INTO unifi_topology (source_id, captured_at, vertices_json, edges_json, has_unknown_switch)
        VALUES (?, datetime('now'), ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          captured_at = excluded.captured_at, vertices_json = excluded.vertices_json,
          edges_json = excluded.edges_json, has_unknown_switch = excluded.has_unknown_switch
      `).run(source.id, api.jsonOrNull(lastTopology.vertices), api.jsonOrNull(lastTopology.edges), lastTopology.hasUnknownSwitch);
    }

    // Protect is optional per controller — a miss here is "not installed", never a
    // poll error, and an absent app clears any previously stored cameras.
    let protect = null;
    if (protectOn) {
      try { protect = await api.fetchProtect(source, coreApi); } catch { protect = null; }
    }
    storeCameras(source.id, protect ? protect.cameras : []);

    const wanFacts = buildWanFacts(lastHealth, gatewayParsed);
    upsertWan(source.id, wanFacts);

    const devTotals = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) online FROM unifi_devices WHERE source_id = ?').get(source.id);
    const cliTotals = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN is_wired = 1 THEN 1 ELSE 0 END) wired,
        SUM(CASE WHEN is_wired = 0 THEN 1 ELSE 0 END) wireless, SUM(CASE WHEN is_guest = 1 THEN 1 ELSE 0 END) guest
      FROM unifi_clients WHERE source_id = ?
    `).get(source.id);
    appendMetricsHistory(source.id, {
      devicesTotal: devTotals.total || 0,
      devicesOnline: devTotals.online || 0,
      clientsTotal: cliTotals.total || 0,
      clientsWired: cliTotals.wired || 0,
      clientsWireless: cliTotals.wireless || 0,
      clientsGuest: cliTotals.guest || 0,
      wanLatencyMs: wanFacts.latencyMs,
      wanAvailabilityPct: wanFacts.availabilityPct,
      wanTxRate: wanFacts.txRate,
      wanRxRate: wanFacts.rxRate,
      gwCpuPct: gatewayParsed?.device?.cpuPct ?? null,
      gwMemPct: gatewayParsed?.device?.memPct ?? null,
      maxTempC: (() => {
        let max = null;
        for (const d of db.prepare('SELECT temps_json FROM unifi_devices WHERE source_id = ? AND temps_json IS NOT NULL').all(source.id)) {
          try {
            for (const t of JSON.parse(d.temps_json) || []) {
              const v = Number(t?.value);
              if (Number.isFinite(v) && (max == null || v > max)) max = v;
            }
          } catch { /* tolerate malformed temps */ }
        }
        return max;
      })(),
    });

    const healthJson = api.jsonOrNull({
      subsystems: lastHealth || [],
      ips: lastIps || null,
      protect: protect ? { applicationVersion: protect.applicationVersion, nvr: protect.nvr } : null,
    });
    db.prepare(`
      UPDATE unifi_sources SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now'), sites_json = ?, controller_version = ?, health_json = ? WHERE id = ?
    `).run(api.jsonOrNull(sites), info?.applicationVersion || null, healthJson, source.id);

    coreApi.logger.info(`[UnifiPoller] ${source.name}: ${sites.length} site(s), ${devTotals.total || 0} device(s), ${cliTotals.total || 0} client(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE unifi_sources SET last_poll_status = 'error', last_poll_error = ?, last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), source.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[UnifiPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

function buildPoller(coreApi) {
  return coreApi.createPoller({
    id: 'unifi',
    loadSources: () => coreApi.db.prepare('SELECT * FROM unifi_sources').all(),
    intervalMinutes: (s) => s.polling_interval_minutes,
    poll: (source) => pollSource(source, coreApi),
  });
}

/** Shared singleton source poller (schedule/cancel/trigger/init/stopAll),
 *  built lazily on first access regardless of whether createRouter or
 *  manifest.createPoller reaches it first. */
function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js), so demo timestamps
 *  stay relative to boot. Real instances never seed. Returns a handle
 *  mirroring the built-in's createUnifiPollerHandle() shape. */
function createUnifiPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    try {
      const { seedUnifiDemo } = require('./demoSeed');
      const r = seedUnifiDemo(coreApi);
      coreApi.logger.info(`[UnifiPoller] demo estate seeded: ${r.sources} sources, ${r.devices} devices, ${r.clients} clients`);
    } catch (err) {
      coreApi.logger.warn(`[UnifiPoller] demo seed failed: ${err.message}`);
    }
  }

  const unifiPoller = getPoller(coreApi);

  return {
    init: () => {
      const sources = unifiPoller.init();
      coreApi.logger.info(`[UnifiPoller] Initialized ${sources.length} source(s)`);
      return sources;
    },
    stopAll: () => unifiPoller.stopAll(),
    trigger: (sourceOrId) => {
      const source = typeof sourceOrId === 'object' ? sourceOrId : coreApi.db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(sourceOrId);
      return source ? unifiPoller.trigger(source) : Promise.resolve();
    },
    schedule: (source) => unifiPoller.schedule(source),
    cancel: (sourceId) => unifiPoller.cancel(sourceId),
    taskCount: () => unifiPoller.taskCount(),
  };
}

module.exports = { createUnifiPoller, getPoller, pollSource };
