// Demo scenario: a Dell PowerEdge host (boot from SAN) is down because both
// of its HBA links on one Brocade switch dropped. Three platforms tell one
// story so the Service Status AI analysis can point at the SAN link:
//   Dell OME  - critical alert "failed to boot, no bootable device on the FC path"
//   vCenter   - the ESXi host is NOT_RESPONDING with an open host-down issue
//   Brocade   - both initiator logins for the host are missing on PROD-A-SW02
//               ports 18/19, switch ports Offline / No_Light, host_link_down issue
// Idempotent: safe to run on an already-seeded DB (the live demo) and from
// seedDemo.js after the generators. The Dell half is duplicated inline in
// plugin-sdk/dell/backend/src/demoSeed.js because the pack reseeds its own
// tables on every boot and cannot require host modules.
//
// Standalone:  node backend/demo/scenarios/sanBootPathDown.js --db <path>

const HOST = 'nyc-esx-0102.icc.demo';
const SHORT = 'nyc-esx-0102';
const VCENTER = 'nyc-vc-prd-01';
const SWITCH = 'PROD-A-SW02';
const PORTS = [18, 19];
const HBA_WWNS = ['10:00:00:10:9b:1d:02:18', '10:00:00:10:9b:1d:02:19'];
const NODE_WWN = '20:00:00:10:9b:1d:02:00';
const DELL_RENAME_FROM = 'dc1-esx-002.demo.local';
const DELL_ALERT_ID = 990001;
const DELL_ALERT = {
  severity: 'critical', category: 'System Health', subcategory: 'Boot', messageId: 'SYS1003',
  message: `System failed to boot: no bootable device found on the Fibre Channel boot path (HBA slot 3, ports 1 and 2) of ${HOST}. Server is powered on with no operating system running.`,
};

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const sqlMinutesAgo = (m) => minutesAgo(m).replace('T', ' ').slice(0, 19);

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** vCenter half: host not responding + open host-down issue (same key shape
 *  as services/vcenterIssues.js so a real reconcile keeps it). */
function applyVcenter(db) {
  if (!tableExists(db, 'vcenter_hosts')) return { applied: false, reason: 'no vcenter tables' };
  const host = db.prepare('SELECT id FROM vcenter_hosts WHERE name = ?').get(HOST);
  if (!host) return { applied: false, reason: `${HOST} not in vcenter_hosts` };
  db.prepare(`
    UPDATE vcenter_hosts SET connection_state = 'NOT_RESPONDING', cpu_mhz_used = NULL, mem_bytes_used = NULL,
      vm_count = 0, uptime_seconds = NULL WHERE id = ?
  `).run(host.id);
  const key = `host-down|${VCENTER}|${HOST}`;
  const open = db.prepare("SELECT id FROM vcenter_issue_history WHERE issue_key = ? AND status = 'open'").get(key);
  if (!open) {
    db.prepare(`
      INSERT INTO vcenter_issue_history (issue_key, vcenter, severity, type, target, message, status, first_seen, last_seen)
      VALUES (?, ?, 'critical', 'host-down', ?, ?, 'open', ?, ?)
    `).run(key, VCENTER, HOST, `Host ${HOST} is not responding`, sqlMinutesAgo(38), sqlMinutesAgo(2));
  }
  return { applied: true };
}

/** Brocade half: enclosure + two missing initiator logins on one switch,
 *  the two switch ports Offline / No_Light, one open host_link_down issue. */
function applyBrocade(db) {
  if (!tableExists(db, 'brocade_switches')) return { applied: false, reason: 'no brocade tables' };
  const sw = db.prepare('SELECT * FROM brocade_switches WHERE name = ? AND stale = 0').get(SWITCH);
  if (!sw) return { applied: false, reason: `${SWITCH} not in brocade_switches` };
  const source = db.prepare('SELECT id, name FROM brocade_sources WHERE id = ?').get(sw.source_id);

  let enc = db.prepare('SELECT id, guid FROM brocade_enclosures WHERE host_name = ?').get(HOST);
  if (!enc) {
    const guid = `enc-guid-scenario-${SHORT}`;
    const info = db.prepare(`
      INSERT INTO brocade_enclosures (source_id, sannav_id, guid, name, type, host_name, ip_address, vendor, model,
        health, location, contact, tags, stale, raw_json)
      VALUES (?, 3900, ?, ?, 'Host', ?, '10.51.90.12', 'Dell', 'PowerEdge R760', 'Marginal', 'DC-Rack-12', 'ops@icc.demo', NULL, 0, ?)
    `).run(sw.source_id, guid, SHORT, HOST, JSON.stringify({ name: SHORT, hostName: HOST, scenario: 'sanBootPathDown' }));
    enc = { id: info.lastInsertRowid, guid };
  }

  PORTS.forEach((portNumber, i) => {
    const hbaWwn = HBA_WWNS[i];
    const sp = db.prepare('SELECT * FROM brocade_switch_ports WHERE switch_wwn = ? AND port_number = ? AND stale = 0').get(sw.wwn, portNumber);
    if (sp) {
      db.prepare(`
        UPDATE brocade_switch_ports SET state = 'Offline', status = 'No_Light', health = 'Critical', calculated_status = 'Offline',
          status_message = 'Port offline: no synchronization on port group 16-19 (possible ASIC or cable fault)',
          occupied = 1, remote_device = ?, remote_port_wwn = ?, remote_node_wwn = ?, connected_device_type = 'Initiator',
          fenced = 0, blocked = 0, last_update_ms = ?
        WHERE id = ?
      `).run(`${SHORT} HBA${i}`, hbaWwn, NODE_WWN, Date.now() - 37 * 60000, sp.id);
    }
    const dp = db.prepare('SELECT id FROM brocade_device_ports WHERE wwn = ?').get(hbaWwn);
    if (!dp) {
      db.prepare(`
        INSERT INTO brocade_device_ports (source_id, sannav_id, wwn, device_node_wwn, symbolic_name, device_symbolic_name,
          vendor, port_role, type, fabric_name, switch_wwn, switch_name, switch_port_wwn, switch_port_name, slot_number,
          port_number, port_id, enclosure_id, enclosure_guid, enclosure_name, fdmi_host_name, active_zones, active_zone_count,
          active_zoneset_name, zone_alias, is_missing, speed, stale)
        VALUES (?, ?, ?, ?, ?, ?, 'Dell', 'Initiator', 'N_Port', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, 32, 0)
      `).run(
        sw.source_id, 4900 + i, hbaWwn, NODE_WWN, `${SHORT} HBA${i} (QLE2772 slot 3 port ${i + 1})`, SHORT,
        sw.fabric_name, sw.wwn, sw.name, sp ? sp.wwn : null, `port${portNumber}`, portNumber,
        sp ? sp.port_id : null, enc.id, enc.guid, SHORT, HOST,
        JSON.stringify([`${sw.fabric_name}_zone_${SHORT}_boot`]), `${sw.fabric_name}_EFF_CFG`, `${SHORT}_hba${i}`,
      );
    } else {
      db.prepare('UPDATE brocade_device_ports SET is_missing = 1, stale = 0 WHERE id = ?').run(dp.id);
    }
  });

  const portList = PORTS.map((p) => `${SWITCH} port ${p} (No_Light)`).join(', ');
  const message = `Host ${HOST} lost its fabric login on ${portList}; link down: Port offline: no synchronization on port group 16-19 (possible ASIC or cable fault)`;
  const open = db.prepare("SELECT id FROM brocade_issue_history WHERE type = 'host_link_down' AND target = ? AND resolved_at IS NULL").get(HOST);
  if (!open) {
    db.prepare(`
      INSERT INTO brocade_issue_history (source_id, source, type, target, severity, message, first_seen, last_seen, resolved_at)
      VALUES (?, ?, 'host_link_down', ?, 'critical', ?, ?, ?, NULL)
    `).run(sw.source_id, source ? source.name : 'SanNav Prod', HOST, message, sqlMinutesAgo(41), sqlMinutesAgo(2));
  }
  return { applied: true };
}

/** Dell half (host generator copy; the pack carries the same SQL inline). */
function applyDell(db) {
  if (!tableExists(db, 'dell_devices')) return { applied: false, reason: 'no dell tables' };
  let dev = db.prepare('SELECT ome_id, device_id, service_tag, name FROM dell_devices WHERE name = ?').get(HOST);
  if (!dev) {
    const from = db.prepare('SELECT ome_id, device_id, service_tag FROM dell_devices WHERE name = ?').get(DELL_RENAME_FROM);
    if (!from) return { applied: false, reason: `${DELL_RENAME_FROM} not in dell_devices` };
    db.prepare(`
      UPDATE dell_devices SET name = ?, model = 'PowerEdge R760', health = 'critical', health_raw = 4000, power_state = 'on',
        connection_state = 1, cpu_util_pct = NULL, mem_util_pct = NULL WHERE ome_id = ? AND device_id = ?
    `).run(HOST, from.ome_id, from.device_id);
    dev = { ...from, name: HOST };
  } else {
    db.prepare(`UPDATE dell_devices SET health = 'critical', health_raw = 4000, power_state = 'on', connection_state = 1 WHERE ome_id = ? AND device_id = ?`).run(dev.ome_id, dev.device_id);
  }
  db.prepare(`
    INSERT OR IGNORE INTO dell_alerts (ome_id, alert_id, severity, status, category, subcategory, message_id, message,
      device_name, service_tag, created_at)
    VALUES (?, ?, ?, 'not-acknowledged', ?, ?, ?, ?, ?, ?, ?)
  `).run(dev.ome_id, DELL_ALERT_ID, DELL_ALERT.severity, DELL_ALERT.category, DELL_ALERT.subcategory, DELL_ALERT.messageId,
    DELL_ALERT.message, HOST, dev.service_tag, sqlMinutesAgo(35));
  return { applied: true };
}

function applySanBootPathDown(db, { includeDell = true } = {}) {
  const out = { vcenter: applyVcenter(db), brocade: applyBrocade(db) };
  if (includeDell) out.dell = applyDell(db);
  return out;
}

module.exports = { applySanBootPathDown, applyVcenter, applyBrocade, applyDell, HOST, SWITCH, PORTS, DELL_ALERT_ID };

if (require.main === module) {
  const idx = process.argv.indexOf('--db');
  const dbPath = idx !== -1 ? process.argv[idx + 1] : null;
  if (!dbPath) { console.error('usage: node sanBootPathDown.js --db <path>'); process.exit(2); }
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  const result = db.transaction(() => applySanBootPathDown(db))();
  console.log(JSON.stringify(result));
  db.close();
}
