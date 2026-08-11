// One-off cleanup helper for the Nutanix .iccplugin conversion. The built-in
// Nutanix platform is removed but its nutanix_* tables/data are left in place
// (adopted by the plugin on install — see NUTANIX_PLUGIN_CONTRACT.md decision
// 7). This script exists only for an operator who has confirmed the plugin
// will never be installed and wants the leftover tables gone.
//
// Usage:
//   node backend/scripts/drop-nutanix-tables.js            # list tables + row counts (dry run)
//   node backend/scripts/drop-nutanix-tables.js --confirm   # actually drop them
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(__dirname, '..', 'data', 'cohesity.db');
const confirm = process.argv.includes('--confirm');

const db = new Database(DB_PATH);

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nutanix\\_%' ESCAPE '\\' ORDER BY name"
).all().map((r) => r.name);

if (tables.length === 0) {
  console.log('No nutanix_* tables found in', DB_PATH);
  db.close();
  process.exit(0);
}

console.log(`nutanix_* tables in ${DB_PATH}:`);
let totalRows = 0;
for (const name of tables) {
  const count = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c;
  totalRows += count;
  console.log(`  ${name} — ${count} row(s)`);
}
console.log(`Total: ${tables.length} table(s), ${totalRows} row(s).`);

if (!confirm) {
  console.log('\nDry run only — pass --confirm to drop these tables.');
  db.close();
  process.exit(0);
}

const dropAll = db.transaction(() => {
  for (const name of tables) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
});
dropAll();
console.log(`\nDropped ${tables.length} table(s).`);
db.close();
