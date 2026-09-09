// BlueCat poller — TWO framework pollers over bluecat_sources (Brocade
// precedent, contract section 5): id 'bluecat' (inventory: version, views,
// zones, records, blocks, networks, ranges, gateway resolution, devices,
// servers, roles, deployments, metrics) and id 'bluecat-enumerate' (per-
// network address enumeration + counts). Every section runs through
// trySection so a transient API failure keeps prior rows in place.
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const bluecatApi = require('./bluecatApi');
const { reconcileIssueHistory, lowFreeWarn } = require('./bluecatIssues');
const logger = require('../utils/logger');

const safeMsg = (e) => bluecatApi.errMsg(e);

async function trySection(label, fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    logger.warn(`[BluecatPoller] ${label} failed: ${safeMsg(err)}`);
    return { ok: false, error: safeMsg(err) };
  }
}

// ── Store helpers ────────────────────────────────────────────────────────

const storeViews = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_views WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_views (source_id, view_id, configuration_id, configuration_name, name, zone_count, record_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of rows) {
    if (v.id == null) continue;
    stmt.run(sourceId, v.id, v.configurationId, v.configurationName, v.name, v.zoneCount || 0, v.recordCount || 0);
  }
});

const storeZones = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_zones WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_zones (source_id, zone_id, view_id, parent_zone_id, name, absolute_name, zone_type,
      deployment_enabled, dynamic_update_enabled, signed, record_count, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const z of rows) {
    if (z.id == null) continue;
    stmt.run(sourceId, z.id, z.viewId, z.parentZoneId ?? null, z.name, z.absoluteName, z.type,
      z.deploymentEnabled, z.dynamicUpdateEnabled, z.signed, z.recordCount || 0, bluecatApi.jsonOrNull(z.raw));
  }
});

const storeRecords = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_records WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_records (source_id, record_id, zone_id, view_id, name, absolute_name, record_type,
      rr_type, rdata, ttl, addresses_json, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    if (r.id == null) continue;
    stmt.run(sourceId, r.id, r.zoneId, r.viewId, r.name, r.absoluteName, r.type,
      r.rrType, r.rdata, r.ttl, bluecatApi.jsonOrNull(r.addresses), r.comment);
  }
});

const storeBlocks = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_blocks WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_blocks (source_id, block_id, parent_block_id, configuration_id, name, range, prefix,
      ip_version, location_name, usage_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const b of rows) {
    if (b.id == null) continue;
    stmt.run(sourceId, b.id, b.parentBlockId, b.configurationId, b.name, b.range, b.prefix,
      b.ipVersion, b.locationName, bluecatApi.jsonOrNull(b.usage));
  }
});

const storeNetworks = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_networks WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_networks (source_id, network_id, block_id, configuration_id, name, range, prefix,
      ip_version, capacity, gateway, gateway_source, default_view_id, location_name, ping_before_assign,
      low_water_mark, high_water_mark, used_static, dhcp_pool, dhcp_used, free_static, free_pct,
      counts_source, enumerated_at, usage_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of rows) {
    if (n.id == null) continue;
    stmt.run(sourceId, n.id, n.blockId, n.configurationId, n.name, n.range, n.prefix, n.ipVersion,
      n.capacity, n.gateway, n.gatewaySource, n.defaultViewId, n.locationName, n.pingBeforeAssign,
      n.lowWaterMark, n.highWaterMark, n.usedStatic ?? null, n.dhcpPool ?? null, n.dhcpUsed ?? null,
      n.freeStatic ?? null, n.freePct ?? null, n.countsSource ?? null, n.enumeratedAt ?? null,
      bluecatApi.jsonOrNull(n.usage), bluecatApi.jsonOrNull(n.raw));
  }
});

const storeRanges = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_ranges WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_ranges (source_id, range_id, network_id, name, range_type, start_ip, end_ip, size,
      dhcp_used, free_dhcp, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    if (r.id == null) continue;
    stmt.run(sourceId, r.id, r.networkId, r.name, r.type, r.startIp, r.endIp, r.size,
      r.dhcpUsed ?? null, r.freeDhcp ?? null, bluecatApi.jsonOrNull(r.raw));
  }
});

const storeDevices = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_devices WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_devices (source_id, device_id, configuration_id, name, device_type, device_subtype,
      description, addresses_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of rows) {
    if (d.id == null) continue;
    stmt.run(sourceId, d.id, d.configurationId, d.name, d.deviceType, d.deviceSubtype, d.description,
      bluecatApi.jsonOrNull(d.addresses), bluecatApi.jsonOrNull(d.raw));
  }
});

const storeServers = db.transaction((sourceId, rows) => {
  db.prepare('DELETE FROM bluecat_servers WHERE source_id = ?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_servers (source_id, server_id, configuration_id, name, address, profile, version,
      connected, state, interfaces_json, roles_json, last_deploy_status, last_deploy_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of rows) {
    if (s.id == null) continue;
    stmt.run(sourceId, s.id, s.configurationId, s.name, s.address, s.profile, s.version,
      s.connected, s.state, bluecatApi.jsonOrNull(s.interfaces), bluecatApi.jsonOrNull(s.roles),
      s.lastDeployStatus ?? null, s.lastDeployAt ?? null, bluecatApi.jsonOrNull(s.raw));
  }
});

const appendMetricsHistory = db.transaction((sourceId, m) => {
  db.prepare(`
    INSERT INTO bluecat_metrics_history (source_id, views, zones, records, networks, networks_low_space,
      ranges_low_space, devices, servers, servers_down)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sourceId, m.views, m.zones, m.records, m.networks, m.networksLowSpace, m.rangesLowSpace,
    m.devices, m.servers, m.serversDown);
  db.prepare("DELETE FROM bluecat_metrics_history WHERE captured_at < datetime('now', '-90 days')").run();
});

// ── Zone view resolution (walk parent chain when a zone carries no view) ───

function resolveZoneViews(zones) {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const zoneIdFromHref = (href) => {
    if (!href) return null;
    const m = href.match(/\/zones\/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const viewIdFromHref = (href) => {
    if (!href) return null;
    const m = href.match(/\/views\/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  for (const z of zones) {
    z.parentZoneId = zoneIdFromHref(z.upHref);
    if (z.viewId == null) {
      const direct = viewIdFromHref(z.upHref);
      if (direct != null) { z.viewId = direct; continue; }
    }
  }
  const resolveFor = (z, depth) => {
    if (z.viewId != null || depth > 25) return z.viewId ?? null;
    const parentId = z.parentZoneId;
    if (parentId == null) return null;
    const parent = byId.get(parentId);
    if (!parent) return null;
    const v = resolveFor(parent, depth + 1);
    if (v != null) z.viewId = v;
    return v;
  };
  for (const z of zones) resolveFor(z, 0);
  return zones;
}

// ── Networks / ranges / gateway resolution ──────────────────────────────────

const ADDRESS_STATE_COUNTED = new Set(['STATIC', 'RESERVED', 'GATEWAY', 'DHCP_RESERVED']);
const ADDRESS_STATE_FREE = new Set(['UNASSIGNED', 'UNALLOCATED', 'DHCP_FREE']);

function computeUsageBasedCounts(usage, capacity, dhcpPool) {
  const u = usage || {};
  const usedStatic = (u.static || 0) + (u.reserved || 0) + (u.dhcpReserved || 0);
  const freeStatic = u.unassigned != null
    ? u.unassigned
    : Math.max(0, (capacity || 0) - (dhcpPool || 0) - usedStatic);
  return { usedStatic, freeStatic };
}

async function fetchRangesForNetwork(source, networkId, timeout) {
  const rows = await bluecatApi.fetchRanges(source, networkId, timeout);
  return rows.map((r) => ({ ...r, networkId }));
}

async function pollInventory(source) {
  const timeout = 60000;

  try {
    const versionRes = await trySection('version+configurations', async () => {
      const version = await bluecatApi.fetchVersion(source, timeout);
      const configurations = await bluecatApi.fetchConfigurations(source, timeout);
      return { version, configurations };
    });
    const configurations = versionRes.ok ? versionRes.data.configurations : [];
    if (versionRes.ok) {
      db.prepare('UPDATE bluecat_sources SET bam_version = ?, configurations_json = ? WHERE id = ?')
        .run(versionRes.data.version, bluecatApi.jsonOrNull(configurations), source.id);
    }

    const viewsRes = await trySection('views', async () => {
      const out = [];
      for (const c of configurations) {
        const rows = await bluecatApi.fetchViews(source, c.id, timeout);
        for (const v of rows) out.push({ ...v, configurationId: v.configurationId ?? c.id, configurationName: v.configurationName ?? c.name });
      }
      return out;
    });
    let views = viewsRes.ok ? viewsRes.data : [];

    const zonesRes = await trySection('zones', () => bluecatApi.fetchZones(source, timeout));
    let zones = zonesRes.ok ? resolveZoneViews(zonesRes.data) : [];

    const recordsRes = await trySection('records', () => bluecatApi.fetchResourceRecords(source, timeout));
    const records = recordsRes.ok ? recordsRes.data : [];

    // Attribute a record's view via its zone when the record itself carries none.
    const zoneById = new Map(zones.map((z) => [z.id, z]));
    for (const r of records) {
      if (r.viewId == null && r.zoneId != null) {
        const z = zoneById.get(r.zoneId);
        if (z) r.viewId = z.viewId ?? null;
      }
    }

    if (recordsRes.ok) {
      const recordCountByZone = new Map();
      for (const r of records) {
        if (r.zoneId == null) continue;
        recordCountByZone.set(r.zoneId, (recordCountByZone.get(r.zoneId) || 0) + 1);
      }
      for (const z of zones) z.recordCount = recordCountByZone.get(z.id) || 0;
    }
    if (zonesRes.ok) storeZones(source.id, zones);
    if (recordsRes.ok) storeRecords(source.id, records);

    if (viewsRes.ok || zonesRes.ok) {
      const zoneCountByView = new Map();
      const recordCountByView = new Map();
      for (const z of zones) {
        if (z.viewId == null) continue;
        zoneCountByView.set(z.viewId, (zoneCountByView.get(z.viewId) || 0) + 1);
        recordCountByView.set(z.viewId, (recordCountByView.get(z.viewId) || 0) + (z.recordCount || 0));
      }
      views = views.map((v) => ({ ...v, zoneCount: zoneCountByView.get(v.id) || 0, recordCount: recordCountByView.get(v.id) || 0 }));
      storeViews(source.id, views);
    }

    const blocksRes = await trySection('blocks', () => bluecatApi.fetchBlocks(source, timeout));
    if (blocksRes.ok) storeBlocks(source.id, blocksRes.data);

    const networksRes = await trySection('networks', () => bluecatApi.fetchNetworks(source, timeout));
    if (networksRes.ok) {
      const networks = networksRes.data;
      const usageMode = await trySection('usage-probe', () => bluecatApi.probeNetworkUsage(source, timeout));
      const usesUsage = usageMode.ok && usageMode.data;

      const priorByNetworkId = new Map(
        db.prepare('SELECT * FROM bluecat_networks WHERE source_id = ?').all(source.id).map((n) => [n.network_id, n])
      );
      const overridesByNetworkId = new Map(
        db.prepare('SELECT * FROM bluecat_network_overrides WHERE source_id = ?').all(source.id).map((o) => [o.network_id, o])
      );

      const allRanges = [];
      const dhcpPoolByNetwork = new Map();
      const networkIds = new Set(networks.filter((n) => n.ipVersion === 4).map((n) => n.id));
      // One flat /ranges call beats 600+ per-network calls; fall back to the
      // per-network subcollection only when the flat call fails or returns
      // rows without a parent link.
      const flat = await trySection('ranges(flat)', () => bluecatApi.fetchAllRanges(source, timeout));
      const flatUsable = flat.ok && flat.data.length > 0 && flat.data.every((r) => r.networkId != null);
      if (flat.ok && !flatUsable) {
        logger.info(`[BluecatPoller] ${source.name}: flat /ranges returned ${flat.data.length} row(s) (${flat.data.filter((r) => r.networkId == null).length} without a network link); using per-network ranges`);
      }
      if (flatUsable) {
        for (const r of flat.data) {
          if (!networkIds.has(r.networkId)) continue;
          allRanges.push(r);
          dhcpPoolByNetwork.set(r.networkId, (dhcpPoolByNetwork.get(r.networkId) || 0) + (r.size || 0));
        }
        for (const id of networkIds) if (!dhcpPoolByNetwork.has(id)) dhcpPoolByNetwork.set(id, 0);
      } else {
        let failures = 0;
        for (const n of networks) {
          if (n.ipVersion !== 4) continue;
          let rangesRes;
          try {
            rangesRes = { ok: true, data: await fetchRangesForNetwork(source, n.id, timeout) };
          } catch (err) {
            failures += 1;
            if (failures <= 3) logger.warn(`[BluecatPoller] ranges(${n.id}) failed: ${safeMsg(err)}`);
            rangesRes = { ok: false };
          }
          if (rangesRes.ok) {
            allRanges.push(...rangesRes.data);
            dhcpPoolByNetwork.set(n.id, rangesRes.data.reduce((sum, r) => sum + (r.size || 0), 0));
          } else if (priorByNetworkId.has(n.id)) {
            dhcpPoolByNetwork.set(n.id, priorByNetworkId.get(n.id).dhcp_pool ?? 0);
          }
        }
        if (failures > 3) logger.warn(`[BluecatPoller] ranges: ${failures} per-network calls failed (first 3 logged)`);
      }
      logger.info(`[BluecatPoller] ${source.name}: ${allRanges.length} DHCP range(s) across ${dhcpPoolByNetwork.size} network(s)`);

      for (const n of networks) {
        const override = overridesByNetworkId.get(n.id);
        const prior = priorByNetworkId.get(n.id);
        const dhcpPool = dhcpPoolByNetwork.get(n.id) ?? (prior ? prior.dhcp_pool : null);
        n.dhcpPool = dhcpPool;

        if (n.ipVersion === 4 && usesUsage) {
          const { usedStatic, freeStatic } = computeUsageBasedCounts(n.usage, n.capacity, dhcpPool);
          n.usedStatic = usedStatic;
          n.freeStatic = Math.max(0, freeStatic);
          n.freePct = n.capacity ? (n.freeStatic / n.capacity) * 100 : null;
          n.countsSource = 'usage';
          n.dhcpUsed = prior ? prior.dhcp_used : null;
          n.enumeratedAt = prior ? prior.enumerated_at : null;
        } else if (prior) {
          n.usedStatic = prior.used_static;
          n.dhcpUsed = prior.dhcp_used;
          n.freeStatic = prior.free_static;
          n.freePct = prior.free_pct;
          n.countsSource = prior.counts_source;
          n.enumeratedAt = prior.enumerated_at;
        } else {
          n.usedStatic = null;
          n.dhcpUsed = null;
          n.freeStatic = null;
          n.freePct = null;
          n.countsSource = null;
          n.enumeratedAt = null;
        }

        // Gateway resolution: override > bam > address (last enumeration) > null.
        if (override && override.gateway) {
          n.gateway = override.gateway;
          n.gatewaySource = 'override';
        } else if (n.gatewayBam) {
          n.gateway = n.gatewayBam;
          n.gatewaySource = 'bam';
        } else {
          const addrRow = db.prepare(`
            SELECT address FROM bluecat_addresses WHERE source_id = ? AND network_id = ? AND state = 'GATEWAY' LIMIT 1
          `).get(source.id, n.id);
          if (addrRow) {
            n.gateway = addrRow.address;
            n.gatewaySource = 'address';
          } else {
            n.gateway = null;
            n.gatewaySource = null;
          }
        }
      }

      storeNetworks(source.id, networks);
      // Carry forward prior dhcp_used/free_dhcp per range (enumerate owns those).
      const priorRangesById = new Map(
        db.prepare('SELECT * FROM bluecat_ranges WHERE source_id = ?').all(source.id).map((r) => [r.range_id, r])
      );
      for (const r of allRanges) {
        const priorRange = priorRangesById.get(r.id);
        r.dhcpUsed = priorRange ? priorRange.dhcp_used : null;
        r.freeDhcp = priorRange ? priorRange.free_dhcp : null;
      }
      storeRanges(source.id, allRanges);
    }

    const devicesRes = await trySection('devices', async () => {
      const out = [];
      for (const c of configurations) {
        const rows = await bluecatApi.fetchDevices(source, c.id, timeout);
        for (const d of rows) out.push({ ...d, configurationId: d.configurationId ?? c.id });
      }
      return out;
    });
    if (devicesRes.ok) storeDevices(source.id, devicesRes.data);

    const serversRes = await trySection('servers', () => bluecatApi.fetchServers(source, timeout));
    if (serversRes.ok) {
      const servers = serversRes.data;
      const rolesRes = await trySection('deploymentRoles', () => bluecatApi.fetchDeploymentRoles(source, timeout));
      const roles = rolesRes.ok ? rolesRes.data : [];
      const rolesByServerId = new Map();
      for (const r of roles) {
        const serverId = r.serverId != null ? r.serverId : null;
        if (serverId == null) continue;
        if (!rolesByServerId.has(serverId)) rolesByServerId.set(serverId, []);
        rolesByServerId.get(serverId).push({ roleType: r.roleType, type: r.type, target: r.serverInterfaceName || r.serverGroup || null });
      }
      for (const s of servers) s.roles = rolesByServerId.get(s.id) || [];

      const firstFifty = servers.slice(0, 50);
      for (const s of firstFifty) {
        const dep = await trySection(`deployment(${s.id})`, () => bluecatApi.fetchLatestDeployment(source, s.id, timeout));
        if (dep.ok && dep.data) {
          s.lastDeployStatus = dep.data.status || dep.data.state || null;
          s.lastDeployAt = null;
        }
      }
      storeServers(source.id, servers);
    }

    // Metrics snapshot.
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM bluecat_views WHERE source_id = ?) views,
        (SELECT COUNT(*) FROM bluecat_zones WHERE source_id = ?) zones,
        (SELECT COUNT(*) FROM bluecat_records WHERE source_id = ?) records,
        (SELECT COUNT(*) FROM bluecat_networks WHERE source_id = ?) networks,
        (SELECT COUNT(*) FROM bluecat_devices WHERE source_id = ?) devices,
        (SELECT COUNT(*) FROM bluecat_servers WHERE source_id = ?) servers,
        (SELECT COUNT(*) FROM bluecat_servers WHERE source_id = ? AND connected = 0) servers_down
    `).get(source.id, source.id, source.id, source.id, source.id, source.id, source.id);
    const warn = lowFreeWarn();
    const networksLowSpace = db.prepare(`
      SELECT COUNT(*) n FROM bluecat_networks nw
      LEFT JOIN bluecat_network_overrides o ON o.source_id = nw.source_id AND o.network_id = nw.network_id
      WHERE nw.source_id = ? AND nw.ip_version = 4 AND nw.free_static IS NOT NULL AND nw.free_static < ?
        AND COALESCE(o.exclude_low_space, 0) = 0
    `).get(source.id, warn).n;
    const rangesLowSpace = db.prepare(`
      SELECT COUNT(*) n FROM bluecat_ranges WHERE source_id = ? AND free_dhcp IS NOT NULL AND free_dhcp < ?
    `).get(source.id, warn).n;

    appendMetricsHistory(source.id, {
      views: counts.views || 0, zones: counts.zones || 0, records: counts.records || 0,
      networks: counts.networks || 0, networksLowSpace, rangesLowSpace,
      devices: counts.devices || 0, servers: counts.servers || 0, serversDown: counts.servers_down || 0,
    });

    db.prepare(`
      UPDATE bluecat_sources SET last_poll_status = 'success', last_poll_error = NULL, last_poll_at = datetime('now') WHERE id = ?
    `).run(source.id);

    logger.info(`[BluecatPoller] ${source.name}: ${counts.views || 0} view(s), ${counts.zones || 0} zone(s), ${counts.networks || 0} network(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE bluecat_sources SET last_poll_status = 'error', last_poll_error = ?, last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), source.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(); } catch (err) {
      logger.warn(`[BluecatPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

// ── Enumerate (per-network address counts) ──────────────────────────────────

const storeNetworkAddresses = db.transaction((sourceId, networkId, addresses, ranges) => {
  db.prepare('DELETE FROM bluecat_addresses WHERE source_id = ? AND network_id = ?').run(sourceId, networkId);
  const stmt = db.prepare(`
    INSERT INTO bluecat_addresses (source_id, address_id, network_id, address, state, name, mac, in_range_id, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of addresses) {
    if (a.id == null || !a.address) continue;
    const inRange = ranges.find((r) => a._ipInt != null && r._startInt != null && r._endInt != null && a._ipInt >= r._startInt && a._ipInt <= r._endInt);
    stmt.run(sourceId, a.id, networkId, a.address, a.state, a.name, a.mac, inRange ? inRange.id : null, a.deviceId);
  }
});

function ipToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

async function enumerateNetwork(source, network) {
  const timeout = 60000;
  if (network.prefix != null && network.prefix < 16) {
    logger.info(`[BluecatPoller] skipping enumeration for ${network.range} (prefix < 16)`);
    return;
  }
  const addresses = await bluecatApi.fetchNetworkAddresses(source, network.network_id, network.prefix, timeout);
  for (const a of addresses) a._ipInt = ipToInt(a.address);

  const ranges = db.prepare('SELECT * FROM bluecat_ranges WHERE source_id = ? AND network_id = ?').all(source.id, network.network_id)
    .map((r) => ({ ...r, _startInt: ipToInt(r.start_ip), _endInt: ipToInt(r.end_ip) }));

  storeNetworkAddresses(source.id, network.network_id, addresses, ranges);

  // Per-range dhcp_used / free_dhcp.
  for (const r of ranges) {
    const inRange = addresses.filter((a) => a._ipInt != null && r._startInt != null && r._endInt != null && a._ipInt >= r._startInt && a._ipInt <= r._endInt);
    const excluded = inRange.filter((a) => a.state === 'DHCP_EXCLUDED').length;
    const used = inRange.filter((a) => !ADDRESS_STATE_FREE.has(a.state) && a.state !== 'DHCP_EXCLUDED').length;
    const freeDhcp = r.size != null ? Math.max(0, r.size - excluded - used) : null;
    db.prepare('UPDATE bluecat_ranges SET dhcp_used = ?, free_dhcp = ? WHERE id = ?').run(used, freeDhcp, r.id);
  }

  if (network.counts_source !== 'usage') {
    const dhcpPool = ranges.reduce((sum, r) => sum + (r.size || 0), 0);
    const usedStatic = addresses.filter((a) => ADDRESS_STATE_COUNTED.has(a.state) || (!ADDRESS_STATE_FREE.has(a.state) && a.state != null && !ranges.some((r) => r._startInt != null && r._endInt != null && a._ipInt >= r._startInt && a._ipInt <= r._endInt))).length;
    const capacity = network.capacity;
    const freeStatic = capacity != null ? Math.max(0, capacity - dhcpPool - usedStatic) : null;
    const freePct = capacity ? (freeStatic / capacity) * 100 : null;
    db.prepare(`
      UPDATE bluecat_networks SET used_static = ?, dhcp_pool = ?, free_static = ?, free_pct = ?,
        counts_source = 'enumerated', enumerated_at = datetime('now') WHERE source_id = ? AND network_id = ?
    `).run(usedStatic, dhcpPool, freeStatic, freePct, source.id, network.network_id);
  } else {
    db.prepare(`UPDATE bluecat_networks SET enumerated_at = datetime('now') WHERE source_id = ? AND network_id = ?`)
      .run(source.id, network.network_id);
  }

  // Gateway from an address in GATEWAY state, only when the network has none yet.
  if (!network.gateway) {
    const gw = addresses.find((a) => a.state === 'GATEWAY');
    if (gw) {
      db.prepare(`UPDATE bluecat_networks SET gateway = ?, gateway_source = 'address' WHERE source_id = ? AND network_id = ?`)
        .run(gw.address, source.id, network.network_id);
    }
  }
}

async function pollEnumerate(source) {
  try {
    const networks = db.prepare('SELECT * FROM bluecat_networks WHERE source_id = ? AND ip_version = 4').all(source.id);
    await bluecatApi.promisePool(networks, 4, async (n) => {
      try {
        await enumerateNetwork(source, n);
      } catch (err) {
        logger.warn(`[BluecatPoller] enumerate ${n.range} failed: ${safeMsg(err)}`);
      }
    });
    db.prepare(`UPDATE bluecat_sources SET last_enumerate_at = datetime('now'), last_enumerate_error = NULL WHERE id = ?`).run(source.id);
  } catch (err) {
    db.prepare(`UPDATE bluecat_sources SET last_enumerate_error = ? WHERE id = ?`).run(safeMsg(err), source.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(); } catch (err) {
      logger.warn(`[BluecatPoller] issue-history reconcile (enumerate) failed: ${err.message}`);
    }
  }
}

// ── Poller framework instances ──────────────────────────────────────────────

const loadSources = () => db.prepare('SELECT * FROM bluecat_sources').all();

const inventoryPoller = createPoller({
  id: 'bluecat',
  loadSources,
  intervalMinutes: (s) => s.polling_interval_minutes,
  poll: pollInventory,
});

const enumeratePoller = createPoller({
  id: 'bluecat-enumerate',
  loadSources,
  intervalMinutes: (s) => s.enumerate_interval_minutes,
  poll: pollEnumerate,
});

function initBluecatPoller() {
  const inv = inventoryPoller.init();
  const enu = enumeratePoller.init();
  logger.info(`[BluecatPoller] Initialized ${inv.length} source(s) (inventory), ${enu.length} (enumerate)`);
  return inv;
}

function createBluecatPollerHandle() {
  return {
    init: () => initBluecatPoller(),
    stopAll: () => {
      inventoryPoller.stopAll();
      enumeratePoller.stopAll();
    },
    trigger: (sourceOrId) => {
      const source = typeof sourceOrId === 'object' ? sourceOrId : db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(sourceOrId);
      return source ? inventoryPoller.trigger(source) : Promise.resolve();
    },
    triggerEnumerate: (sourceOrId) => {
      const source = typeof sourceOrId === 'object' ? sourceOrId : db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(sourceOrId);
      return source ? enumeratePoller.trigger(source) : Promise.resolve();
    },
    schedule: (source) => {
      inventoryPoller.schedule(source);
      enumeratePoller.schedule(source);
    },
    cancel: (sourceId) => {
      inventoryPoller.cancel(sourceId);
      enumeratePoller.cancel(sourceId);
    },
    taskCount: () => inventoryPoller.taskCount() + enumeratePoller.taskCount(),
  };
}

const bluecatPollerHandle = createBluecatPollerHandle();

module.exports = {
  inventoryPoller, enumeratePoller,
  initBluecatPoller, createBluecatPollerHandle, bluecatPollerHandle,
  pollInventory, pollEnumerate,
  resolveZoneViews, computeUsageBasedCounts, ipToInt,
};
