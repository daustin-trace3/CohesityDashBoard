// vCenter evidence: an ESX host or a VM (or the vCenter itself) with its state,
// placement, current and 30-day CPU or memory, datastores and guest volumes,
// vCenter events around the incident and how often the same issue opened.
const u = require('./util');

const platform = 'vcenter';

function findSubject(db, names) {
  for (const n of names) {
    const host = u.one(db, `SELECT h.*, v.name AS vc_name FROM vcenter_hosts h LEFT JOIN vcenter_vcenters v ON v.id = h.vcenter_id
      WHERE lower(h.name) = lower(?) ORDER BY h.captured_at DESC LIMIT 1`, n);
    if (host) return { kind: 'host', row: host, name: host.name };
    const vm = u.one(db, `SELECT m.*, v.name AS vc_name FROM vcenter_vms m LEFT JOIN vcenter_vcenters v ON v.id = m.vcenter_id
      WHERE lower(m.name) = lower(?) ORDER BY m.captured_at DESC LIMIT 1`, n);
    if (vm) return { kind: 'vm', row: vm, name: vm.name };
    const vc = u.one(db, 'SELECT * FROM vcenter_vcenters WHERE lower(name) = lower(?) LIMIT 1', n);
    if (vc) return { kind: 'vcenter', row: vc, name: vc.name };
  }
  return null;
}

/** Issue keys carried by this platform's alerts for the subject: "v:<type>|<vcenter>|<target>" minus the prefix. */
function issueKeysFor(ctx, name) {
  return u.alertsFor(ctx, platform)
    .filter((a) => String(a.source_key || '').startsWith('v:') && (u.lc(a.host) === u.lc(name) || String(a.source_key).toLowerCase().endsWith(`|${u.lc(name)}`)))
    .map((a) => ({ key: String(a.source_key).slice(2), type: a.type || String(a.source_key).slice(2).split('|')[0] }));
}

function issueHistory(db, ctx, name, facts, lines) {
  if (!u.hasTable(db, 'vcenter_issue_history')) return null;
  const since = u.zl(Date.now() - 30 * u.DAY_MS);
  const keys = issueKeysFor(ctx, name);
  let rows;
  let type = keys[0] && keys[0].type;
  if (keys.length) {
    rows = u.all(db, `SELECT first_seen, resolved_at, type FROM vcenter_issue_history
      WHERE issue_key = ? AND first_seen >= ? ORDER BY first_seen DESC LIMIT 200`, keys[0].key, since);
  } else {
    rows = u.all(db, `SELECT first_seen, resolved_at, type FROM vcenter_issue_history
      WHERE lower(target) = lower(?) AND first_seen >= ? ORDER BY first_seen DESC LIMIT 200`, name, since);
    type = rows[0] && rows[0].type;
  }
  const { line, stats } = u.issueLine(type, name, rows);
  if (line) lines.push(line);
  if (stats.opened) { facts.openedTimes30d = stats.opened; facts.meanMinutesOpen30d = stats.meanMinutes; }
  const open = u.one(db, `SELECT first_seen FROM vcenter_issue_history WHERE lower(target) = lower(?) AND resolved_at IS NULL
    ORDER BY first_seen ASC LIMIT 1`, name);
  return open ? open.first_seen : null;
}

function eventLines(db, ctx, name) {
  if (!u.hasTable(db, 'vcenter_events')) return [];
  const from = u.windowStart(ctx);
  const rows = u.all(db, `SELECT event_type, severity, message, created_at FROM vcenter_events
    WHERE lower(entity_name) = lower(?) ORDER BY created_at DESC LIMIT 40`, name);
  return rows
    .filter((r) => { const ms = u.parseMs(r.created_at); return ms != null && ms >= from; })
    .slice(0, 6)
    .map((r) => `vCenter event ${u.fmtT(r.created_at)} ${r.event_type || 'event'} on ${name}: ${u.clip(r.message, 120)}`);
}

function hostMetric(db, h, wantMem) {
  const day = new Date(Date.now() - 30 * u.DAY_MS).toISOString().slice(0, 10);
  const d = u.one(db, `SELECT SUM(cpu_sum_mhz) cs, SUM(cpu_samples) cn, MAX(cpu_max_mhz) cmax, AVG(cpu_capacity_mhz_last) ccap,
      SUM(mem_sum_bytes) ms, SUM(mem_samples) mn, MAX(mem_max_bytes) mmax, AVG(mem_capacity_bytes_last) mcap
    FROM vcenter_host_daily WHERE vcenter_id = ? AND lower(host_name) = lower(?) AND day >= ?`, h.vcenter_id, h.name, day);
  if (!wantMem) {
    const now = u.pctOf(h.cpu_mhz_used, h.cpu_mhz_capacity);
    const avg = d && d.cn && d.ccap ? u.pctOf(d.cs / d.cn, d.ccap) : null;
    const max = d && d.ccap ? u.pctOf(d.cmax, d.ccap) : null;
    return { name: 'cpu', now, avg30d: avg, max30d: max, unit: '%' };
  }
  const now = u.pctOf(h.mem_bytes_used, h.mem_bytes_capacity);
  const avg = d && d.mn && d.mcap ? u.pctOf(d.ms / d.mn, d.mcap) : null;
  const max = d && d.mcap ? u.pctOf(d.mmax, d.mcap) : null;
  return { name: 'memory', now, avg30d: avg, max30d: max, unit: '%' };
}

function vmMetric(db, vm, host, wantMem) {
  const day = new Date(Date.now() - 30 * u.DAY_MS).toISOString().slice(0, 10);
  const d = u.one(db, `SELECT SUM(cpu_sum_mhz) cs, SUM(cpu_samples) cn, MAX(cpu_max_mhz) cmax,
      SUM(mem_sum_mb) ms, SUM(mem_samples) mn, MAX(mem_max_mb) mmax
    FROM vcenter_vm_daily WHERE vcenter_id = ? AND lower(vm_name) = lower(?) AND day >= ?`, vm.vcenter_id, vm.name, day);
  if (wantMem) {
    return {
      name: 'memory', unit: '%', now: u.pctOf(vm.mem_usage_mb, vm.memory_mb),
      avg30d: d && d.mn ? u.pctOf(d.ms / d.mn, vm.memory_mb) : null, max30d: d ? u.pctOf(d.mmax, vm.memory_mb) : null,
    };
  }
  // Same formula as the observer: per-core MHz of the placed host times the VM's vCPU count.
  const perCore = host && host.cpu_mhz_capacity && host.cpu_cores ? host.cpu_mhz_capacity / host.cpu_cores : null;
  const cap = perCore && vm.cpu_count ? perCore * vm.cpu_count : null;
  return {
    name: 'cpu', unit: '%', now: cap ? u.pctOf(vm.cpu_usage_mhz, cap) : null,
    avg30d: cap && d && d.cn ? u.pctOf(d.cs / d.cn, cap) : null, max30d: cap && d ? u.pctOf(d.cmax, cap) : null,
  };
}

function metricText(m) {
  if (!m || m.now == null) return null;
  const hist = m.avg30d != null ? ` (30-day avg ${u.pctText(m.avg30d)} max ${u.pctText(m.max30d)})` : '';
  return `${m.name === 'cpu' ? 'CPU' : 'memory'} now ${u.pctText(m.now)}${hist}`;
}

function hostBlock(db, ctx, sub, wantMem) {
  const h = sub.row;
  const facts = u.emptyFacts();
  const lines = [];
  // vCenter stores POWERED_ON (SOAP enum), older rows poweredOn: compare without the underscore.
  const vms = u.one(db, `SELECT COUNT(*) n, SUM(CASE WHEN replace(lower(power_state), '_', '') = 'poweredon' THEN 1 ELSE 0 END) on_n
    FROM vcenter_vms WHERE vcenter_id = ? AND lower(host_name) = lower(?)`, h.vcenter_id, h.name) || { n: 0, on_n: 0 };
  facts.metric = hostMetric(db, h, wantMem);
  const since = issueHistory(db, ctx, h.name, facts, lines);
  const hostsIssueSince = since ? ` since ${u.fmtT(since)}` : '';
  facts.state = h.connection_state || null;
  facts.since = since || null;
  lines.unshift([
    `ESX host ${h.name} (cluster ${h.cluster_name || '-'}, ${h.vc_name || 'vCenter'}): connection ${h.connection_state || 'unknown'}${hostsIssueSince}`,
    h.in_maintenance ? 'in maintenance mode' : null,
    `${vms.n} VMs placed, ${vms.on_n || 0} powered on now`,
    metricText(facts.metric),
  ].filter(Boolean).join(', '));
  // VM alerts in the incident whose VM sits on this host: one summary line.
  const kids = [...new Set(u.alertsFor(ctx, platform).map((a) => u.cleanHost(a.host)).filter((n) => n && u.lc(n) !== u.lc(h.name)))]
    .filter((n) => u.one(db, 'SELECT 1 x FROM vcenter_vms WHERE vcenter_id = ? AND lower(name) = lower(?) AND lower(host_name) = lower(?) LIMIT 1', h.vcenter_id, n, h.name));
  if (kids.length) lines.push(`${kids.length} VMs on this host alerting: ${kids.slice(0, 6).join(', ')}${kids.length > 6 ? ', ...' : ''}`);
  lines.push(...eventLines(db, ctx, h.name));
  return u.makeBlock(platform, h.name, `vCenter host ${h.name}`, lines, facts);
}

function datastoreText(db, vm) {
  const names = u.listOf(vm.datastores);
  if (!names.length) return null;
  const full = [];
  for (const n of names.slice(0, 6)) {
    const ds = u.one(db, 'SELECT capacity_bytes, free_bytes FROM vcenter_datastores WHERE vcenter_id = ? AND lower(name) = lower(?) LIMIT 1', vm.vcenter_id, n);
    const used = ds && ds.capacity_bytes ? u.pctOf(ds.capacity_bytes - (ds.free_bytes || 0), ds.capacity_bytes) : null;
    if (used != null && used >= 85) full.push(`${n} ${u.pctText(used)} full`);
  }
  return `datastores ${names.slice(0, 4).join(', ')}${full.length ? ` (${full.join(', ')})` : ''}`;
}

function vmBlock(db, ctx, sub, wantMem) {
  const vm = sub.row;
  const facts = u.emptyFacts();
  const lines = [];
  const host = vm.host_name
    ? u.one(db, 'SELECT * FROM vcenter_hosts WHERE vcenter_id = ? AND lower(name) = lower(?) LIMIT 1', vm.vcenter_id, vm.host_name)
    : null;
  facts.metric = vmMetric(db, vm, host, wantMem);
  issueHistory(db, ctx, vm.name, facts, lines);
  facts.state = vm.power_state || null;
  const gb = vm.memory_mb ? `${Math.round(vm.memory_mb / 1024)} GB` : null;
  lines.unshift([
    `VM ${vm.name}${vm.host_name ? ` on ${vm.host_name}` : ''} (cluster ${vm.cluster_name || '-'}): ${vm.power_state || 'power state unknown'}`,
    vm.tools_status ? `tools ${vm.tools_status}` : null,
    vm.cpu_count || gb ? `${vm.cpu_count || '?'} vCPU ${gb || '?'}` : null,
    metricText(facts.metric),
    datastoreText(db, vm),
  ].filter(Boolean).join(', '));
  const vols = u.all(db, `SELECT mount, used_pct FROM vcenter_vm_filesystems WHERE vcenter_id = ? AND lower(vm_name) = lower(?)
    AND used_pct >= 80 ORDER BY used_pct DESC LIMIT 3`, vm.vcenter_id, vm.name);
  if (vols.length) lines.push(`Guest volumes near full on ${vm.name}: ${vols.map((v) => `${v.mount} ${u.pctText(v.used_pct)}`).join(', ')}`);
  lines.push(...eventLines(db, ctx, vm.name));
  return u.makeBlock(platform, vm.name, `vCenter VM ${vm.name}`, lines, facts);
}

function vcenterBlock(db, ctx, sub) {
  const vc = sub.row;
  const facts = { ...u.emptyFacts(), state: vc.last_poll_status || null };
  const lines = [`vCenter ${vc.name} (${vc.host}${vc.version ? `, ${vc.version}` : ''}): last poll ${vc.last_poll_status || 'unknown'} at ${u.fmtT(vc.last_poll_at)}${vc.last_poll_error ? `, error: ${u.clip(vc.last_poll_error, 100)}` : ''}`];
  issueHistory(db, ctx, vc.name, facts, lines);
  return u.makeBlock(platform, vc.name, `vCenter ${vc.name}`, lines, facts);
}

function run(db, ctx) {
  const names = u.subjectsFor(ctx, platform);
  if (!names.length) return null;
  const sub = findSubject(db, names);
  if (!sub) return null;
  const types = u.alertsFor(ctx, platform).map((a) => `${a.type || ''} ${a.message || ''}`).join(' ');
  const wantMem = /mem/i.test(types) && !/cpu/i.test(types);
  if (sub.kind === 'host') return hostBlock(db, ctx, sub, wantMem);
  if (sub.kind === 'vm') return vmBlock(db, ctx, sub, wantMem);
  return vcenterBlock(db, ctx, sub);
}

module.exports = { platform, run };
