// One-off cleanup helper for the 2026-08 pluginization campaign's core-removal
// wave. The built-in copies of these 9 platforms are removed but their
// <id>_* tables/data are left in place (adopted by the matching .iccplugin
// on install — see icc-platform-removal skill). This script exists only for
// an operator who has confirmed a given plugin will never be (re)installed
// and wants its leftover tables gone. NEVER run this automatically.
//
// Usage:
//   node backend/scripts/drop-plugin-tables.js                       # list every removed platform's tables + row counts (dry run, all platforms)
//   node backend/scripts/drop-plugin-tables.js --platform pure       # list just pure's tables (dry run)
//   node backend/scripts/drop-plugin-tables.js --platform pure --confirm   # actually drop pure's tables
const Database = require('better-sqlite3');
const path = require('path');

// Table-name prefix(es) owned by each removed platform. Pure ships both
// pure_* (direct arrays) and pure1_* (Pure1 SaaS cache) tables.
const PLATFORM_PREFIXES = {
  aria: ['aria'],
  ariaops: ['ariaops'],
  aws: ['aws'],
  dell: ['dell'],
  netapp: ['netapp'],
  pure: ['pure', 'pure1'],
  unifi: ['unifi'],
  vcenter: ['vcenter'],
  zerto: ['zerto'],
};

const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(__dirname, '..', 'data', 'cohesity.db');
const confirm = process.argv.includes('--confirm');
const platformFlagIdx = process.argv.indexOf('--platform');
const platformArg = platformFlagIdx !== -1 ? process.argv[platformFlagIdx + 1] : null;

if (platformArg && !PLATFORM_PREFIXES[platformArg]) {
  console.error(`Unknown --platform '${platformArg}'. Valid: ${Object.keys(PLATFORM_PREFIXES).join(', ')}`);
  process.exit(1);
}

const platforms = platformArg ? [platformArg] : Object.keys(PLATFORM_PREFIXES);

const db = new Database(DB_PATH);

function tablesForPrefix(prefix) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\' ORDER BY name"
  ).all(`${prefix.replace(/_/g, '\\_')}\\_%`).map((r) => r.name);
}

let grandTotalTables = 0;
let grandTotalRows = 0;
const toDrop = [];

for (const platform of platforms) {
  const tables = [...new Set(PLATFORM_PREFIXES[platform].flatMap(tablesForPrefix))].sort();
  if (tables.length === 0) {
    console.log(`[${platform}] no tables found.`);
    continue;
  }
  console.log(`[${platform}] tables in ${DB_PATH}:`);
  let platformRows = 0;
  for (const name of tables) {
    const count = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c;
    platformRows += count;
    toDrop.push(name);
    console.log(`  ${name} — ${count} row(s)`);
  }
  console.log(`  Subtotal: ${tables.length} table(s), ${platformRows} row(s).\n`);
  grandTotalTables += tables.length;
  grandTotalRows += platformRows;
}

console.log(`Total: ${grandTotalTables} table(s), ${grandTotalRows} row(s).`);

if (!confirm) {
  console.log('\nDry run only — pass --confirm (with --platform <id>) to drop these tables.');
  db.close();
  process.exit(0);
}

if (!platformArg) {
  console.error('\nRefusing to --confirm without an explicit --platform <id> — drop one platform at a time.');
  db.close();
  process.exit(1);
}

const dropAll = db.transaction(() => {
  for (const name of toDrop) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
});
dropAll();
console.log(`\nDropped ${toDrop.length} table(s) for platform '${platformArg}'.`);
db.close();
