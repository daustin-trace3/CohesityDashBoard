// Read-only verification report for the LogicMonitor-derived analytics (Cisco and F5). Runs the contract's
// section 6 queries against a database file and prints markdown: per DataSource device and instance counts,
// daily history depth, distinct state values, raw datapoint names for a DataSource, trend finding counts and a
// per-family p50 / p95 sample-age report (WP-X3).
//
//   node backend/scripts/lm-verify-analytics.cjs <db path> [--vendor cisco|f5|all] [--datasource <name>]
//
// The database is opened read-only; nothing is written. Needs better-sqlite3 (backend/node_modules).
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
if (!dbPath) { console.error('usage: node lm-verify-analytics.cjs <db path> [--vendor cisco|f5|all] [--datasource <name>]'); process.exit(2); }
const vendorArg = opt('vendor', 'all');
const vendors = vendorArg === 'all' ? ['cisco', 'f5'] : [vendorArg];
const dsArg = opt('datasource', null);

const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const table = (headers, rows) => {
  if (!rows.length) return '_no rows_\n';
  const cell = (v) => String(v == null ? '' : v).replace(/\|/g, '/');
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')}\n`;
};
const iso = (e) => (e ? new Date(e * 1000).toISOString().slice(0, 16) : '');
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);

console.log(`# LogicMonitor analytics verification\n\nDatabase: ${path.basename(dbPath)}  Generated: ${new Date().toISOString()}\n`);
for (const t of ['lm_devices', 'lm_ds_metrics', 'lm_ds_daily', 'lm_ds_values', 'lm_trend_findings', 'lm_interface_daily']) {
  console.log(`- ${t}: ${has(t) ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : 'MISSING (migration not run)'}`);
}
console.log('');

for (const vk of vendors) {
  console.log(`\n## Vendor ${vk}\n`);
  const keys = vk === 'cisco' ? ['cisco', 'meraki'] : [vk];
  const ph = keys.map(() => '?').join(',');
  if (has('lm_ds_metrics')) {
    console.log('### Catalog metrics with data, per DataSource\n');
    console.log(table(['datasource', 'metric', 'devices', 'instances', 'min', 'max', 'newest', 'oldest'], db.prepare(`
      SELECT m.datasource_name ds, m.metric, COUNT(DISTINCT m.lm_device_id) devices, COUNT(*) instances, MIN(m.value) mn, MAX(m.value) mx,
        MAX(m.sampled_at_epoch) newest, MIN(m.sampled_at_epoch) oldest
      FROM lm_ds_metrics m JOIN lm_devices d ON d.source_id = m.source_id AND d.lm_device_id = m.lm_device_id
      WHERE d.vendor_key IN (${ph}) AND d.stale = 0 GROUP BY m.datasource_name, m.metric ORDER BY m.datasource_name, m.metric
    `).all(...keys).map((r) => [r.ds, r.metric, r.devices, r.instances, r.mn, r.mx, iso(r.newest), iso(r.oldest)])));
  }
  if (has('lm_ds_daily')) {
    console.log('### Daily history depth per metric\n');
    console.log(table(['metric', 'days', 'first day'], db.prepare(`
      SELECT x.metric, COUNT(DISTINCT x.day) days, MIN(x.day) first_day FROM lm_ds_daily x
      JOIN lm_devices d ON d.source_id = x.source_id AND d.lm_device_id = x.lm_device_id
      WHERE d.vendor_key IN (${ph}) GROUP BY x.metric ORDER BY days DESC
    `).all(...keys).map((r) => [r.metric, r.days, r.first_day])));
  }
  if (has('lm_ds_metrics')) {
    console.log('### Distinct state values (failover, sync, wide IP, daemon, stack, supervisor)\n');
    console.log(table(['metric', 'value', 'count'], db.prepare(`
      SELECT m.metric, m.value, COUNT(*) n FROM lm_ds_metrics m JOIN lm_devices d ON d.source_id = m.source_id AND d.lm_device_id = m.lm_device_id
      WHERE d.vendor_key IN (${ph}) AND m.metric IN ('failover_state', 'sync_state', 'wideip_avail', 'daemon_exit', 'stack_role', 'stack_member_state', 'stack_port_state', 'sup_state', 'sup1_state', 'sup2_state', 'psu_state', 'fan_state', 'ntp_synced')
      GROUP BY m.metric, m.value ORDER BY m.metric, m.value
    `).all(...keys).map((r) => [r.metric, r.value, r.n])));
  }
  // WP-X3: sample age per family.
  if (has('lm_ds_metrics')) {
    console.log('### Sample age per family (hours since the stored sample)\n');
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare(`
      SELECT m.family, m.sampled_at_epoch e FROM lm_ds_metrics m JOIN lm_devices d ON d.source_id = m.source_id AND d.lm_device_id = m.lm_device_id
      WHERE d.vendor_key IN (${ph}) AND d.stale = 0 AND m.sampled_at_epoch IS NOT NULL
    `).all(...keys);
    const byFam = new Map();
    for (const r of rows) { if (!byFam.has(r.family)) byFam.set(r.family, []); byFam.get(r.family).push((now - r.e) / 3600); }
    console.log(table(['family', 'rows', 'p50 h', 'p95 h'], [...byFam.entries()].map(([f, a]) => {
      a.sort((x, y) => x - y);
      return [f, a.length, Math.round(pct(a, 50) * 10) / 10, Math.round(pct(a, 95) * 10) / 10];
    })));
  }
}

if (dsArg && has('lm_ds_values')) {
  console.log(`\n## Raw datapoint names on ${dsArg}\n`);
  console.log(table(['datapoint', 'n'], db.prepare('SELECT datapoint, COUNT(*) n FROM lm_ds_values WHERE datasource_name = ? GROUP BY datapoint ORDER BY n DESC').all(dsArg).map((r) => [r.datapoint, r.n])));
}

if (has('lm_trend_findings')) {
  console.log('\n## Trend findings\n');
  console.log(table(['kind', 'severity', 'rows'], db.prepare('SELECT kind, severity, COUNT(*) n FROM lm_trend_findings GROUP BY kind, severity ORDER BY kind, severity').all().map((r) => [r.kind, r.severity, r.n])));
  const newest = db.prepare('SELECT MAX(computed_at) t FROM lm_trend_findings').get().t;
  console.log(`Newest computed_at: ${newest || 'never (the hourly job has not run)'}`);
}
if (has('lm_ds_daily') && has('lm_devices')) {
  console.log('\n## Viability\n');
  const need = [['cpu_pct', 'CPU forecast'], ['mem_pct', 'memory creep'], ['fs_used_pct', 'filesystem forecast'], ['optic_value', 'optic margin'], ['poe_used_pct', 'PoE forecast'],
    ['uptime_s', 'reboots'], ['bgp_established_s', 'BGP flaps'], ['failover_state', 'F5 failovers'], ['client_connections', 'F5 connections'], ['cert_days_left', 'F5 certificates']];
  console.log(table(['metric', 'feature', 'days of history', 'viable (7+ days)'], need.map(([m, label]) => {
    const r = db.prepare('SELECT COUNT(DISTINCT day) d FROM lm_ds_daily WHERE metric = ?').get(m);
    return [m, label, r.d, r.d >= 7 ? 'yes' : 'not yet'];
  })));
}
db.close();
