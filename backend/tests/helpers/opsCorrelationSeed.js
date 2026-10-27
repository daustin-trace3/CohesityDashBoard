// Seed helpers for the Ops Agent correlation tests. Plain inserts against the
// test database; every table is emptied first so a case starts from nothing.
const db = require('../../db/database');

const TABLES = [
  'ops_incident_alerts', 'ops_incidents', 'ops_agent_runs',
  'vcenter_vms', 'vcenter_hosts', 'vcenter_datastores', 'vcenter_vcenters',
  'dell_devices', 'dell_ome_instances', 'brocade_device_ports', 'brocade_sources',
  'zerto_vms', 'zerto_vpgs', 'zerto_sites', 'app_service_watch', 'app_service_catalog',
];

function reset() {
  for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
  db.prepare("INSERT INTO vcenter_vcenters (id, name, host, username, encrypted_credentials) VALUES (1, 'vc-prod', 'vc-prod.lab', 'u', 'x')").run();
}

function host(name, { serial = null, tag = null } = {}) {
  const id = `h-${name}`;
  db.prepare('INSERT INTO vcenter_hosts (vcenter_id, host_id, name, serial, service_tag) VALUES (1, ?, ?, ?, ?)').run(id, name, serial, tag);
}

function vm(name, { onHost = null, datastores = null, tags = null } = {}) {
  db.prepare('INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, datastores, tags) VALUES (1, ?, ?, ?, ?, ?)')
    .run(`vm-${name}`, name, onHost, datastores ? JSON.stringify(datastores) : null, tags ? JSON.stringify(tags) : null);
}

function datastore(name, accessible = 1) {
  db.prepare('INSERT INTO vcenter_datastores (vcenter_id, datastore_id, name, accessible) VALUES (1, ?, ?, ?)').run(`ds-${name}`, name, accessible);
}

function dell(name, tag) {
  if (!db.prepare('SELECT 1 FROM dell_ome_instances WHERE id = 1').get()) {
    db.prepare("INSERT INTO dell_ome_instances (id, name, host, username, encrypted_credentials) VALUES (1, 'ome', 'ome.lab', 'u', 'x')").run();
  }
  const n = db.prepare('SELECT COUNT(*) c FROM dell_devices').get().c + 1;
  db.prepare("INSERT INTO dell_devices (ome_id, device_id, service_tag, name, model) VALUES (1, ?, ?, ?, 'R740')").run(n, tag, name);
}

function brocadePort(hostName, switchName) {
  if (!db.prepare('SELECT 1 FROM brocade_sources WHERE id = 1').get()) {
    db.prepare("INSERT INTO brocade_sources (id, name, host) VALUES (1, 'sannav', 'sannav.lab')").run();
  }
  db.prepare('INSERT INTO brocade_device_ports (source_id, fdmi_host_name, switch_name, stale, is_missing) VALUES (1, ?, ?, 0, 0)').run(hostName, switchName);
}

function watch(usageId, displayId, label) {
  db.prepare("INSERT INTO app_service_watch (usage_id, display_id, label, created_by, created_at) VALUES (?, ?, ?, 'test', '2026-01-01T00:00:00.000Z')").run(usageId, displayId, label);
}

module.exports = { db, reset, host, vm, datastore, dell, brocadePort, watch };
