// Brocade SAN (SANnav) scope demo data: 2 SANnav sources ("SanNav Prod" +
// "SanNav DR") with 4 fabrics, 14 switches, ~350 switch ports, ~80 device
// ports across ~30 enclosures, zoning (configs/zones/aliases/changes),
// health scores, ~200 events, hourly metrics history, and deliberate
// trouble exercising EVERY rule in issues.js: a critical switch (BAD_PWR),
// an unreachable switch, a switch with other nonzero management_state bits,
// a marginal fabric, a sub-50 + sub-70 health score, 2 fenced + 1 blocked
// port, a cert expiring in 20 days + one already expired (chassis), an EOS
// switch, firmware drift within a fabric, a fabric with
// default_zone_access=1, a zone change inside the last 24h, a switch in
// maintenance mode, an event storm (>=12 critical/alert events in the last
// hour on one source), and a failed poll on the DR source. A few enclosure
// host_name values mirror the vcenter demo VM/host names (aria suite VMs +
// nyc-esx-0101.icc.demo) for cross-platform Server 360 hits.
//
// Ported from backend/demo/generators/brocade.js. ALL inserts here run ONLY
// behind the DASHBOARD_DEMO==='1' gate — see seedBrocadeDemo() below, called
// from poller.js's manifest createPoller(coreApi) entry point on every boot
// in demo mode. Only the seeded-random helpers were copied from the host's
// demo/generators/core.js (./demoRng.js) — no seedCore/encryption requires.
// Credential encryption uses coreApi.encryption.encrypt (dell/unifi plugin
// demoSeed.js precedent) instead of requiring the host's encryption service
// directly.
//
// DEVIATION FROM THE BUILT-IN's wipe strategy: brocade_sources itself is
// NEVER wiped/deleted (it is the user-facing connection table — an admin
// could register a real SANnav source on a demo instance and that must
// survive a reseed). Instead the two fixture sources are upserted by name
// so their id stays stable across boots, and only THEIR dependent rows
// (scoped by source_id) are wiped before reseeding — any independently-
// registered real source's data is untouched.
const { randInt, randFloat, pick, chance, rngFor } = require('./demoRng');

function wwn(rng, prefix = '10:00:00:05:1e') {
  const byte = () => Math.floor(rng() * 256).toString(16).padStart(2, '0');
  return `${prefix}:${byte()}:${byte()}:${byte()}`;
}

const SOURCES = [
  { name: 'SanNav Prod', host: 'sannav-prod.icc.demo', pollStatus: 'success', pollError: null },
  { name: 'SanNav DR', host: 'sannav-dr.icc.demo', pollStatus: 'error', pollError: 'connect ETIMEDOUT sannav-dr.icc.demo:443' },
];

const FABRIC_DEFS = [
  { key: 'PA', source: 'SanNav Prod', name: 'PROD-A', status: 1, health: 'Healthy' },
  { key: 'PB', source: 'SanNav Prod', name: 'PROD-B', status: 2, health: 'Marginal' },
  { key: 'DA', source: 'SanNav DR', name: 'DR-A', status: 1, health: 'Healthy' },
  { key: 'DB', source: 'SanNav DR', name: 'DR-B', status: 1, health: 'Healthy' },
];

// Switch plan per fabric. portCount is model-derived below.
const SWITCH_DEFS = [
  { key: 'sw1', fabric: 'PA', name: 'PROD-A-SW01', model: 'G720', role: 'Principal', fw: 'v9.1.1b2' },
  { key: 'sw2', fabric: 'PA', name: 'PROD-A-SW02', model: 'G720', role: 'Subordinate', fw: 'v9.2.0a' },
  { key: 'sw3', fabric: 'PA', name: 'PROD-A-SW03', model: 'G630', role: 'Subordinate', fw: 'v9.1.1b2', fenced: 5 },
  { key: 'sw4', fabric: 'PA', name: 'PROD-A-SW04', model: 'G630', role: 'Subordinate', fw: 'v9.1.1b2', critical: true },
  { key: 'sw5', fabric: 'PB', name: 'PROD-B-SW01', model: 'X6-8', role: 'Principal', fw: 'v9.1.1b2' },
  { key: 'sw6', fabric: 'PB', name: 'PROD-B-SW02', model: 'X6-8', role: 'Subordinate', fw: 'v9.1.1b2', mgmtStateBits: 4 },
  { key: 'sw7', fabric: 'PB', name: 'PROD-B-SW03', model: 'G720', role: 'Subordinate', fw: 'v9.1.1b2', unreachable: true, fenced: 3 },
  { key: 'sw8', fabric: 'PB', name: 'PROD-B-SW04', model: 'G720', role: 'Subordinate', fw: 'v9.1.1b2' },
  { key: 'sw9', fabric: 'DA', name: 'DR-A-SW01', model: 'G720', role: 'Principal', fw: 'v9.2.0a', blocked: 2 },
  { key: 'sw10', fabric: 'DA', name: 'DR-A-SW02', model: 'G630', role: 'Subordinate', fw: 'v9.1.1b2', eos: true },
  { key: 'sw11', fabric: 'DA', name: 'DR-A-SW03', model: 'G630', role: 'Subordinate', fw: 'v9.1.1b2', marginal: true },
  { key: 'sw12', fabric: 'DB', name: 'DR-B-SW01', model: 'X6-8', role: 'Principal', fw: 'v9.1.1b2', certExpiringDays: 20 },
  { key: 'sw13', fabric: 'DB', name: 'DR-B-SW02', model: 'G720', role: 'Subordinate', fw: 'v9.1.1b2', maintenance: true },
  { key: 'sw14', fabric: 'DB', name: 'DR-B-SW03', model: 'G720', role: 'Subordinate', fw: 'v9.1.1b2' },
];

const PORT_COUNT_BY_MODEL = { G720: 24, G630: 16, 'X6-8': 32 };

const EVENT_MESSAGE_IDS = ['FSPF-1006', 'C2-1010', 'ZONE-1013', 'PORT-1003', 'SEC-1015', 'SW-1021', 'FAB-1004', 'MAPS-1050'];
const SEVERITIES = [
  { severity: 'Critical', norm: 'critical', weight: 3 },
  { severity: 'Major', norm: 'major', weight: 2 },
  { severity: 'Warning', norm: 'warning', weight: 4 },
  { severity: 'Info', norm: 'info', weight: 6 },
];

function weightedSeverity(rng) {
  const total = SEVERITIES.reduce((a, s) => a + s.weight, 0);
  let r = rng() * total;
  for (const s of SEVERITIES) {
    if (r < s.weight) return s;
    r -= s.weight;
  }
  return SEVERITIES[SEVERITIES.length - 1];
}

// Children scoped by source_id — brocade_sources itself is NEVER wiped (see
// module header). No cross-references between these tables, so wipe order
// is not FK-critical, but grouped roughly leaves-first for clarity.
const DEMO_CHILD_TABLES = [
  'brocade_port_stats', 'brocade_metrics', 'brocade_issue_history', 'brocade_fcr_routes',
  'brocade_zone_changes', 'brocade_zone_aliases', 'brocade_zones', 'brocade_zone_configs',
  'brocade_health_scores', 'brocade_events', 'brocade_chassis', 'brocade_enclosures',
  'brocade_device_ports', 'brocade_switch_ports', 'brocade_switches', 'brocade_fabrics',
];

function seedBrocade(db, { now, encrypt }) {
  const agoStmt = db.prepare("SELECT datetime('now', ?) d");
  const ago = (offset) => agoStmt.get(offset).d;
  const nowIso = new Date(now).toISOString();

  const setDemoSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  setDemoSetting.run('platform_brocade_enabled');

  // Upsert the two fixture sources by name so their id stays stable across
  // reseeds (brocade_sources is never deleted — see module header).
  const upsertSource = db.prepare(`
    INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl, enabled,
      polling_interval_minutes, event_poll_minutes, fos_proxy_enabled, sannav_version, oem_name,
      last_poll_at, last_poll_status, last_poll_error, last_event_poll_at, event_cursor_ms,
      section_errors, password_policy_json, users_json, roles_json, aors_json, created_at)
    VALUES (@name, @host, 443, 'admin', @password_enc, 0, 1,
      60, 5, 1, @sannav_version, @oem_name,
      @last_poll_at, @last_poll_status, @last_poll_error, @last_event_poll_at, @event_cursor_ms,
      NULL, @password_policy_json, @users_json, @roles_json, @aors_json, @created_at)
    ON CONFLICT(name) DO UPDATE SET
      host = excluded.host, password_enc = excluded.password_enc,
      sannav_version = excluded.sannav_version, oem_name = excluded.oem_name,
      last_poll_at = excluded.last_poll_at, last_poll_status = excluded.last_poll_status,
      last_poll_error = excluded.last_poll_error, last_event_poll_at = excluded.last_event_poll_at,
      event_cursor_ms = excluded.event_cursor_ms, password_policy_json = excluded.password_policy_json,
      users_json = excluded.users_json, roles_json = excluded.roles_json, aors_json = excluded.aors_json
  `);
  const getSourceId = db.prepare('SELECT id FROM brocade_sources WHERE name = ?');

  const insertFabric = db.prepare(`
    INSERT INTO brocade_fabrics (source_id, sannav_id, guid, name, principal_switch_wwn,
      seed_switch_wwn, seed_switch_ip, seed_switch_name, seed_switch_firmware, status, health,
      switch_count, active_zoneset_name, managed, virtual_fabric_id, management_state,
      last_fabric_changed, stale, raw_json)
    VALUES (@source_id, @sannav_id, @guid, @name, @principal_switch_wwn,
      @seed_switch_wwn, @seed_switch_ip, @seed_switch_name, @seed_switch_firmware, @status, @health,
      @switch_count, @active_zoneset_name, 1, -1, 0,
      @last_fabric_changed, 0, @raw_json)
  `);
  const insertSwitch = db.prepare(`
    INSERT INTO brocade_switches (source_id, sannav_id, wwn, name, physical_switch_wwn, ip_address,
      model, model_number, firmware_version, serial_number, fabric_name, principal_switch_wwn,
      domain_id, role, state, status, operational_status, health, status_reason, is_missing,
      monitored, discovered_port_count, max_port, switch_mode, management_state, eos_status,
      maintenance_mode, tls_cert_expiry_ms, trufos_status, virtual_fabric_id, chassis_type, vendor,
      stale, raw_json)
    VALUES (@source_id, @sannav_id, @wwn, @name, @physical_switch_wwn, @ip_address,
      @model, @model_number, @firmware_version, @serial_number, @fabric_name, @principal_switch_wwn,
      @domain_id, @role, @state, @status, @operational_status, @health, @status_reason, @is_missing,
      1, @discovered_port_count, @max_port, 0, @management_state, @eos_status,
      @maintenance_mode, @tls_cert_expiry_ms, 0, -1, 1, 'Brocade',
      0, @raw_json)
  `);
  const insertPort = db.prepare(`
    INSERT INTO brocade_switch_ports (source_id, sannav_id, wwn, switch_wwn, switch_name, name,
      slot_number, port_number, port_index, port_id, type, state, status, health, calculated_status,
      status_message, speed, speed_type, max_port_speed, remote_device, remote_port_wwn,
      remote_node_wwn, connected_device_type, trunked, trunk_master, fenced, blocked,
      persistent_disable, is_missing, monitored, occupied, licensed, last_update_ms,
      active_zone_count, zone_alias, fabric_name, virtual_fabric_id, stale)
    VALUES (@source_id, @sannav_id, @wwn, @switch_wwn, @switch_name, @name,
      0, @port_number, @port_number, @port_id, @type, @state, @status, @health, @calculated_status,
      @status_message, @speed, 1, 32000, @remote_device, @remote_port_wwn,
      @remote_node_wwn, @connected_device_type, 0, 0, @fenced, @blocked,
      0, 0, 1, @occupied, 1, @last_update_ms,
      @active_zone_count, NULL, @fabric_name, -1, 0)
  `);
  const insertDevicePort = db.prepare(`
    INSERT INTO brocade_device_ports (source_id, sannav_id, wwn, device_node_wwn, symbolic_name,
      device_symbolic_name, vendor, port_role, type, fabric_name, switch_wwn, switch_name,
      switch_port_wwn, switch_port_name, slot_number, port_number, port_id, enclosure_id,
      enclosure_guid, enclosure_name, fdmi_host_name, active_zones, active_zone_count,
      active_zoneset_name, zone_alias, is_missing, speed, stale)
    VALUES (@source_id, @sannav_id, @wwn, @device_node_wwn, @symbolic_name,
      @device_symbolic_name, @vendor, @port_role, @type, @fabric_name, @switch_wwn, @switch_name,
      @switch_port_wwn, @switch_port_name, 0, @port_number, @port_id, @enclosure_id,
      @enclosure_guid, @enclosure_name, @fdmi_host_name, @active_zones, @active_zone_count,
      @active_zoneset_name, NULL, 0, @speed, 0)
  `);
  const insertEnclosure = db.prepare(`
    INSERT INTO brocade_enclosures (source_id, sannav_id, guid, name, type, host_name, ip_address,
      vendor, model, health, location, contact, tags, stale, raw_json)
    VALUES (@source_id, @sannav_id, @guid, @name, @type, @host_name, @ip_address,
      @vendor, @model, @health, @location, @contact, @tags, 0, @raw_json)
  `);
  const insertChassis = db.prepare(`
    INSERT INTO brocade_chassis (source_id, switch_id, wwn, name, ip_address, model_number, firmware,
      serial_number, part_number, vendor, max_port, num_virtual_switches, max_virtual_switches,
      tls_cert_expiry_ms, stale, raw_json)
    VALUES (@source_id, @switch_id, @wwn, @name, @ip_address, @model_number, @firmware,
      @serial_number, @part_number, 'Brocade', @max_port, 1, 8,
      @tls_cert_expiry_ms, 0, @raw_json)
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO brocade_events (source_id, event_id, severity, severity_norm,
      event_category, source_name, source_address, source_type, source_wwn, fabric_name,
      message_id, origin, module, description, event_count, first_occurred_ms, last_occurred_ms,
      acknowledged, ack_by, ack_notes, acked_time_ms, product_name, product_address, port_wwn)
    VALUES (@source_id, @event_id, @severity, @severity_norm,
      @event_category, @source_name, @source_address, @source_type, @source_wwn, @fabric_name,
      @message_id, @origin, @module, @description, 1, @first_occurred_ms, @last_occurred_ms,
      @acknowledged, @ack_by, @ack_notes, @acked_time_ms, 'SANnav', @source_address, @port_wwn)
  `);
  const insertHealthScore = db.prepare(`
    INSERT INTO brocade_health_scores (source_id, entity_type, entity_name, entity_guid, entity_wwn,
      entity_ip, fid, fabric_name, score, status, computation_time, computation_ms,
      contributors_json, stale)
    VALUES (@source_id, @entity_type, @entity_name, @entity_guid, @entity_wwn,
      @entity_ip, 128, @fabric_name, @score, @status, @computation_time, @computation_ms,
      @contributors_json, 0)
  `);
  const insertZoneConfig = db.prepare(`
    INSERT INTO brocade_zone_configs (source_id, fabric_name, cfg_name, is_effective, member_zones,
      default_zone_access, checksum, db_max, db_avail, db_committed, stale)
    VALUES (@source_id, @fabric_name, @cfg_name, @is_effective, @member_zones,
      @default_zone_access, @checksum, 1000000, 850000, @db_committed, 0)
  `);
  const insertZone = db.prepare(`
    INSERT INTO brocade_zones (source_id, fabric_name, zone_name, zone_type, zone_type_string,
      members, in_effective, stale)
    VALUES (@source_id, @fabric_name, @zone_name, @zone_type, @zone_type_string,
      @members, @in_effective, 0)
  `);
  const insertAlias = db.prepare(`
    INSERT INTO brocade_zone_aliases (source_id, fabric_name, alias_name, members, stale)
    VALUES (@source_id, @fabric_name, @alias_name, @members, 0)
  `);
  const insertZoneChange = db.prepare(`
    INSERT INTO brocade_zone_changes (source_id, fabric_name, change_type, detail, old_value,
      new_value, detected_at)
    VALUES (@source_id, @fabric_name, @change_type, @detail, @old_value, @new_value, @detected_at)
  `);
  const insertFcrRoute = db.prepare(`
    INSERT INTO brocade_fcr_routes (source_id, backbone_fabric_id, backbone_wwn, backbone_ip,
      edge_fabrics, stale)
    VALUES (@source_id, @backbone_fabric_id, @backbone_wwn, @backbone_ip, @edge_fabrics, 0)
  `);
  const insertMetric = db.prepare(`
    INSERT INTO brocade_metrics (source_id, fabrics_total, fabrics_healthy, switches_total,
      switches_healthy, switches_marginal, switches_critical, switches_unreachable, ports_total,
      ports_online, ports_offline, ports_error, ports_occupied, device_ports_total,
      enclosures_total, hosts_total, storage_total, zones_total, aliases_total, avg_fabric_health,
      min_fabric_health, events_critical_24h, events_warning_24h, ts)
    VALUES (@source_id, @fabrics_total, @fabrics_healthy, @switches_total,
      @switches_healthy, @switches_marginal, @switches_critical, @switches_unreachable, @ports_total,
      @ports_online, @ports_offline, @ports_error, @ports_occupied, @device_ports_total,
      @enclosures_total, @hosts_total, @storage_total, @zones_total, @aliases_total, @avg_fabric_health,
      @min_fabric_health, @events_critical_24h, @events_warning_24h, @ts)
  `);
  const insertIssueHistory = db.prepare(`
    INSERT INTO brocade_issue_history (source_id, source, type, target, severity, message,
      first_seen, last_seen, resolved_at)
    VALUES (@source_id, @source, @type, @target, @severity, @message,
      @first_seen, @last_seen, @resolved_at)
  `);

  // ── Sources (upsert by name, id stable across reseeds) ─────────────────
  const sourceIds = {};
  SOURCES.forEach((s) => {
    const rng = rngFor(`brocade-source-${s.name}`);
    upsertSource.run({
      name: s.name, host: s.host,
      password_enc: encrypt('demo-not-real'),
      sannav_version: '3.0.0x', oem_name: 'Brocade',
      last_poll_at: ago(`-${randInt(rng, 4, 25)} minutes`),
      last_poll_status: s.pollStatus, last_poll_error: s.pollError,
      last_event_poll_at: ago(`-${randInt(rng, 1, 4)} minutes`),
      event_cursor_ms: now - randInt(rng, 30000, 120000),
      password_policy_json: JSON.stringify({ minLength: '8', maxAge: '90', historyCount: '5', lockoutThreshold: '5' }),
      users_json: JSON.stringify([
        { userName: 'admin', role: 'Admin', accountStatus: 'Active' },
        { userName: 'operator1', role: 'Operator', accountStatus: 'Active' },
      ]),
      roles_json: JSON.stringify([{ roleName: 'Admin' }, { roleName: 'Operator' }, { roleName: 'Viewer' }]),
      aors_json: JSON.stringify([{ name: 'default-AOR', description: 'Default area of responsibility' }]),
      created_at: nowIso,
    });
    sourceIds[s.name] = getSourceId.get(s.name).id;
  });

  // Wipe THESE fixtures' dependent rows only, before regenerating — any
  // independently-registered real source's data is untouched.
  const fixtureIds = Object.values(sourceIds);
  const placeholders = fixtureIds.map(() => '?').join(',');
  for (const table of DEMO_CHILD_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE source_id IN (${placeholders})`).run(...fixtureIds);
  }

  // ── Fabrics ──────────────────────────────────────────────────────────
  const fabricIds = {};
  const fabricByKey = {};
  FABRIC_DEFS.forEach((f, i) => {
    const rng = rngFor(`brocade-fabric-${f.key}`);
    const seedWwn = wwn(rng);
    const raw = { name: f.name, status: f.status };
    const info = insertFabric.run({
      source_id: sourceIds[f.source], sannav_id: i + 1, guid: `fabric-guid-${f.key.toLowerCase()}`,
      name: f.name, principal_switch_wwn: seedWwn, seed_switch_wwn: seedWwn,
      seed_switch_ip: `10.${20 + i}.1.1`, seed_switch_name: `${f.name}-SW01`,
      seed_switch_firmware: 'v9.1.1b2', status: f.status, health: f.health,
      switch_count: SWITCH_DEFS.filter((s) => s.fabric === f.key).length,
      active_zoneset_name: `${f.name}_EFF_CFG`,
      last_fabric_changed: ago(`-${randInt(rng, 1, 20)} hours`),
      raw_json: JSON.stringify(raw),
    });
    fabricIds[f.key] = info.lastInsertRowid;
    fabricByKey[f.key] = f;
  });

  // ── Switches + ports + chassis ──────────────────────────────────────
  const switchByKey = {};
  let switchTotal = 0, portTotal = 0, chassisTotal = 0;
  SWITCH_DEFS.forEach((sw, i) => {
    const fabric = fabricByKey[sw.fabric];
    const sourceId = sourceIds[fabric.source];
    const rng = rngFor(`brocade-switch-${sw.key}`);
    const swWwn = wwn(rng);
    const ip = `10.${20 + FABRIC_DEFS.findIndex((f) => f.key === sw.fabric)}.1.${10 + i}`;
    const operationalStatus = sw.critical ? 'CRITICAL' : sw.marginal ? 'MARGINAL' : 'HEALTHY';
    const managementState = sw.unreachable ? 16 : (sw.mgmtStateBits || 0);
    const certExpiryMs = sw.certExpiringDays != null
      ? now + sw.certExpiringDays * 86400000
      : now + randInt(rng, 200, 700) * 86400000;
    const portCount = PORT_COUNT_BY_MODEL[sw.model];
    const raw = { name: sw.name, model: sw.model, firmwareVersion: sw.fw };
    const info = insertSwitch.run({
      source_id: sourceId, sannav_id: 1000 + i, wwn: swWwn, name: sw.name,
      physical_switch_wwn: swWwn, ip_address: ip, model: sw.model, model_number: sw.model,
      firmware_version: sw.fw, serial_number: `${sw.model}${randInt(rng, 100000, 999999)}`,
      fabric_name: fabric.name, principal_switch_wwn: fabric.status ? swWwn : null,
      domain_id: i + 1, role: sw.role, state: 'Online',
      status: sw.critical ? 'Critical' : sw.marginal ? 'Marginal' : 'Healthy',
      operational_status: operationalStatus,
      health: sw.critical ? 'critical' : sw.marginal ? 'marginal' : 'healthy',
      status_reason: sw.critical ? 'BAD_PWR' : null,
      is_missing: sw.unreachable ? 1 : 0,
      discovered_port_count: portCount, max_port: portCount,
      management_state: managementState, eos_status: sw.eos ? 1 : 0,
      maintenance_mode: sw.maintenance ? 1 : 0, tls_cert_expiry_ms: certExpiryMs,
      raw_json: JSON.stringify(raw),
    });
    switchByKey[sw.key] = { ...sw, id: info.lastInsertRowid, wwn: swWwn, fabricName: fabric.name, sourceId, portCount, ip };
    switchTotal++;

    // Chassis (1 per switch; sw2 in PROD-A carries an already-expired cert
    // to trigger the critical branch of the cert_expiring rule).
    const chassisCertExpiry = sw.key === 'sw2' ? now - 5 * 86400000 : certExpiryMs;
    insertChassis.run({
      source_id: sourceId, switch_id: info.lastInsertRowid, wwn: swWwn, name: sw.name,
      ip_address: ip, model_number: sw.model, firmware: sw.fw,
      serial_number: `${sw.model}${randInt(rng, 100000, 999999)}`,
      part_number: `60-${randInt(rng, 1000000, 9999999)}-01`, max_port: portCount,
      tls_cert_expiry_ms: chassisCertExpiry,
      raw_json: JSON.stringify({ name: sw.name }),
    });
    chassisTotal++;

    // Ports
    const ports = [];
    for (let p = 1; p <= portCount; p++) {
      const isFenced = sw.fenced === p;
      const isBlocked = sw.blocked === p;
      const offline = !isFenced && !isBlocked && chance(rng, 0.15);
      const online = !offline;
      const hasDevice = online && !isFenced && !isBlocked && chance(rng, 0.55);
      ports.push({
        port_number: p, port_id: `${p.toString(16).padStart(2, '0')}0000`,
        wwn: wwn(rng), type: hasDevice ? 'F-Port' : (p <= 2 ? 'E-Port' : 'F-Port'),
        state: online ? 'Online' : 'Offline', status: online ? 'Online' : 'No_Light',
        health: isFenced || isBlocked ? 'error' : online ? 'healthy' : 'unknown',
        calculated_status: isFenced ? 'Fenced' : isBlocked ? 'Blocked' : (online ? 'Online' : 'Offline'),
        status_message: isFenced ? 'Port fenced due to excessive errors' : isBlocked ? 'Port administratively blocked' : null,
        speed: online ? pick(rng, ['8Gbps', '16Gbps', '32Gbps']) : '0',
        remote_device: hasDevice ? `device-${randInt(rng, 1, 999)}` : null,
        remote_port_wwn: hasDevice ? wwn(rng) : null,
        remote_node_wwn: hasDevice ? wwn(rng) : null,
        connected_device_type: hasDevice ? pick(rng, ['Host', 'Storage']) : null,
        fenced: isFenced ? 1 : 0, blocked: isBlocked ? 1 : 0,
        occupied: hasDevice ? 1 : 0,
        last_update_ms: now - randInt(rng, 60000, 3600000),
        active_zone_count: hasDevice ? randInt(rng, 1, 4) : 0,
        fabric_name: fabric.name,
      });
    }
    ports.forEach((p) => {
      insertPort.run({
        source_id: sourceId, sannav_id: 2000 + p.port_number, switch_wwn: swWwn, switch_name: sw.name,
        name: `port${p.port_number}`, ...p,
      });
      portTotal++;
    });
    switchByKey[sw.key].ports = ports;
  });

  // ── Enclosures + device ports ───────────────────────────────────────
  const ENCLOSURE_PLAN = [
    { name: 'ESX-Host-01', type: 'Host', hostName: 'nyc-esx-0101.icc.demo', vendor: 'VMware', model: 'ESXi 8.0.3', fabric: 'PA' },
    { name: 'vRA-Prod-Host', type: 'Host', hostName: 'vra-prod', vendor: 'VMware', model: 'ESXi 8.0.3', fabric: 'PA' },
    { name: 'vRA-DR-Host', type: 'Host', hostName: 'vra-dr', vendor: 'VMware', model: 'ESXi 8.0.3', fabric: 'DA' },
    { name: 'Aria-Ops-Host', type: 'Host', hostName: 'vrops-nyc-01', vendor: 'VMware', model: 'ESXi 8.0.3', fabric: 'PB' },
    { name: 'Aria-LogInsight-Host', type: 'Host', hostName: 'vrli-nyc-01', vendor: 'VMware', model: 'ESXi 8.0.3', fabric: 'PB' },
  ];
  const HOST_NAME_PREFIXES = ['ESX-Host', 'App-Host', 'DB-Host', 'File-Host', 'Backup-Host'];
  const STORAGE_VENDORS = [
    { vendor: 'Pure Storage', model: 'FlashArray//X70' },
    { vendor: 'NetApp', model: 'AFF A800' },
    { vendor: 'Dell EMC', model: 'PowerMax 2000' },
    { vendor: 'Cohesity', model: 'C6600' },
  ];
  let enclosureTotal = 0, devicePortTotal = 0;
  const enclosures = [];
  ENCLOSURE_PLAN.forEach((e, i) => {
    const fabric = fabricByKey[e.fabric];
    const sourceId = sourceIds[fabric.source];
    const info = insertEnclosure.run({
      source_id: sourceId, sannav_id: 3000 + i, guid: `enc-guid-${i}`, name: e.name, type: e.type,
      host_name: e.hostName, ip_address: `10.50.${i}.10`, vendor: e.vendor, model: e.model,
      health: 'Healthy', location: 'DC-Rack-12', contact: 'ops@icc.demo', tags: JSON.stringify(['production']),
      raw_json: JSON.stringify({ name: e.name, hostName: e.hostName }),
    });
    enclosures.push({ id: info.lastInsertRowid, guid: `enc-guid-${i}`, name: e.name, type: e.type, fabric: e.fabric, sourceId, hostName: e.hostName });
    enclosureTotal++;
  });
  // Remaining hosts + storage arrays to reach ~30 enclosures.
  const remainingHosts = 14, remainingStorage = 11;
  for (let i = 0; i < remainingHosts; i++) {
    const fabricKey = pick(rngFor(`brocade-enc-host-fab-${i}`), ['PA', 'PB', 'DA', 'DB']);
    const fabric = fabricByKey[fabricKey];
    const sourceId = sourceIds[fabric.source];
    const rng = rngFor(`brocade-enc-host-${i}`);
    const name = `${pick(rng, HOST_NAME_PREFIXES)}-${String(10 + i).padStart(2, '0')}`;
    const guid = `enc-guid-host-${i}`;
    const info = insertEnclosure.run({
      source_id: sourceId, sannav_id: 3100 + i, guid, name, type: 'Host',
      host_name: `${name.toLowerCase()}.icc.demo`, ip_address: `10.51.${i}.10`, vendor: 'VMware',
      model: 'ESXi 8.0.3', health: 'Healthy', location: 'DC-Rack-12', contact: null, tags: null,
      raw_json: JSON.stringify({ name }),
    });
    enclosures.push({ id: info.lastInsertRowid, guid, name, type: 'Host', fabric: fabricKey, sourceId, hostName: `${name.toLowerCase()}.icc.demo` });
    enclosureTotal++;
  }
  for (let i = 0; i < remainingStorage; i++) {
    const fabricKey = pick(rngFor(`brocade-enc-storage-fab-${i}`), ['PA', 'PB', 'DA', 'DB']);
    const fabric = fabricByKey[fabricKey];
    const sourceId = sourceIds[fabric.source];
    const rng = rngFor(`brocade-enc-storage-${i}`);
    const sv = pick(rng, STORAGE_VENDORS);
    const name = `${sv.vendor.split(' ')[0]}-Array-${String(1 + i).padStart(2, '0')}`;
    const guid = `enc-guid-storage-${i}`;
    const info = insertEnclosure.run({
      source_id: sourceId, sannav_id: 3200 + i, guid, name, type: 'Storage',
      host_name: null, ip_address: `10.52.${i}.10`, vendor: sv.vendor, model: sv.model,
      health: 'Healthy', location: 'DC-Rack-04', contact: null, tags: null,
      raw_json: JSON.stringify({ name }),
    });
    enclosures.push({ id: info.lastInsertRowid, guid, name, type: 'Storage', fabric: fabricKey, sourceId, hostName: null });
    enclosureTotal++;
  }

  // Device ports: attach to switch ports that already have hasDevice=true.
  const occupiedPortsByFabric = {};
  Object.values(switchByKey).forEach((sw) => {
    sw.ports.forEach((p) => {
      if (!p.occupied) return;
      const key = sw.fabricName;
      if (!occupiedPortsByFabric[key]) occupiedPortsByFabric[key] = [];
      occupiedPortsByFabric[key].push({ switchWwn: sw.wwn, switchName: sw.name, sourceId: sw.sourceId, ...p });
    });
  });
  let devIdx = 0;
  Object.entries(occupiedPortsByFabric).forEach(([fabricName, list]) => {
    const fabricKey = FABRIC_DEFS.find((f) => f.name === fabricName).key;
    const fabricEnclosures = enclosures.filter((e) => e.fabric === fabricKey);
    if (!fabricEnclosures.length) return;
    list.forEach((sp, i) => {
      const rng = rngFor(`brocade-devport-${fabricName}-${i}`);
      const enclosure = fabricEnclosures[i % fabricEnclosures.length];
      const isHost = enclosure.type === 'Host';
      insertDevicePort.run({
        source_id: sp.sourceId, sannav_id: 4000 + devIdx, wwn: sp.remote_port_wwn || wwn(rng),
        device_node_wwn: sp.remote_node_wwn || wwn(rng),
        symbolic_name: `${enclosure.name} Port ${i + 1}`,
        device_symbolic_name: enclosure.name, vendor: isHost ? 'VMware' : 'Storage Vendor',
        port_role: isHost ? 'Initiator' : 'Target', type: 'N_Port', fabric_name: fabricName,
        switch_wwn: sp.switchWwn, switch_name: sp.switchName,
        switch_port_wwn: sp.wwn, switch_port_name: `port${sp.port_number}`,
        port_number: sp.port_number, port_id: sp.port_id,
        enclosure_id: enclosure.id, enclosure_guid: enclosure.guid, enclosure_name: enclosure.name,
        fdmi_host_name: enclosure.hostName,
        active_zones: JSON.stringify([`${fabricName}_zone_${1 + (i % 20)}`]),
        active_zone_count: 1, active_zoneset_name: `${fabricName}_EFF_CFG`,
        speed: sp.speed,
      });
      devicePortTotal++;
      devIdx++;
    });
  });

  // ── Zoning ───────────────────────────────────────────────────────────
  let zoneConfigTotal = 0, zoneTotal = 0, aliasTotal = 0, zoneChangeTotal = 0;
  FABRIC_DEFS.forEach((f) => {
    const sourceId = sourceIds[f.source];
    const rng = rngFor(`brocade-zoning-${f.key}`);
    const zoneCount = randInt(rng, 15, 25);
    const zoneNames = [];
    for (let z = 1; z <= zoneCount; z++) {
      const name = `${f.name}_zone_${z}`;
      const memberCount = randInt(rng, 2, 3);
      const members = Array.from({ length: memberCount }, () => wwn(rng));
      insertZone.run({
        source_id: sourceId, fabric_name: f.name, zone_name: name, zone_type: 0,
        zone_type_string: 'WWN', members: JSON.stringify(members), in_effective: 1,
      });
      zoneNames.push(name);
      zoneTotal++;
    }
    for (let a = 1; a <= 10; a++) {
      insertAlias.run({
        source_id: sourceId, fabric_name: f.name, alias_name: `${f.name}_alias_${a}`,
        members: JSON.stringify([wwn(rng)]),
      });
      aliasTotal++;
    }
    const defaultZoneAccess = f.key === 'DB' ? 1 : 0;
    insertZoneConfig.run({
      source_id: sourceId, fabric_name: f.name, cfg_name: `${f.name}_EFF_CFG`, is_effective: 1,
      member_zones: JSON.stringify(zoneNames), default_zone_access: defaultZoneAccess,
      checksum: `chk-${rngFor(`brocade-checksum-${f.key}`)().toString(16).slice(2, 10)}`,
      db_committed: randInt(rng, 100000, 800000),
    });
    zoneConfigTotal++;
    insertZoneConfig.run({
      source_id: sourceId, fabric_name: f.name, cfg_name: `${f.name}_DEFINED_CFG`, is_effective: 0,
      member_zones: JSON.stringify(zoneNames.slice(0, Math.max(1, zoneNames.length - 3))),
      default_zone_access: 0,
      checksum: `chk-${rngFor(`brocade-checksum-def-${f.key}`)().toString(16).slice(2, 10)}`,
      db_committed: randInt(rng, 50000, 400000),
    });
    zoneConfigTotal++;
  });
  // Zone changes: 4 rows total, one inside the last 24h (PROD-A).
  const ZONE_CHANGES = [
    { fabric: 'PA', type: 'checksum_changed', detail: 'Effective config checksum changed', old: 'chk-a1b2c3', new: 'chk-d4e5f6', ago: '-3 hours' },
    { fabric: 'PB', type: 'zone_added', detail: 'New zone added to defined configuration', old: null, new: 'PROD-B_zone_26', ago: '-2 days' },
    { fabric: 'DA', type: 'effective_cfg_changed', detail: 'Effective configuration name changed', old: 'DR-A_OLD_CFG', new: 'DR-A_EFF_CFG', ago: '-5 days' },
    { fabric: 'DB', type: 'zone_modified', detail: 'Zone membership modified', old: '2 members', new: '3 members', ago: '-1 day' },
  ];
  ZONE_CHANGES.forEach((zc) => {
    const fabric = fabricByKey[zc.fabric];
    insertZoneChange.run({
      source_id: sourceIds[fabric.source], fabric_name: fabric.name, change_type: zc.type,
      detail: zc.detail, old_value: zc.old, new_value: zc.new, detected_at: ago(zc.ago),
    });
    zoneChangeTotal++;
  });

  // ── Port IO statistics (Addendum 1) ─────────────────────────────────
  // 24h of 15-min samples for ~40 online F-ports: 20 PROD + 10 DR (2880 rows
  // total, well under the 8k cap). REQUIRED: an imbalanced pair on
  // PROD-A-SW01 (ports 3+4 — always F-Port by construction regardless of
  // hasDevice) zoned to the same remote enclosure name, one ~20k fr/s and
  // the other ~200 fr/s; plus a crc_errors_delta trickle port (port 5).
  const insertPortStat = db.prepare(`
    INSERT INTO brocade_port_stats (source_id, port_wwn, switch_wwn, ts, in_frames, out_frames,
      in_octets, out_octets, crc_errors, invalid_words, in_frames_per_sec, out_frames_per_sec,
      in_mb_per_sec, out_mb_per_sec, crc_errors_delta, interval_secs)
    VALUES (@source_id, @port_wwn, @switch_wwn, @ts, @in_frames, @out_frames,
      @in_octets, @out_octets, @crc_errors, @invalid_words, @in_frames_per_sec, @out_frames_per_sec,
      @in_mb_per_sec, @out_mb_per_sec, @crc_errors_delta, @interval_secs)
  `);
  const SAMPLES_PER_PORT = 96;
  const PORT_STATS_INTERVAL_SECS = 900;
  let portStatsTotal = 0;

  function fPortPool(switchKeys) {
    const list = [];
    for (const key of switchKeys) {
      const sw = switchByKey[key];
      for (const p of sw.ports) {
        if (p.type === 'F-Port' && p.state === 'Online') {
          list.push({ wwn: p.wwn, switchWwn: sw.wwn, sourceId: sw.sourceId });
        }
      }
    }
    return list;
  }

  const sw1 = switchByKey.sw1; // PROD-A-SW01
  const imbalHigh = sw1.ports.find((p) => p.port_number === 3);
  const imbalLow = sw1.ports.find((p) => p.port_number === 4);
  const crcPort = sw1.ports.find((p) => p.port_number === 5);
  const forcePortOnline = (port, remoteDevice) => {
    port.state = 'Online'; port.status = 'Online'; port.health = 'healthy';
    port.occupied = 1; port.fenced = 0; port.blocked = 0;
    db.prepare(`
      UPDATE brocade_switch_ports SET state='Online', status='Online', health='healthy', occupied=1,
        fenced=0, blocked=0, remote_device=? WHERE source_id=? AND wwn=?
    `).run(remoteDevice, sw1.sourceId, port.wwn);
  };
  forcePortOnline(imbalHigh, 'SharedArray-01');
  forcePortOnline(imbalLow, 'SharedArray-01');
  forcePortOnline(crcPort, `device-${randInt(rngFor('brocade-crcport'), 1, 999)}`);

  const prodPool = fPortPool(SWITCH_DEFS.filter((s) => s.fabric.startsWith('P')).map((s) => s.key))
    .filter((p) => p.wwn !== imbalHigh.wwn && p.wwn !== imbalLow.wwn && p.wwn !== crcPort.wwn);
  const drPool = fPortPool(SWITCH_DEFS.filter((s) => s.fabric.startsWith('D')).map((s) => s.key));

  const statsPortPlan = [
    { wwn: imbalHigh.wwn, switchWwn: sw1.wwn, sourceId: sw1.sourceId, profile: 'imbalanced_high' },
    { wwn: imbalLow.wwn, switchWwn: sw1.wwn, sourceId: sw1.sourceId, profile: 'imbalanced_low' },
    { wwn: crcPort.wwn, switchWwn: sw1.wwn, sourceId: sw1.sourceId, profile: 'crc_trickle' },
    ...prodPool.slice(0, 17).map((p) => ({ ...p, profile: 'normal' })),
    ...drPool.slice(0, 10).map((p) => ({ ...p, profile: 'normal' })),
  ];

  statsPortPlan.forEach((port) => {
    const rng = rngFor(`brocade-portstats-${port.wwn}`);
    let cumIn = randInt(rng, 1000000, 5000000);
    let cumOut = randInt(rng, 1000000, 5000000);
    let cumInOct = cumIn * 2148;
    let cumOutOct = cumOut * 2148;
    let cumCrc = randInt(rng, 0, 3);
    for (let i = SAMPLES_PER_PORT; i >= 1; i--) {
      let inFps, outFps, inMbps, outMbps, crcDelta = 0;
      if (port.profile === 'imbalanced_high') {
        inFps = randInt(rng, 18000, 22000); outFps = randInt(rng, 18000, 22000);
        inMbps = randFloat(rng, 180, 220, 2); outMbps = randFloat(rng, 180, 220, 2);
      } else if (port.profile === 'imbalanced_low') {
        inFps = randInt(rng, 150, 250); outFps = randInt(rng, 150, 250);
        inMbps = randFloat(rng, 2, 8, 2); outMbps = randFloat(rng, 2, 8, 2);
      } else if (port.profile === 'crc_trickle') {
        inFps = randInt(rng, 5000, 15000); outFps = randInt(rng, 5000, 15000);
        inMbps = randFloat(rng, 50, 150, 2); outMbps = randFloat(rng, 50, 150, 2);
        crcDelta = chance(rng, 0.4) ? randInt(rng, 1, 4) : 0;
      } else {
        inFps = randInt(rng, 5000, 40000); outFps = randInt(rng, 5000, 40000);
        inMbps = randFloat(rng, 50, 400, 2); outMbps = randFloat(rng, 50, 400, 2);
      }
      cumIn += inFps * PORT_STATS_INTERVAL_SECS;
      cumOut += outFps * PORT_STATS_INTERVAL_SECS;
      cumInOct += Math.round(inMbps * 1e6 * PORT_STATS_INTERVAL_SECS);
      cumOutOct += Math.round(outMbps * 1e6 * PORT_STATS_INTERVAL_SECS);
      cumCrc += crcDelta;
      const isFirst = i === SAMPLES_PER_PORT; // no prior sample -> null rates, like the real poller
      insertPortStat.run({
        source_id: port.sourceId, port_wwn: port.wwn, switch_wwn: port.switchWwn,
        ts: ago(`-${i * 15} minutes`),
        in_frames: cumIn, out_frames: cumOut, in_octets: cumInOct, out_octets: cumOutOct,
        crc_errors: cumCrc, invalid_words: 0,
        in_frames_per_sec: isFirst ? null : inFps, out_frames_per_sec: isFirst ? null : outFps,
        in_mb_per_sec: isFirst ? null : inMbps, out_mb_per_sec: isFirst ? null : outMbps,
        crc_errors_delta: isFirst ? null : crcDelta, interval_secs: isFirst ? null : PORT_STATS_INTERVAL_SECS,
      });
      portStatsTotal++;
    }
  });

  // ── FCR routes (minimal, 1 per source) ──────────────────────────────
  let fcrTotal = 0;
  SOURCES.forEach((s, i) => {
    const rng = rngFor(`brocade-fcr-${s.name}`);
    insertFcrRoute.run({
      source_id: sourceIds[s.name], backbone_fabric_id: 128 + i,
      backbone_wwn: wwn(rng), backbone_ip: `10.60.${i}.1`,
      edge_fabrics: JSON.stringify([{ EdgeFabric: [{ edgeFabricId: 1 + i, edgeFabricName: `EDGE-${i}` }] }]),
    });
    fcrTotal++;
  });

  // ── Health scores ────────────────────────────────────────────────────
  let healthScoreTotal = 0;
  function contributors(rng, low) {
    return JSON.stringify([
      { contributorType: 'PORT_ERROR_RATE', score: low ? randInt(rng, 20, 45) : randInt(rng, 80, 100), descriptionDetail: [{ text: 'Port error rate within thresholds' }] },
      { contributorType: 'CONFIG_COMPLIANCE', score: low ? randInt(rng, 30, 55) : randInt(rng, 85, 100), descriptionDetail: [{ text: 'Configuration compliant with best practices' }] },
    ]);
  }
  const FABRIC_SCORES = { PA: 92, PB: 65, DA: 95, DB: 98 };
  FABRIC_DEFS.forEach((f) => {
    const rng = rngFor(`brocade-health-fabric-${f.key}`);
    const score = FABRIC_SCORES[f.key];
    const compTime = new Date(now - randInt(rng, 5, 60) * 60000);
    insertHealthScore.run({
      source_id: sourceIds[f.source], entity_type: 'FABRIC', entity_name: f.name,
      entity_guid: `fabric-guid-${f.key.toLowerCase()}`, entity_wwn: null, entity_ip: null,
      fabric_name: f.name, score, status: score < 50 ? 'critical' : score < 70 ? 'marginal' : 'healthy',
      computation_time: compTime.toString(), computation_ms: compTime.getTime(),
      contributors_json: contributors(rng, score < 70),
    });
    healthScoreTotal++;
  });
  const SWITCH_SCORES = { sw4: 42, sw11: 64, sw10: 78, sw7: 72 };
  Object.values(switchByKey).forEach((sw) => {
    const rng = rngFor(`brocade-health-switch-${sw.key}`);
    const score = SWITCH_SCORES[sw.key] != null ? SWITCH_SCORES[sw.key] : randInt(rng, 82, 99);
    const compTime = new Date(now - randInt(rng, 5, 60) * 60000);
    insertHealthScore.run({
      source_id: sw.sourceId, entity_type: 'SWITCH', entity_name: sw.name,
      entity_guid: `switch-guid-${sw.key}`, entity_wwn: sw.wwn, entity_ip: sw.ip,
      fabric_name: sw.fabricName, score, status: score < 50 ? 'critical' : score < 70 ? 'marginal' : 'healthy',
      computation_time: compTime.toString(), computation_ms: compTime.getTime(),
      contributors_json: contributors(rng, score < 70),
    });
    healthScoreTotal++;
  });
  enclosures.slice(0, 4).forEach((e, i) => {
    const rng = rngFor(`brocade-health-enclosure-${i}`);
    const score = randInt(rng, 85, 99);
    const compTime = new Date(now - randInt(rng, 5, 60) * 60000);
    insertHealthScore.run({
      source_id: e.sourceId, entity_type: e.type === 'Host' ? 'HOST' : 'STORAGE', entity_name: e.name,
      entity_guid: e.guid, entity_wwn: null, entity_ip: null,
      fabric_name: fabricByKey[e.fabric].name, score, status: 'healthy',
      computation_time: compTime.toString(), computation_ms: compTime.getTime(),
      contributors_json: contributors(rng, false),
    });
    healthScoreTotal++;
  });

  // ── Events (~200, storm on SanNav Prod, unacked criticals, spread 7 days) ─
  let eventTotal = 0;
  let eventIdx = 0;
  const allSwitches = Object.values(switchByKey);
  function pushEvent(sourceName, occurredAtOffsetMin, forcedSeverity) {
    const sourceId = sourceIds[sourceName];
    const rng = rngFor(`brocade-event-${sourceName}-${eventIdx}`);
    const sw = pick(rng, allSwitches.filter((s) => fabricByKey[s.fabric].source === sourceName));
    const sevDef = forcedSeverity || weightedSeverity(rng);
    const occurredMs = now - occurredAtOffsetMin * 60000;
    const acknowledged = sevDef.norm === 'critical' ? (chance(rng, 0.3) ? 1 : 0) : (chance(rng, 0.6) ? 1 : 0);
    insertEvent.run({
      source_id: sourceId, event_id: `evt-${sourceName.replace(/\s+/g, '')}-${eventIdx}`,
      severity: sevDef.severity, severity_norm: sevDef.norm, event_category: pick(rng, ['SWITCH', 'FABRIC', 'PORT', 'SECURITY', 'ZONE']),
      source_name: sw.name, source_address: sw.ip, source_type: 'Switch', source_wwn: sw.wwn,
      fabric_name: sw.fabricName, message_id: pick(rng, EVENT_MESSAGE_IDS), origin: 'SANnav',
      module: pick(rng, ['FSPF', 'ZONE', 'PORT', 'SEC', 'MAPS']),
      description: `${pick(rng, EVENT_MESSAGE_IDS)} on ${sw.name}: ${pick(rng, ['link flap detected', 'zone change detected', 'port error threshold exceeded', 'switch reachable', 'MAPS rule violation'])}`,
      first_occurred_ms: occurredMs, last_occurred_ms: occurredMs,
      acknowledged, ack_by: acknowledged ? 'admin' : null,
      ack_notes: acknowledged ? 'Reviewed' : null, acked_time_ms: acknowledged ? occurredMs + 60000 : null,
      port_wwn: sw.ports && sw.ports.length ? sw.ports[0].wwn : null,
    });
    eventTotal++;
    eventIdx++;
  }
  // Storm: >=14 critical/alert events in the last hour on SanNav Prod.
  for (let i = 0; i < 14; i++) {
    pushEvent('SanNav Prod', randInt(rngFor(`brocade-storm-${i}`), 1, 55), { severity: 'Critical', norm: 'critical' });
  }
  // Additional unacked criticals within 24h for the alerts feed.
  for (let i = 0; i < 5; i++) {
    pushEvent('SanNav DR', randInt(rngFor(`brocade-crit24-${i}`), 60, 1400), { severity: 'Critical', norm: 'critical' });
  }
  // Remaining ~180 events spread over 7 days across both sources.
  SOURCES.forEach((s) => {
    const rng = rngFor(`brocade-events-fill-${s.name}`);
    const count = 90;
    for (let i = 0; i < count; i++) {
      pushEvent(s.name, randInt(rng, 5, 10080));
    }
  });

  // ── Metrics history: hourly for last 7 days per source ──────────────
  let metricsTotal = 0;
  SOURCES.forEach((s) => {
    const sourceId = sourceIds[s.name];
    const rng = rngFor(`brocade-metrics-${s.name}`);
    const sourceFabrics = FABRIC_DEFS.filter((f) => f.source === s.name);
    const sourceSwitches = Object.values(switchByKey).filter((sw) => fabricByKey[sw.fabric].source === s.name);
    const sourcePorts = sourceSwitches.reduce((a, sw) => a + sw.ports.length, 0);
    const sourceDevicePorts = Math.round(devicePortTotal * (sourceSwitches.length / SWITCH_DEFS.length));
    const sourceEnclosures = enclosures.filter((e) => fabricByKey[e.fabric].source === s.name);
    for (let h = 168; h >= 0; h--) {
      const jitter = randFloat(rng, 0.95, 1.05, 2);
      const onlinePorts = Math.round(sourcePorts * 0.82 * jitter);
      insertMetric.run({
        source_id: sourceId,
        fabrics_total: sourceFabrics.length,
        fabrics_healthy: sourceFabrics.filter((f) => f.status === 1).length,
        switches_total: sourceSwitches.length,
        switches_healthy: sourceSwitches.filter((sw) => !sw.critical && !sw.marginal && !sw.unreachable).length,
        switches_marginal: sourceSwitches.filter((sw) => sw.marginal).length,
        switches_critical: sourceSwitches.filter((sw) => sw.critical).length,
        switches_unreachable: sourceSwitches.filter((sw) => sw.unreachable).length,
        ports_total: sourcePorts, ports_online: Math.min(sourcePorts, onlinePorts),
        ports_offline: Math.max(0, sourcePorts - onlinePorts - 3), ports_error: 3,
        ports_occupied: Math.round(sourcePorts * 0.5 * jitter),
        device_ports_total: sourceDevicePorts,
        enclosures_total: sourceEnclosures.length,
        hosts_total: sourceEnclosures.filter((e) => e.type === 'Host').length,
        storage_total: sourceEnclosures.filter((e) => e.type === 'Storage').length,
        zones_total: sourceFabrics.length * 20, aliases_total: sourceFabrics.length * 10,
        avg_fabric_health: Math.round(sourceFabrics.reduce((a, f) => a + FABRIC_SCORES[f.key], 0) / sourceFabrics.length),
        min_fabric_health: Math.min(...sourceFabrics.map((f) => FABRIC_SCORES[f.key])),
        events_critical_24h: randInt(rng, 3, 20), events_warning_24h: randInt(rng, 5, 30),
        ts: ago(`-${h} hours`),
      });
      metricsTotal++;
    }
  });

  // ── Issue history: 8-12 rows incl. 2 resolved ───────────────────────
  let issueHistoryTotal = 0;
  const OPEN_ISSUES = [
    { source: 'SanNav Prod', type: 'switch_critical', target: 'PROD-A-SW04', severity: 'critical', message: 'Switch PROD-A-SW04 operational status is CRITICAL (BAD_PWR)', ageMin: 240 },
    { source: 'SanNav Prod', type: 'switch_unreachable', target: 'PROD-B-SW03', severity: 'critical', message: 'Switch PROD-B-SW03 is unreachable', ageMin: 180 },
    { source: 'SanNav Prod', type: 'switch_mgmt_state', target: 'PROD-B-SW02', severity: 'warning', message: 'Switch PROD-B-SW02 management state indicates invalid credentials', ageMin: 420 },
    { source: 'SanNav Prod', type: 'fabric_unhealthy', target: 'PROD-B', severity: 'warning', message: 'Fabric PROD-B is Marginal', ageMin: 300 },
    { source: 'SanNav Prod', type: 'health_score_low', target: 'PROD-A-SW04', severity: 'critical', message: 'Switch PROD-A-SW04 health score is 42', ageMin: 240 },
    { source: 'SanNav Prod', type: 'port_fenced', target: 'PROD-A-SW03 port5', severity: 'warning', message: 'Port 5 on PROD-A-SW03 is fenced', ageMin: 600 },
    { source: 'SanNav DR', type: 'cert_expiring', target: 'DR-B-SW01', severity: 'warning', message: 'TLS cert on DR-B-SW01 expires in 20 days', ageMin: 1440 },
    { source: 'SanNav Prod', type: 'cert_expiring', target: 'PROD-A-SW02 (chassis)', severity: 'critical', message: 'TLS cert on PROD-A-SW02 chassis has expired', ageMin: 720 },
    { source: 'SanNav DR', type: 'switch_eos', target: 'DR-A-SW02', severity: 'warning', message: 'Switch DR-A-SW02 is running an End-of-Support firmware version', ageMin: 2000 },
    { source: 'SanNav Prod', type: 'firmware_drift', target: 'PROD-A', severity: 'info', message: 'Fabric PROD-A has 2 distinct firmware versions among its switches', ageMin: 1000 },
    { source: 'SanNav DR', type: 'zone_default_access', target: 'DR-B', severity: 'warning', message: "Fabric DR-B effective config has default zone access set to 'All Access'", ageMin: 800 },
    { source: 'SanNav Prod', type: 'zone_drift', target: 'PROD-A', severity: 'info', message: 'Zoning changed on fabric PROD-A within the last 24 hours', ageMin: 180 },
    { source: 'SanNav DR', type: 'maintenance_mode', target: 'DR-B-SW02', severity: 'info', message: 'Switch DR-B-SW02 is in maintenance mode', ageMin: 300 },
    { source: 'SanNav Prod', type: 'event_storm', target: 'SanNav Prod', severity: 'warning', message: 'Event storm detected: 14 critical/alert events in the last hour', ageMin: 45 },
    { source: 'SanNav DR', type: 'poll_failed', target: 'SanNav DR', severity: 'warning', message: SOURCES[1].pollError, ageMin: 130 },
  ];
  OPEN_ISSUES.forEach((issue) => {
    insertIssueHistory.run({
      source_id: sourceIds[issue.source], source: issue.source, type: issue.type, target: issue.target,
      severity: issue.severity, message: issue.message,
      first_seen: ago(`-${issue.ageMin} minutes`), last_seen: ago('-3 minutes'), resolved_at: null,
    });
    issueHistoryTotal++;
  });
  const RESOLVED_ISSUES = [
    { source: 'SanNav Prod', type: 'switch_critical', target: 'PROD-B-SW04', severity: 'critical', message: 'Switch PROD-B-SW04 operational status was CRITICAL', openedMin: 4320, resolvedMin: 4200 },
    { source: 'SanNav DR', type: 'port_fenced', target: 'DR-A-SW01 port9', severity: 'warning', message: 'Port 9 on DR-A-SW01 was fenced', openedMin: 2880, resolvedMin: 2700 },
  ];
  RESOLVED_ISSUES.forEach((issue) => {
    insertIssueHistory.run({
      source_id: sourceIds[issue.source], source: issue.source, type: issue.type, target: issue.target,
      severity: issue.severity, message: issue.message,
      first_seen: ago(`-${issue.openedMin} minutes`), last_seen: ago(`-${issue.resolvedMin} minutes`),
      resolved_at: ago(`-${issue.resolvedMin} minutes`),
    });
    issueHistoryTotal++;
  });

  return {
    sources: SOURCES.length, fabrics: FABRIC_DEFS.length, switches: switchTotal,
    switchPorts: portTotal, devicePorts: devicePortTotal, enclosures: enclosureTotal,
    chassis: chassisTotal, events: eventTotal, healthScores: healthScoreTotal,
    zoneConfigs: zoneConfigTotal, zones: zoneTotal, zoneAliases: aliasTotal,
    zoneChanges: zoneChangeTotal, fcrRoutes: fcrTotal, metrics: metricsTotal,
    issueHistory: issueHistoryTotal, portStats: portStatsTotal,
  };
}

/** Demo-only entry point. Upserts the two fixture sources (id stable across
 *  boots), wipes their dependent rows, and regenerates them with fresh
 *  relative timestamps, so a demo box refreshes on every boot instead of
 *  aging into a stale-looking estate. NEVER runs outside demo mode — see the
 *  DASHBOARD_DEMO gate in poller.js. */
function seedBrocadeDemo(coreApi) {
  const db = coreApi.db;
  return db.transaction(() => seedBrocade(db, { now: Date.now(), encrypt: coreApi.encryption.encrypt }))();
}

module.exports = { seedBrocade, seedBrocadeDemo };
