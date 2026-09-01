// Brocade SAN poller — ported from backend/services/brocadePoller.js. THREE
// framework pollers over the same brocade_sources loadSources: id 'brocade'
// (inventory), 'brocade-events' (fault events), 'brocade-portstats' (port IO
// counters). A failed section is tolerated (recorded in section_errors) so a
// transient API error never wipes previously-good rows — sections that fail
// simply skip their write for this cycle; rows from the last good poll stay
// in place (marked stale only when the section itself succeeded and omitted
// them). db/logger/createPoller/settings now come from coreApi rather than
// direct host requires.
//
// Module-scoped singleton, mirroring dell/unifi poller.js: createRouter()
// and manifest.createPoller() are both called by the host registry against
// the same coreApi, but createRouter runs first and needs to reach the same
// poller instance for schedule/cancel/trigger on source CRUD. getHandle()
// lazily builds it if not yet created.
const api = require('./api');
const fosApi = require('./fosApi');
const { reconcileIssueHistory, eventRetentionDays } = require('./issues');

const safeMsg = (e) => api.errMsg(e);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let handleInstance = null;

// ── Direct-FOS credential resolution (addendum 2) ───────────────────────────
// A switch row's target = its brocade_fos_overrides row (by switch_wwn) with
// NULL fields inheriting from the shared brocade_sources fos_* columns.
// Returns null when there is no usable ip+username+password to try.

function resolveFosTarget(coreApi, source, switchRow) {
  const db = coreApi.db;
  if (!switchRow) return null;
  // WWN matching must be case-insensitive (SANnav mixes cases across records),
  // and an override may still apply by IP when the WWN key differs (live
  // finding: fabric seed WWNs don't always match switch-row/override WWNs).
  let override = null;
  if (switchRow.wwn) {
    override = db.prepare('SELECT * FROM brocade_fos_overrides WHERE source_id = ? AND switch_wwn = ? COLLATE NOCASE').get(source.id, switchRow.wwn);
  }
  if (!override && switchRow.ip_address) {
    override = db.prepare("SELECT * FROM brocade_fos_overrides WHERE source_id = ? AND TRIM(COALESCE(ip_address, '')) = ?").get(source.id, String(switchRow.ip_address).trim());
  }
  const ip = override?.ip_address || switchRow.ip_address;
  const username = override?.username || source.fos_username;
  const passwordEnc = override?.password_enc || source.fos_password_enc;
  const port = override?.port || source.fos_port || 443;
  if (!ip || !username || !passwordEnc) return null;
  return {
    ip: String(ip).trim(), port, username, password_enc: passwordEnc,
    verify_ssl: source.verify_ssl, allow_http: !!source.fos_allow_http,
  };
}

/**
 * Zoning's primary direct-FOS target for a fabric: the fabric's
 * seed/principal switch row (so overrides keyed by switch_wwn apply), or a
 * synthetic row from the fabric's seedSwitchIp when that switch hasn't been
 * inventoried yet (e.g. first-ever poll, or the SanNav proxy-only fabric
 * data hasn't matched a brocade_switches row).
 */
function findSeedSwitchRow(coreApi, sourceId, fabric) {
  const db = coreApi.db;
  const wwn = fabric.seedSwitchWwn || fabric.principalSwitchWwn;
  if (wwn) {
    // SANnav fabric records may carry the seed's physical WWN or a different
    // letter-case than the switch inventory row — match both, case-insensitive.
    const row = db.prepare(`
      SELECT * FROM brocade_switches WHERE source_id = ?
        AND (wwn = ? COLLATE NOCASE OR physical_switch_wwn = ? COLLATE NOCASE)
    `).get(sourceId, wwn, wwn);
    if (row) return row;
  }
  if (fabric.seedSwitchIp) {
    const ip = String(fabric.seedSwitchIp).trim();
    const byIp = db.prepare("SELECT * FROM brocade_switches WHERE source_id = ? AND TRIM(COALESCE(ip_address, '')) = ?").get(sourceId, ip);
    if (byIp) return byIp;
    return { wwn: wwn || null, ip_address: ip, virtual_fabric_id: fabric.virtualFabricId };
  }
  return null;
}

async function trySection(coreApi, label, fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    coreApi.logger.warn(`[BrocadePoller] ${label} failed: ${safeMsg(err)}`);
    return { ok: false, error: safeMsg(err) };
  }
}

// ── Store helpers (upsert by natural key, mark unseen rows stale) ──────────

function buildStores(coreApi) {
  const db = coreApi.db;

  const upsertFabrics = db.transaction((sourceId, rows) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_fabrics (source_id, sannav_id, guid, name, principal_switch_wwn, seed_switch_wwn,
        seed_switch_ip, seed_switch_name, seed_switch_firmware, status, health, switch_count,
        active_zoneset_name, managed, virtual_fabric_id, management_state, last_fabric_changed, stale, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
      ON CONFLICT(source_id, principal_switch_wwn) DO UPDATE SET
        sannav_id=excluded.sannav_id, guid=excluded.guid, name=excluded.name, seed_switch_wwn=excluded.seed_switch_wwn,
        seed_switch_ip=excluded.seed_switch_ip, seed_switch_name=excluded.seed_switch_name,
        seed_switch_firmware=excluded.seed_switch_firmware, status=excluded.status, health=excluded.health,
        switch_count=excluded.switch_count, active_zoneset_name=excluded.active_zoneset_name, managed=excluded.managed,
        virtual_fabric_id=excluded.virtual_fabric_id, management_state=excluded.management_state,
        last_fabric_changed=excluded.last_fabric_changed, stale=0, raw_json=excluded.raw_json, updated_at=datetime('now')
    `);
    for (const f of rows) {
      if (!f.principalSwitchWwn) continue;
      stmt.run(sourceId, f.sannavId, f.guid, f.name, f.principalSwitchWwn, f.seedSwitchWwn, f.seedSwitchIp,
        f.seedSwitchName, f.seedSwitchFirmware, f.status, f.health, f.switchCount, f.activeZonesetName,
        f.managed, f.virtualFabricId, f.managementState, f.lastFabricChanged, f.rawJson);
      seen.push(f.principalSwitchWwn);
    }
    if (seen.length) {
      const ph = seen.map(() => '?').join(',');
      db.prepare(`UPDATE brocade_fabrics SET stale=1 WHERE source_id=? AND principal_switch_wwn NOT IN (${ph})`).run(sourceId, ...seen);
    } else {
      db.prepare('UPDATE brocade_fabrics SET stale=1 WHERE source_id=?').run(sourceId);
    }
  });

  const upsertSwitches = db.transaction((sourceId, rows) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_switches (source_id, sannav_id, wwn, name, physical_switch_wwn, ip_address, model,
        model_number, firmware_version, serial_number, fabric_name, principal_switch_wwn, domain_id, role, state,
        status, operational_status, health, status_reason, is_missing, monitored, discovered_port_count, max_port,
        switch_mode, management_state, eos_status, maintenance_mode, tls_cert_expiry_ms, trufos_status,
        virtual_fabric_id, chassis_type, vendor, stale, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
      ON CONFLICT(source_id, wwn) DO UPDATE SET
        sannav_id=excluded.sannav_id, name=excluded.name, physical_switch_wwn=excluded.physical_switch_wwn,
        ip_address=excluded.ip_address, model=excluded.model, model_number=excluded.model_number,
        firmware_version=excluded.firmware_version, serial_number=excluded.serial_number, fabric_name=excluded.fabric_name,
        principal_switch_wwn=excluded.principal_switch_wwn, domain_id=excluded.domain_id, role=excluded.role,
        state=excluded.state, status=excluded.status, operational_status=excluded.operational_status,
        health=excluded.health, status_reason=excluded.status_reason, is_missing=excluded.is_missing,
        monitored=excluded.monitored, discovered_port_count=excluded.discovered_port_count, max_port=excluded.max_port,
        switch_mode=excluded.switch_mode, management_state=excluded.management_state, eos_status=excluded.eos_status,
        maintenance_mode=excluded.maintenance_mode, tls_cert_expiry_ms=excluded.tls_cert_expiry_ms,
        trufos_status=excluded.trufos_status, virtual_fabric_id=excluded.virtual_fabric_id,
        chassis_type=excluded.chassis_type, vendor=excluded.vendor, stale=0, raw_json=excluded.raw_json, updated_at=datetime('now')
    `);
    for (const s of rows) {
      if (!s.wwn) continue;
      stmt.run(sourceId, s.sannavId, s.wwn, s.name, s.physicalSwitchWwn, s.ipAddress, s.model, s.modelNumber,
        s.firmwareVersion, s.serialNumber, s.fabricName, s.principalSwitchWwn, s.domainId, s.role, s.state,
        s.status, s.operationalStatus, s.health, s.statusReason, s.isMissing, s.monitored, s.discoveredPortCount,
        s.maxPort, s.switchMode, s.managementState, s.eosStatus, s.maintenanceMode, s.tlsCertExpiryMs,
        s.trufosStatus, s.virtualFabricId, s.chassisType, s.vendor, s.rawJson);
      seen.push(s.wwn);
    }
    if (seen.length) {
      const ph = seen.map(() => '?').join(',');
      db.prepare(`UPDATE brocade_switches SET stale=1 WHERE source_id=? AND wwn NOT IN (${ph})`).run(sourceId, ...seen);
    } else {
      db.prepare('UPDATE brocade_switches SET stale=1 WHERE source_id=?').run(sourceId);
    }
  });

  const upsertSwitchPorts = db.transaction((sourceId, rows) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_switch_ports (source_id, sannav_id, wwn, switch_wwn, switch_name, name, slot_number,
        port_number, port_index, port_id, type, state, status, health, calculated_status, status_message, speed,
        speed_type, max_port_speed, remote_device, remote_port_wwn, remote_node_wwn, connected_device_type,
        trunked, trunk_master, fenced, blocked, persistent_disable, is_missing, monitored, occupied, licensed,
        last_update_ms, active_zone_count, zone_alias, fabric_name, virtual_fabric_id, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT(source_id, wwn) DO UPDATE SET
        sannav_id=excluded.sannav_id, switch_wwn=excluded.switch_wwn, switch_name=excluded.switch_name,
        name=excluded.name, slot_number=excluded.slot_number, port_number=excluded.port_number,
        port_index=excluded.port_index, port_id=excluded.port_id, type=excluded.type, state=excluded.state,
        status=excluded.status, health=excluded.health, calculated_status=excluded.calculated_status,
        status_message=excluded.status_message, speed=excluded.speed, speed_type=excluded.speed_type,
        max_port_speed=excluded.max_port_speed, remote_device=excluded.remote_device,
        remote_port_wwn=excluded.remote_port_wwn, remote_node_wwn=excluded.remote_node_wwn,
        connected_device_type=excluded.connected_device_type, trunked=excluded.trunked,
        trunk_master=excluded.trunk_master, fenced=excluded.fenced, blocked=excluded.blocked,
        persistent_disable=excluded.persistent_disable, is_missing=excluded.is_missing, monitored=excluded.monitored,
        occupied=excluded.occupied, licensed=excluded.licensed, last_update_ms=excluded.last_update_ms,
        active_zone_count=excluded.active_zone_count, zone_alias=excluded.zone_alias, fabric_name=excluded.fabric_name,
        virtual_fabric_id=excluded.virtual_fabric_id, stale=0, updated_at=datetime('now')
    `);
    for (const p of rows) {
      if (!p.wwn) continue;
      stmt.run(sourceId, p.sannavId, p.wwn, p.switchWwn, p.switchName, p.name, p.slotNumber, p.portNumber,
        p.portIndex, p.portId, p.type, p.state, p.status, p.health, p.calculatedStatus, p.statusMessage, p.speed,
        p.speedType, p.maxPortSpeed, p.remoteDevice, p.remotePortWwn, p.remoteNodeWwn, p.connectedDeviceType,
        p.trunked, p.trunkMaster, p.fenced, p.blocked, p.persistentDisable, p.isMissing, p.monitored, p.occupied,
        p.licensed, p.lastUpdateMs, p.activeZoneCount, p.zoneAlias, p.fabricName, p.virtualFabricId);
      seen.push(p.wwn);
    }
    if (seen.length) {
      const ph = seen.map(() => '?').join(',');
      db.prepare(`UPDATE brocade_switch_ports SET stale=1 WHERE source_id=? AND wwn NOT IN (${ph})`).run(sourceId, ...seen);
    } else {
      db.prepare('UPDATE brocade_switch_ports SET stale=1 WHERE source_id=?').run(sourceId);
    }
  });

  const upsertDevicePorts = db.transaction((sourceId, rows) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_device_ports (source_id, sannav_id, wwn, device_node_wwn, symbolic_name,
        device_symbolic_name, vendor, port_role, type, fabric_name, switch_wwn, switch_name, switch_port_wwn,
        switch_port_name, slot_number, port_number, port_id, enclosure_id, enclosure_guid, enclosure_name,
        fdmi_host_name, active_zones, active_zone_count, active_zoneset_name, zone_alias, is_missing, speed,
        stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT(source_id, wwn) DO UPDATE SET
        sannav_id=excluded.sannav_id, device_node_wwn=excluded.device_node_wwn, symbolic_name=excluded.symbolic_name,
        device_symbolic_name=excluded.device_symbolic_name, vendor=excluded.vendor, port_role=excluded.port_role,
        type=excluded.type, fabric_name=excluded.fabric_name, switch_wwn=excluded.switch_wwn,
        switch_name=excluded.switch_name, switch_port_wwn=excluded.switch_port_wwn,
        switch_port_name=excluded.switch_port_name, slot_number=excluded.slot_number, port_number=excluded.port_number,
        port_id=excluded.port_id, enclosure_id=excluded.enclosure_id, enclosure_guid=excluded.enclosure_guid,
        enclosure_name=excluded.enclosure_name, fdmi_host_name=excluded.fdmi_host_name,
        active_zones=excluded.active_zones, active_zone_count=excluded.active_zone_count,
        active_zoneset_name=excluded.active_zoneset_name, zone_alias=excluded.zone_alias,
        is_missing=excluded.is_missing, speed=excluded.speed, stale=0, updated_at=datetime('now')
    `);
    for (const p of rows) {
      if (!p.wwn) continue;
      stmt.run(sourceId, p.sannavId, p.wwn, p.deviceNodeWwn, p.symbolicName, p.deviceSymbolicName, p.vendor,
        p.portRole, p.type, p.fabricName, p.switchWwn, p.switchName, p.switchPortWwn, p.switchPortName,
        p.slotNumber, p.portNumber, p.portId, p.enclosureId, p.enclosureGuid, p.enclosureName, p.fdmiHostName,
        p.activeZones, p.activeZoneCount, p.activeZonesetName, p.zoneAlias, p.isMissing, p.speed);
      seen.push(p.wwn);
    }
    if (seen.length) {
      const ph = seen.map(() => '?').join(',');
      db.prepare(`UPDATE brocade_device_ports SET stale=1 WHERE source_id=? AND wwn NOT IN (${ph})`).run(sourceId, ...seen);
    } else {
      db.prepare('UPDATE brocade_device_ports SET stale=1 WHERE source_id=?').run(sourceId);
    }
  });

  const upsertEnclosures = db.transaction((sourceId, rows) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_enclosures (source_id, sannav_id, guid, name, type, host_name, ip_address, vendor,
        model, health, location, contact, tags, stale, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
      ON CONFLICT(source_id, guid) DO UPDATE SET
        sannav_id=excluded.sannav_id, name=excluded.name, type=excluded.type, host_name=excluded.host_name,
        ip_address=excluded.ip_address, vendor=excluded.vendor, model=excluded.model, health=excluded.health,
        location=excluded.location, contact=excluded.contact, tags=excluded.tags, stale=0,
        raw_json=excluded.raw_json, updated_at=datetime('now')
    `);
    for (const e of rows) {
      if (!e.guid) continue;
      stmt.run(sourceId, e.sannavId, e.guid, e.name, e.type, e.hostName, e.ipAddress, e.vendor, e.model,
        e.health, e.location, e.contact, e.tags, e.rawJson);
      seen.push(e.guid);
    }
    if (seen.length) {
      const ph = seen.map(() => '?').join(',');
      db.prepare(`UPDATE brocade_enclosures SET stale=1 WHERE source_id=? AND guid NOT IN (${ph})`).run(sourceId, ...seen);
    } else {
      db.prepare('UPDATE brocade_enclosures SET stale=1 WHERE source_id=?').run(sourceId);
    }
  });

  const upsertChassis = db.transaction((sourceId, rows) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_chassis (source_id, switch_id, wwn, name, ip_address, model_number, firmware,
        serial_number, part_number, vendor, max_port, num_virtual_switches, max_virtual_switches,
        tls_cert_expiry_ms, stale, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
      ON CONFLICT(source_id, wwn) DO UPDATE SET
        switch_id=excluded.switch_id, name=excluded.name, ip_address=excluded.ip_address,
        model_number=excluded.model_number, firmware=excluded.firmware, serial_number=excluded.serial_number,
        part_number=excluded.part_number, vendor=excluded.vendor, max_port=excluded.max_port,
        num_virtual_switches=excluded.num_virtual_switches, max_virtual_switches=excluded.max_virtual_switches,
        tls_cert_expiry_ms=excluded.tls_cert_expiry_ms, stale=0, raw_json=excluded.raw_json, updated_at=datetime('now')
    `);
    for (const c of rows) {
      if (!c.wwn) continue;
      stmt.run(sourceId, c.switchId, c.wwn, c.name, c.ipAddress, c.modelNumber, c.firmware, c.serialNumber,
        c.partNumber, c.vendor, c.maxPort, c.numVirtualSwitches, c.maxVirtualSwitches, c.tlsCertExpiryMs, c.rawJson);
      seen.push(c.wwn);
    }
    if (seen.length) {
      const ph = seen.map(() => '?').join(',');
      db.prepare(`UPDATE brocade_chassis SET stale=1 WHERE source_id=? AND wwn NOT IN (${ph})`).run(sourceId, ...seen);
    } else {
      db.prepare('UPDATE brocade_chassis SET stale=1 WHERE source_id=?').run(sourceId);
    }
  });

  const upsertHealthScores = db.transaction((sourceId, entityType, rows) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_health_scores (source_id, entity_type, entity_name, entity_guid, entity_wwn, entity_ip,
        fid, fabric_name, score, status, computation_time, computation_ms, contributors_json, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT(source_id, entity_type, entity_guid) DO UPDATE SET
        entity_name=excluded.entity_name, entity_wwn=excluded.entity_wwn, entity_ip=excluded.entity_ip,
        fid=excluded.fid, fabric_name=excluded.fabric_name, score=excluded.score, status=excluded.status,
        computation_time=excluded.computation_time, computation_ms=excluded.computation_ms,
        contributors_json=excluded.contributors_json, stale=0, updated_at=datetime('now')
    `);
    for (const h of rows) {
      const guid = h.entityGuid || h.entityName;
      if (!guid) continue;
      stmt.run(sourceId, entityType, h.entityName, guid, h.entityWwn, h.entityIp, h.fid, h.fabricName, h.score,
        h.status, h.computationTime, h.computationMs, h.contributorsJson);
      seen.push(guid);
    }
    if (seen.length) {
      const ph = seen.map(() => '?').join(',');
      db.prepare(`UPDATE brocade_health_scores SET stale=1 WHERE source_id=? AND entity_type=? AND entity_guid NOT IN (${ph})`).run(sourceId, entityType, ...seen);
    } else {
      db.prepare('UPDATE brocade_health_scores SET stale=1 WHERE source_id=? AND entity_type=?').run(sourceId, entityType);
    }
  });

  const upsertFcrRoutes = db.transaction((sourceId, topology) => {
    const seen = [];
    const stmt = db.prepare(`
      INSERT INTO brocade_fcr_routes (source_id, backbone_fabric_id, backbone_wwn, backbone_ip, edge_fabrics, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT(source_id, backbone_wwn, backbone_fabric_id) DO UPDATE SET
        backbone_ip=excluded.backbone_ip, edge_fabrics=excluded.edge_fabrics, stale=0, updated_at=datetime('now')
    `);
    for (const t of topology) {
      for (const bs of t.backboneSwitches) {
        if (!bs.backboneSwitchWwn) continue;
        stmt.run(sourceId, t.backboneFabricId, bs.backboneSwitchWwn, bs.backboneIpAddress, JSON.stringify(bs.edgeFabrics || []));
        seen.push(`${bs.backboneSwitchWwn}|${t.backboneFabricId}`);
      }
    }
    if (seen.length) {
      for (const row of db.prepare('SELECT id, backbone_wwn, backbone_fabric_id FROM brocade_fcr_routes WHERE source_id = ?').all(sourceId)) {
        if (!seen.includes(`${row.backbone_wwn}|${row.backbone_fabric_id}`)) {
          db.prepare('UPDATE brocade_fcr_routes SET stale=1 WHERE id=?').run(row.id);
        }
      }
    } else {
      db.prepare('UPDATE brocade_fcr_routes SET stale=1 WHERE source_id=?').run(sourceId);
    }
  });

  const upsertPortStats = db.transaction((sourceId, sw, statsRows) => {
    const ports = db.prepare('SELECT wwn, slot_number, port_number FROM brocade_switch_ports WHERE source_id = ? AND switch_wwn = ?').all(sourceId, sw.wwn);
    const portByKey = new Map(ports.map((p) => [`${p.slot_number ?? 0}/${p.port_number}`, p]));
    const prevStmt = db.prepare(`
      SELECT in_frames, out_frames, in_octets, out_octets, crc_errors, CAST(strftime('%s', ts) AS INTEGER) AS ts_epoch
      FROM brocade_port_stats WHERE source_id = ? AND port_wwn = ? ORDER BY ts DESC LIMIT 1
    `);
    const insert = db.prepare(`
      INSERT INTO brocade_port_stats (source_id, port_wwn, switch_wwn, ts, in_frames, out_frames, in_octets, out_octets,
        crc_errors, invalid_words, in_frames_per_sec, out_frames_per_sec, in_mb_per_sec, out_mb_per_sec,
        crc_errors_delta, interval_secs)
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of statsRows) {
      if (!r.name) continue;
      const port = portByKey.get(r.name);
      if (!port) continue;
      const prev = prevStmt.get(sourceId, port.wwn);
      let inFps = null, outFps = null, inMbps = null, outMbps = null, crcDelta = null, intervalSecs = null;
      if (prev && prev.ts_epoch != null) {
        intervalSecs = Math.max(1, Math.round(Date.now() / 1000) - prev.ts_epoch);
        const delta = (cur, prior) => (cur != null && prior != null ? cur - prior : null);
        const dIn = delta(r.inFrames, prev.in_frames);
        const dOut = delta(r.outFrames, prev.out_frames);
        const dInOct = delta(r.inOctets, prev.in_octets);
        const dOutOct = delta(r.outOctets, prev.out_octets);
        const dCrc = delta(r.crcErrors, prev.crc_errors);
        if (dIn != null && dIn >= 0) inFps = Math.round((dIn / intervalSecs) * 100) / 100;
        if (dOut != null && dOut >= 0) outFps = Math.round((dOut / intervalSecs) * 100) / 100;
        if (dInOct != null && dInOct >= 0) inMbps = Math.round((dInOct / intervalSecs / 1e6) * 100) / 100;
        if (dOutOct != null && dOutOct >= 0) outMbps = Math.round((dOutOct / intervalSecs / 1e6) * 100) / 100;
        if (dCrc != null && dCrc >= 0) crcDelta = dCrc;
      }
      insert.run(sourceId, port.wwn, sw.wwn, r.inFrames, r.outFrames, r.inOctets, r.outOctets, r.crcErrors,
        r.invalidWords, inFps, outFps, inMbps, outMbps, crcDelta, intervalSecs);
    }
  });

  const upsertEvents = db.transaction((sourceId, rows) => {
    const stmt = db.prepare(`
      INSERT INTO brocade_events (source_id, event_id, severity, severity_norm, event_category, source_name,
        source_address, source_type, source_wwn, fabric_name, message_id, origin, module, description,
        event_count, first_occurred_ms, last_occurred_ms, acknowledged, ack_by, ack_notes, acked_time_ms,
        product_name, product_address, port_wwn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, event_id) DO UPDATE SET
        event_count=excluded.event_count, last_occurred_ms=excluded.last_occurred_ms,
        acknowledged=excluded.acknowledged, ack_by=excluded.ack_by, ack_notes=excluded.ack_notes,
        acked_time_ms=excluded.acked_time_ms, severity=excluded.severity, severity_norm=excluded.severity_norm,
        description=excluded.description
    `);
    for (const e of rows) {
      if (!e.eventId) continue;
      stmt.run(sourceId, e.eventId, e.severity, e.severityNorm, e.eventCategory, e.sourceName, e.sourceAddress,
        e.sourceType, e.sourceWwn, e.fabricName, e.messageId, e.origin, e.module, e.description, e.eventCount,
        e.firstOccurredMs, e.lastOccurredMs, e.acknowledged, e.ackBy, e.ackNotes, e.ackedTimeMs, e.productName,
        e.productAddress, e.portWwn);
    }
  });

  return {
    upsertFabrics, upsertSwitches, upsertSwitchPorts, upsertDevicePorts, upsertEnclosures,
    upsertChassis, upsertHealthScores, upsertFcrRoutes, upsertPortStats, upsertEvents,
  };
}

// ── Zoning: fetch per fabric, diff vs stored state ──────────────────────────
// Addendum 2: when fos_direct_enabled, direct-FOS (each switch's own /rest
// API) is the PRIMARY zoning path per fabric, with a per-fabric fallback to
// the SanNav FOS proxy when fos_proxy_enabled is also on. A direct-FOS
// failure records sectionErrors[`zoning_fos_<fabric>`] but never aborts the
// fabric outright while a proxy fallback is available.

async function fetchZoningForFabric(coreApi, source, f, timeout, sectionErrors) {
  if (source.fos_direct_enabled) {
    const seedSwitch = findSeedSwitchRow(coreApi, source.id, f);
    const target = resolveFosTarget(coreApi, source, seedSwitch);
    if (target) {
      try {
        const vfId = f.virtualFabricId;
        const zc = await fosApi.fetchZoneConfigs(target, coreApi, vfId, timeout);
        return { eff: zc.effective, def: zc.defined };
      } catch (err) {
        sectionErrors[`zoning_fos_${f.name}`] = fosApi.errMsg(err);
        coreApi.logger.warn(`[BrocadePoller] direct-FOS zoning (${f.name}) failed: ${fosApi.errMsg(err)}`);
      }
    } else {
      sectionErrors[`zoning_fos_${f.name}`] = 'no usable direct-FOS credentials/ip for seed switch';
    }
  }

  if (source.fos_proxy_enabled && f.seedSwitchIp) {
    const vfId = f.virtualFabricId != null && f.virtualFabricId >= 0 ? f.virtualFabricId : -1;
    const eff = await api.fetchEffectiveZoneConfig(source, coreApi, { switchIp: f.seedSwitchIp, vfId, timeout });
    let def = { configs: [], zones: [], aliases: [] };
    try {
      def = await api.fetchDefinedZoneConfig(source, coreApi, { switchIp: f.seedSwitchIp, vfId, timeout });
    } catch (err) {
      coreApi.logger.warn(`[BrocadePoller] defined-zoning (${f.name}) failed: ${safeMsg(err)}`);
    }
    return { eff, def };
  }

  return null;
}

async function pollZoning(coreApi, source, fabricRows, timeout, sectionErrors = {}) {
  const db = coreApi.db;
  if (!source.fos_direct_enabled && !source.fos_proxy_enabled) return;
  for (const f of fabricRows) {
    try {
      const result = await fetchZoningForFabric(coreApi, source, f, timeout, sectionErrors);
      if (!result) continue;
      const { eff, def } = result;
      const prior = db.prepare('SELECT checksum, cfg_name FROM brocade_zone_configs WHERE source_id = ? AND fabric_name = ? AND is_effective = 1').get(source.id, f.name);
      if (prior && eff.checksum && prior.checksum && prior.checksum !== eff.checksum) {
        db.prepare(`INSERT INTO brocade_zone_changes (source_id, fabric_name, change_type, detail, old_value, new_value) VALUES (?, ?, 'checksum_changed', ?, ?, ?)`)
          .run(source.id, f.name, 'zone database checksum changed', prior.checksum, eff.checksum);
      } else if (prior && eff.cfgName && prior.cfg_name && prior.cfg_name !== eff.cfgName) {
        db.prepare(`INSERT INTO brocade_zone_changes (source_id, fabric_name, change_type, detail, old_value, new_value) VALUES (?, ?, 'effective_cfg_changed', ?, ?, ?)`)
          .run(source.id, f.name, 'effective zone config changed', prior.cfg_name, eff.cfgName);
      }

      db.prepare('UPDATE brocade_zone_configs SET stale=1 WHERE source_id=? AND fabric_name=? AND is_effective=1').run(source.id, f.name);
      db.prepare(`
        INSERT INTO brocade_zone_configs (source_id, fabric_name, cfg_name, is_effective, member_zones, default_zone_access, checksum, db_max, db_avail, db_committed, stale, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
        ON CONFLICT(source_id, fabric_name, cfg_name) DO UPDATE SET
          is_effective=1, member_zones=excluded.member_zones, default_zone_access=excluded.default_zone_access,
          checksum=excluded.checksum, db_max=excluded.db_max, db_avail=excluded.db_avail,
          db_committed=excluded.db_committed, stale=0, updated_at=datetime('now')
      `).run(source.id, f.name, eff.cfgName || `EFFECTIVE-${f.name}`, JSON.stringify(eff.zones.map((z) => z.zoneName)),
        eff.defaultZoneAccess, eff.checksum, eff.dbMax, eff.dbAvail, eff.dbCommitted);

      const priorZoneNames = new Set(db.prepare('SELECT zone_name FROM brocade_zones WHERE source_id=? AND fabric_name=?').all(source.id, f.name).map((r) => r.zone_name));
      const newZoneNames = new Set(eff.zones.map((z) => z.zoneName).filter(Boolean));
      for (const name of newZoneNames) {
        if (!priorZoneNames.has(name)) {
          db.prepare(`INSERT INTO brocade_zone_changes (source_id, fabric_name, change_type, detail) VALUES (?, ?, 'zone_added', ?)`).run(source.id, f.name, name);
        }
      }
      for (const name of priorZoneNames) {
        if (!newZoneNames.has(name)) {
          db.prepare(`INSERT INTO brocade_zone_changes (source_id, fabric_name, change_type, detail) VALUES (?, ?, 'zone_removed', ?)`).run(source.id, f.name, name);
        }
      }

      db.prepare('UPDATE brocade_zones SET stale=1 WHERE source_id=? AND fabric_name=?').run(source.id, f.name);
      const zoneStmt = db.prepare(`
        INSERT INTO brocade_zones (source_id, fabric_name, zone_name, zone_type, zone_type_string, members, in_effective, stale, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, datetime('now'))
        ON CONFLICT(source_id, fabric_name, zone_name) DO UPDATE SET
          zone_type=excluded.zone_type, zone_type_string=excluded.zone_type_string, members=excluded.members,
          in_effective=1, stale=0, updated_at=datetime('now')
      `);
      for (const z of eff.zones) {
        if (!z.zoneName) continue;
        zoneStmt.run(source.id, f.name, z.zoneName, z.zoneType, z.zoneTypeString, JSON.stringify(z.members || []));
      }

      // Defined-only config + aliases — `def` was already fetched (best-effort) by
      // fetchZoningForFabric; a failure there yields the empty-array default and is
      // simply a no-op here rather than a second failure point.
      try {
        const definedCfgs = def.configs.filter((c) => c.cfgName && c.cfgName !== eff.cfgName);
        for (const c of definedCfgs) {
          db.prepare(`
            INSERT INTO brocade_zone_configs (source_id, fabric_name, cfg_name, is_effective, member_zones, stale, updated_at)
            VALUES (?, ?, ?, 0, ?, 0, datetime('now'))
            ON CONFLICT(source_id, fabric_name, cfg_name) DO UPDATE SET
              is_effective=0, member_zones=excluded.member_zones, stale=0, updated_at=datetime('now')
          `).run(source.id, f.name, c.cfgName, JSON.stringify(c.memberZones || []));
        }

        db.prepare('UPDATE brocade_zone_aliases SET stale=1 WHERE source_id=? AND fabric_name=?').run(source.id, f.name);
        const aliasStmt = db.prepare(`
          INSERT INTO brocade_zone_aliases (source_id, fabric_name, alias_name, members, stale, updated_at)
          VALUES (?, ?, ?, ?, 0, datetime('now'))
          ON CONFLICT(source_id, fabric_name, alias_name) DO UPDATE SET members=excluded.members, stale=0, updated_at=datetime('now')
        `);
        for (const a of def.aliases) {
          if (!a.aliasName) continue;
          aliasStmt.run(source.id, f.name, a.aliasName, JSON.stringify(a.members || []));
        }
      } catch (err) {
        coreApi.logger.warn(`[BrocadePoller] defined-zoning store (${f.name}) failed: ${safeMsg(err)}`);
      }
    } catch (err) {
      coreApi.logger.warn(`[BrocadePoller] zoning (${f.name}) failed: ${safeMsg(err)}`);
    }
  }
}

// ── Metrics rollup ───────────────────────────────────────────────────────

function writeMetrics(coreApi, sourceId) {
  const db = coreApi.db;
  const fabricTotals = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN health = 'Healthy' OR status = 1 THEN 1 ELSE 0 END) healthy FROM brocade_fabrics WHERE source_id=? AND stale=0").get(sourceId);
  const swTotals = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'HEALTHY' THEN 1 ELSE 0 END) healthy,
      SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'MARGINAL' THEN 1 ELSE 0 END) marginal,
      SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'CRITICAL' THEN 1 ELSE 0 END) critical,
      SUM(CASE WHEN is_missing = 1 THEN 1 ELSE 0 END) unreachable
    FROM brocade_switches WHERE source_id=? AND stale=0
  `).get(sourceId);
  const portTotals = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN LOWER(COALESCE(state,'')) = 'online' THEN 1 ELSE 0 END) online,
      SUM(CASE WHEN LOWER(COALESCE(state,'')) = 'offline' THEN 1 ELSE 0 END) offline,
      SUM(CASE WHEN health = 'Error' THEN 1 ELSE 0 END) error,
      SUM(CASE WHEN occupied = 1 THEN 1 ELSE 0 END) occupied
    FROM brocade_switch_ports WHERE source_id=? AND stale=0
  `).get(sourceId);
  const devicePortsTotal = db.prepare('SELECT COUNT(*) n FROM brocade_device_ports WHERE source_id=? AND stale=0').get(sourceId).n;
  const enclosureTotals = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN LOWER(COALESCE(type,'')) LIKE '%host%' THEN 1 ELSE 0 END) hosts,
      SUM(CASE WHEN LOWER(COALESCE(type,'')) LIKE '%storage%' THEN 1 ELSE 0 END) storage
    FROM brocade_enclosures WHERE source_id=? AND stale=0
  `).get(sourceId);
  const zonesTotal = db.prepare('SELECT COUNT(*) n FROM brocade_zones WHERE source_id=? AND stale=0').get(sourceId).n;
  const aliasesTotal = db.prepare('SELECT COUNT(*) n FROM brocade_zone_aliases WHERE source_id=? AND stale=0').get(sourceId).n;
  const healthAgg = db.prepare("SELECT AVG(score) avg, MIN(score) min FROM brocade_health_scores WHERE source_id=? AND stale=0 AND entity_type='FABRIC'").get(sourceId);
  const eventAgg = db.prepare(`
    SELECT SUM(CASE WHEN severity_norm IN ('critical','alert') THEN 1 ELSE 0 END) critical,
           SUM(CASE WHEN severity_norm = 'warning' THEN 1 ELSE 0 END) warning
    FROM brocade_events WHERE source_id=? AND last_occurred_ms >= ?
  `).get(sourceId, Date.now() - 86400000);

  db.prepare(`
    INSERT INTO brocade_metrics (source_id, fabrics_total, fabrics_healthy, switches_total, switches_healthy,
      switches_marginal, switches_critical, switches_unreachable, ports_total, ports_online, ports_offline,
      ports_error, ports_occupied, device_ports_total, enclosures_total, hosts_total, storage_total, zones_total,
      aliases_total, avg_fabric_health, min_fabric_health, events_critical_24h, events_warning_24h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sourceId, fabricTotals.total || 0, fabricTotals.healthy || 0, swTotals.total || 0, swTotals.healthy || 0,
    swTotals.marginal || 0, swTotals.critical || 0, swTotals.unreachable || 0, portTotals.total || 0,
    portTotals.online || 0, portTotals.offline || 0, portTotals.error || 0, portTotals.occupied || 0,
    devicePortsTotal || 0, enclosureTotals.total || 0, enclosureTotals.hosts || 0, enclosureTotals.storage || 0,
    zonesTotal || 0, aliasesTotal || 0,
    healthAgg.avg != null ? Math.round(healthAgg.avg) : null, healthAgg.min ?? null,
    eventAgg.critical || 0, eventAgg.warning || 0);
}

// ── Inventory poll ──────────────────────────────────────────────────────────

async function pollInventory(coreApi, source) {
  const db = coreApi.db;
  const stores = buildStores(coreApi);
  const timeout = 60000;
  const sectionErrors = {};

  try {
    // Login is the connectivity/credentials gate. /about/ only exists on
    // SANnav 2.3.1+ (live finding: 2.2.0 404s it) — best-effort version info,
    // never fatal.
    await api.login(source, coreApi, timeout);
    const about = await trySection(coreApi, 'about', () => api.fetchAbout(source, coreApi, timeout));
    if (about.ok) {
      db.prepare('UPDATE brocade_sources SET sannav_version=?, oem_name=? WHERE id=?')
        .run(about.data.version, about.data.oemName, source.id);
    } else {
      sectionErrors.about = about.error;
    }

    const fabricsRes = await trySection(coreApi, 'fabrics', () => api.fetchFabrics(source, coreApi, timeout));
    if (fabricsRes.ok) stores.upsertFabrics(source.id, fabricsRes.data); else sectionErrors.fabrics = fabricsRes.error;
    const fabricRows = fabricsRes.ok ? fabricsRes.data : [];

    const switchesRes = await trySection(coreApi, 'switches', () => api.fetchSwitches(source, coreApi, timeout));
    if (switchesRes.ok) stores.upsertSwitches(source.id, switchesRes.data); else sectionErrors.switches = switchesRes.error;

    const portsRes = await trySection(coreApi, 'switchports', () => api.fetchSwitchPorts(source, coreApi, timeout));
    if (portsRes.ok) stores.upsertSwitchPorts(source.id, portsRes.data); else sectionErrors.switchports = portsRes.error;

    const devicePortsRes = await trySection(coreApi, 'deviceports', () => api.fetchDevicePorts(source, coreApi, timeout));
    if (devicePortsRes.ok) stores.upsertDevicePorts(source.id, devicePortsRes.data); else sectionErrors.deviceports = devicePortsRes.error;

    const enclosuresRes = await trySection(coreApi, 'enclosures', () => api.fetchEnclosures(source, coreApi, timeout));
    if (enclosuresRes.ok) stores.upsertEnclosures(source.id, enclosuresRes.data); else sectionErrors.enclosures = enclosuresRes.error;

    const chassisRes = await trySection(coreApi, 'chassis', () => api.fetchChassis(source, coreApi, timeout));
    if (chassisRes.ok) stores.upsertChassis(source.id, chassisRes.data); else sectionErrors.chassis = chassisRes.error;

    for (const entityType of ['FABRIC', 'SWITCH', 'HOST', 'STORAGE']) {
      const res = await trySection(coreApi, `health(${entityType})`, () => api.fetchHealthSummary(source, coreApi, entityType, timeout));
      if (res.ok) stores.upsertHealthScores(source.id, entityType, res.data); else sectionErrors[`health_${entityType.toLowerCase()}`] = res.error;
    }

    const fcrRes = await trySection(coreApi, 'fcr', () => api.fetchFcrTopology(source, coreApi, timeout));
    if (fcrRes.ok) stores.upsertFcrRoutes(source.id, fcrRes.data); else sectionErrors.fcr = fcrRes.error;

    if (fabricRows.length) {
      await trySection(coreApi, 'zoning', () => pollZoning(coreApi, source, fabricRows, timeout, sectionErrors));
    }

    const governance = {};
    const pwPolicy = await trySection(coreApi, 'passwordpolicy', () => api.fetchPasswordPolicy(source, coreApi, timeout));
    if (pwPolicy.ok) governance.passwordPolicy = pwPolicy.data; else sectionErrors.passwordpolicy = pwPolicy.error;
    const users = await trySection(coreApi, 'users', () => api.fetchUsers(source, coreApi, timeout));
    if (users.ok) governance.users = users.data; else sectionErrors.users = users.error;
    const roles = await trySection(coreApi, 'roles', () => api.fetchRoles(source, coreApi, timeout));
    if (roles.ok) governance.roles = roles.data; else sectionErrors.roles = roles.error;
    const aors = await trySection(coreApi, 'aors', () => api.fetchAors(source, coreApi, timeout));
    if (aors.ok) governance.aors = aors.data; else sectionErrors.aors = aors.error;

    writeMetrics(coreApi, source.id);

    db.prepare(`
      UPDATE brocade_sources SET last_poll_status='success', last_poll_error=NULL, last_poll_at=datetime('now'),
        section_errors=?, password_policy_json=?, users_json=?, roles_json=?, aors_json=? WHERE id=?
    `).run(Object.keys(sectionErrors).length ? JSON.stringify(sectionErrors) : null,
      governance.passwordPolicy ? JSON.stringify(governance.passwordPolicy) : null,
      governance.users ? JSON.stringify(governance.users) : null,
      governance.roles ? JSON.stringify(governance.roles) : null,
      governance.aors ? JSON.stringify(governance.aors) : null,
      source.id);

    coreApi.logger.info(`[BrocadePoller] ${source.name}: ${fabricRows.length} fabric(s), ${switchesRes.ok ? switchesRes.data.length : '?'} switch(es)`);
  } catch (err) {
    db.prepare(`UPDATE brocade_sources SET last_poll_status='error', last_poll_error=?, last_poll_at=datetime('now') WHERE id=?`)
      .run(safeMsg(err), source.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[BrocadePoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

// ── Events poll ──────────────────────────────────────────────────────────

async function pollEvents(coreApi, source) {
  const db = coreApi.db;
  const stores = buildStores(coreApi);
  const timeout = 30000;
  try {
    const now = Date.now();
    const overlapMs = 60000;
    const twoHoursMs = 2 * 3600000;
    let startTime = source.event_cursor_ms ? source.event_cursor_ms - overlapMs : now - twoHoursMs;
    if (now - startTime > twoHoursMs) startTime = now - twoHoursMs;
    const endTime = now;

    let nextPageIndex = null;
    let cursorMax = source.event_cursor_ms || 0;
    let totalFetched = 0;
    for (let i = 0; i < 50; i++) {
      const page = await api.fetchEventsPage(source, coreApi, { startTime, endTime, pageSize: 1000, startIndex: 0, nextPageIndex, timeout });
      if (page.events.length) {
        stores.upsertEvents(source.id, page.events);
        totalFetched += page.events.length;
        for (const e of page.events) {
          if (e.lastOccurredMs != null && e.lastOccurredMs > cursorMax) cursorMax = e.lastOccurredMs;
        }
      }
      if (!page.nextPageIndex) break;
      nextPageIndex = page.nextPageIndex;
    }

    const retentionDays = eventRetentionDays(coreApi);
    db.prepare(`DELETE FROM brocade_events WHERE source_id = ? AND last_occurred_ms < ?`)
      .run(source.id, Date.now() - retentionDays * 86400000);

    db.prepare(`UPDATE brocade_sources SET last_event_poll_at=datetime('now'), event_cursor_ms=? WHERE id=?`)
      .run(cursorMax || endTime, source.id);

    coreApi.logger.info(`[BrocadePoller] ${source.name}: ${totalFetched} event(s) fetched`);
  } catch (err) {
    coreApi.logger.warn(`[BrocadePoller] events poll failed for ${source.name}: ${safeMsg(err)}`);
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (e2) {
      coreApi.logger.warn(`[BrocadePoller] issue-history reconcile (events) failed: ${e2.message}`);
    }
  }
}

// ── Port IO statistics poll (addendum 1) ────────────────────────────────────
// Gated on fos_proxy_enabled — this URI is outside SANnav's tested list, so a
// live server may 400 'Invalid REST URI'; that is recorded as a section error
// ('portstats_unsupported') and the rest of the poll cycle is skipped
// silently (never fails the poll / throws). Counters are cumulative since
// port/switch reset — rates are NULL on the first sample for a port and on a
// negative delta (counter wrap/reboot).

function portStatsRetentionDays(coreApi) {
  const n = Number(coreApi.settings.getSetting('brocade_port_stats_retention_days'));
  return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.round(n) : 14;
}

// Records/clears per-switch direct-FOS portstats failures in section_errors
// as `portstats_fos:<switch>` keys, or a single aggregated
// `portstats_fos: {failed, first}` summary once there are more than 5 (addendum 2).
function recordPortStatsFosErrors(coreApi, sourceId, failures) {
  const db = coreApi.db;
  try {
    const row = db.prepare('SELECT section_errors FROM brocade_sources WHERE id = ?').get(sourceId);
    let existing = {};
    try { existing = row?.section_errors ? JSON.parse(row.section_errors) : {}; } catch { existing = {}; }
    for (const k of Object.keys(existing)) {
      if (k === 'portstats_fos' || k.startsWith('portstats_fos:')) delete existing[k];
    }
    if (failures.length > 5) {
      existing.portstats_fos = { failed: failures.length, first: failures[0].msg };
    } else {
      for (const f of failures) existing[`portstats_fos:${f.switchName}`] = f.msg;
    }
    db.prepare('UPDATE brocade_sources SET section_errors = ? WHERE id = ?').run(JSON.stringify(existing), sourceId);
  } catch { /* best-effort */ }
}

async function pollPortStatsDirect(coreApi, source, switches, timeout) {
  const stores = buildStores(coreApi);
  const seenIps = new Set();
  const failures = [];
  for (const sw of switches) {
    if (!sw.ip_address || seenIps.has(sw.ip_address)) continue;
    seenIps.add(sw.ip_address);
    const target = resolveFosTarget(coreApi, source, sw);
    if (!target) continue; // no usable creds/ip for this switch — silently skipped
    try {
      const stats = await fosApi.fetchPortStats(target, coreApi, sw.virtual_fabric_id, timeout);
      if (stats.length) stores.upsertPortStats(source.id, sw, stats);
    } catch (err) {
      const msg = fosApi.errMsg(err);
      coreApi.logger.warn(`[BrocadePoller] direct-FOS portstats (${sw.name}) failed: ${msg}`);
      failures.push({ switchName: sw.name || sw.wwn || sw.ip_address, msg });
    }
    // FOS session caps are single-digit — space out sequential logins.
    await sleep(250);
  }
  recordPortStatsFosErrors(coreApi, source.id, failures);
}

async function pollPortStatsProxy(coreApi, source, switches, timeout) {
  const stores = buildStores(coreApi);
  const db = coreApi.db;
  let unsupported = false;
  for (const sw of switches) {
    if (unsupported) break;
    if (!sw.ip_address) continue;
    const vfId = sw.virtual_fabric_id != null && sw.virtual_fabric_id >= 0 ? sw.virtual_fabric_id : -1;
    try {
      const stats = await api.fetchPortStats(source, coreApi, { switchIp: sw.ip_address, vfId, timeout });
      if (stats.length) stores.upsertPortStats(source.id, sw, stats);
    } catch (err) {
      if (api.isUnsupportedUriError(err)) {
        unsupported = true;
        try {
          const row = db.prepare('SELECT section_errors FROM brocade_sources WHERE id = ?').get(source.id);
          let existing = {};
          try { existing = row?.section_errors ? JSON.parse(row.section_errors) : {}; } catch { existing = {}; }
          existing.portstats = 'portstats_unsupported';
          db.prepare('UPDATE brocade_sources SET section_errors = ? WHERE id = ?').run(JSON.stringify(existing), source.id);
        } catch { /* best-effort */ }
      } else {
        coreApi.logger.warn(`[BrocadePoller] portstats (${sw.name}) failed: ${safeMsg(err)}`);
      }
    }
  }
}

async function pollPortStats(coreApi, source) {
  const db = coreApi.db;
  if (!source.fos_proxy_enabled && !source.fos_direct_enabled) return;
  const timeout = 30000;
  const switches = db.prepare('SELECT * FROM brocade_switches WHERE source_id = ? AND stale = 0').all(source.id);

  if (source.fos_direct_enabled) {
    await pollPortStatsDirect(coreApi, source, switches, timeout);
  } else if (source.fos_proxy_enabled) {
    await pollPortStatsProxy(coreApi, source, switches, timeout);
  }

  try {
    const retentionDays = portStatsRetentionDays(coreApi);
    db.prepare(`DELETE FROM brocade_port_stats WHERE source_id = ? AND ts < datetime('now', ?)`)
      .run(source.id, `-${retentionDays} days`);
  } catch (err) {
    coreApi.logger.warn(`[BrocadePoller] portstats retention prune failed: ${err.message}`);
  }
}

// ── Poller framework instances ──────────────────────────────────────────────

function buildHandle(coreApi) {
  const loadSources = () => coreApi.db.prepare('SELECT * FROM brocade_sources WHERE enabled = 1').all();

  const inventoryPoller = coreApi.createPoller({
    id: 'brocade',
    loadSources,
    intervalMinutes: (s) => s.polling_interval_minutes,
    poll: (s) => pollInventory(coreApi, s),
  });

  const eventsPoller = coreApi.createPoller({
    id: 'brocade-events',
    loadSources,
    intervalMinutes: (s) => s.event_poll_minutes,
    poll: (s) => pollEvents(coreApi, s),
  });

  const portStatsPoller = coreApi.createPoller({
    id: 'brocade-portstats',
    loadSources,
    intervalMinutes: (s) => s.port_stats_interval_minutes,
    poll: (s) => pollPortStats(coreApi, s),
  });

  const bySourceId = (sourceOrId) => (typeof sourceOrId === 'object' ? sourceOrId
    : coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(sourceOrId));

  return {
    init: () => {
      const inv = inventoryPoller.init();
      const evt = eventsPoller.init();
      const ps = portStatsPoller.init();
      coreApi.logger.info(`[BrocadePoller] Initialized ${inv.length} source(s) (inventory), ${evt.length} (events), ${ps.length} (portstats)`);
      return inv;
    },
    stopAll: () => {
      inventoryPoller.stopAll();
      eventsPoller.stopAll();
      portStatsPoller.stopAll();
    },
    trigger: (sourceOrId) => {
      const source = bySourceId(sourceOrId);
      return source ? inventoryPoller.trigger(source) : Promise.resolve();
    },
    triggerEvents: (sourceOrId) => {
      const source = bySourceId(sourceOrId);
      return source ? eventsPoller.trigger(source) : Promise.resolve();
    },
    triggerPortStats: (sourceOrId) => {
      const source = bySourceId(sourceOrId);
      return source ? portStatsPoller.trigger(source) : Promise.resolve();
    },
    schedule: (source) => {
      inventoryPoller.schedule(source);
      eventsPoller.schedule(source);
      portStatsPoller.schedule(source);
    },
    cancel: (sourceId) => {
      inventoryPoller.cancel(sourceId);
      eventsPoller.cancel(sourceId);
      portStatsPoller.cancel(sourceId);
    },
    taskCount: () => inventoryPoller.taskCount() + eventsPoller.taskCount() + portStatsPoller.taskCount(),
  };
}

/** Shared singleton handle (schedule/cancel/trigger/init/stopAll across all
 *  three pollers), built lazily on first access regardless of whether
 *  createRouter or manifest.createPoller reaches it first. */
function getHandle(coreApi) {
  if (!handleInstance) handleInstance = buildHandle(coreApi);
  return handleInstance;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js), so demo timestamps
 *  stay relative to boot. Real instances never seed. Returns a handle
 *  mirroring the built-in's createBrocadePollerHandle() shape. */
function createBrocadePoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    const seedDemo = () => {
      try {
        const { seedBrocadeDemo } = require('./demoSeed');
        const r = seedBrocadeDemo(coreApi);
        coreApi.logger.info(`[BrocadePoller] demo estate seeded: ${r.sources} source(s), ${r.switches} switches, ${r.fabrics} fabrics`);
        return r;
      } catch (err) {
        coreApi.logger.warn(`[BrocadePoller] demo seed failed: ${err.message}`);
        return null;
      }
    };
    seedDemo();
    // Demo instances seed fixtures but NEVER poll them: the seeded SANnav
    // hosts are fictitious internal names, but polling them for real would
    // still hammer DNS/connect failures every cycle and eventually flip the
    // pristine demo estate to error state — exactly the failure unifi/dell's
    // demo mode was built to avoid. trigger() re-seeds instead, matching the
    // demo Refresh button semantics.
    return {
      init: () => { coreApi.logger.info('[BrocadePoller] demo mode — polling disabled, fixtures only'); return []; },
      stopAll: () => {},
      trigger: () => { seedDemo(); return Promise.resolve(); },
      triggerEvents: () => { seedDemo(); return Promise.resolve(); },
      triggerPortStats: () => { seedDemo(); return Promise.resolve(); },
      schedule: () => {},
      cancel: () => {},
      taskCount: () => 0,
    };
  }

  return getHandle(coreApi);
}

module.exports = {
  createBrocadePoller,
  getHandle,
  pollInventory,
  pollEvents,
  pollPortStats,
  portStatsRetentionDays,
  // exported for reuse by router.js (fos-test, probe fos-direct section)
  resolveFosTarget,
  findSeedSwitchRow,
};
