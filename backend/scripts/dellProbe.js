// Live-shape diagnostic for the Dell/OME integration, run directly against
// the backend (no HTTP, no API key). Writes dell-probe.json to the current
// directory with the raw inventory layout of one server: InventoryTypes,
// every combined-response section's count + first raw item, and the
// dedicated serverRaidControllers response.
//
//   node backend/scripts/dellProbe.js            # first server device
//   node backend/scripts/dellProbe.js 10123      # specific OME device id
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const db = require('../db/database');
const api = require('../services/dellOmeApi');

(async () => {
  const ome = db.prepare('SELECT * FROM dell_ome_instances ORDER BY id').get();
  if (!ome) { console.error('No OME instance registered.'); process.exit(1); }
  const devArg = process.argv[2];
  const dev = devArg
    ? db.prepare('SELECT device_id, name FROM dell_devices WHERE device_id = ?').get(Number(devArg))
    : db.prepare("SELECT device_id, name FROM dell_devices WHERE ome_id = ? AND device_type = 'Server' ORDER BY name LIMIT 1").get(ome.id);
  if (!dev) { console.error('No server device found — has a poll completed?'); process.exit(1); }
  console.log(`Probing ${dev.name} (device ${dev.device_id}) on ${ome.name}…`);
  const out = await api.probeInventory(ome, dev.device_id);
  const file = path.join(process.cwd(), 'dell-probe.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Wrote ${file}`);
  process.exit(0);
})().catch((e) => { console.error('Probe failed:', e.message); process.exit(1); });
