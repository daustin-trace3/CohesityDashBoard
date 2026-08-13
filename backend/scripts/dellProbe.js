// Live-shape diagnostic for the Dell/OME integration, run directly against
// the backend (no HTTP, no API key). Writes dell-probe.json to the current
// directory with the raw inventory layout of one server: InventoryTypes,
// every combined-response section's count + first raw item, and the
// dedicated serverRaidControllers response.
//
//   node backend/scripts/dellProbe.js            # first server device
//   node backend/scripts/dellProbe.js 10123      # specific OME device id
//   node backend/scripts/dellProbe.js alerts     # raw AlertService listing → dell-alerts-probe.json
//   node backend/scripts/dellProbe.js audit      # compliance/jobs/profiles/hw-logs shapes → dell-audit-probe.json
//   node backend/scripts/dellProbe.js audit 10123  # same, hardware logs from a specific device
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const db = require('../db/database');
const api = require('../services/dellOmeApi');

(async () => {
  const ome = db.prepare('SELECT * FROM dell_ome_instances ORDER BY id').get();
  if (!ome) { console.error('No OME instance registered.'); process.exit(1); }
  const devArg = process.argv[2];
  if (devArg === 'alerts') {
    console.log(`Probing AlertService on ${ome.name}…`);
    const out = await api.probeAlerts(ome);
    // What actually landed locally — separates "API broken" from "no poll yet".
    try {
      out.storedLocally = db.prepare(
        'SELECT COUNT(*) c, MIN(created_at) oldest, MAX(created_at) newest FROM dell_alerts WHERE ome_id = ?'
      ).get(ome.id);
    } catch (e) { out.storedLocally = { error: e.message }; }
    const file = path.join(process.cwd(), 'dell-alerts-probe.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`Wrote ${file}`);
    process.exit(0);
  }
  if (devArg === 'audit') {
    const hwDevArg = process.argv[3];
    const dev = hwDevArg
      ? db.prepare('SELECT device_id, name FROM dell_devices WHERE device_id = ?').get(Number(hwDevArg))
      : db.prepare("SELECT device_id, name FROM dell_devices WHERE ome_id = ? AND device_type LIKE '%server%' ORDER BY name LIMIT 1").get(ome.id);
    console.log(`Probing compliance/jobs/profiles${dev ? `/hardware-logs (${dev.name})` : ''} on ${ome.name}…`);
    const out = await api.probeAudit(ome, dev?.device_id ?? null);
    // What each governance table holds locally — separates API failure from no-poll-yet.
    out.storedLocally = {};
    for (const t of ['dell_config_baselines', 'dell_config_compliance', 'dell_jobs', 'dell_config_profiles', 'dell_hardware_logs']) {
      try { out.storedLocally[t] = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ome_id = ?`).get(ome.id).c; }
      catch (e) { out.storedLocally[t] = `error: ${e.message}`; }
    }
    const file = path.join(process.cwd(), 'dell-audit-probe.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`Wrote ${file}`);
    process.exit(0);
  }
  const dev = devArg
    ? db.prepare('SELECT device_id, name FROM dell_devices WHERE device_id = ?').get(Number(devArg))
    : db.prepare("SELECT device_id, name FROM dell_devices WHERE ome_id = ? AND device_type LIKE '%server%' ORDER BY name LIMIT 1").get(ome.id)
      || db.prepare('SELECT device_id, name FROM dell_devices WHERE ome_id = ? ORDER BY name LIMIT 1').get(ome.id);
  if (!dev) { console.error('No server device found — has a poll completed?'); process.exit(1); }
  console.log(`Probing ${dev.name} (device ${dev.device_id}) on ${ome.name}…`);
  const out = await api.probeInventory(ome, dev.device_id);
  const file = path.join(process.cwd(), 'dell-probe.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
  process.exit(0);
})().catch((e) => { console.error('Probe failed:', e.message); process.exit(1); });
