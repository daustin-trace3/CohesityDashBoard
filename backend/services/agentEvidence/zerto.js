// Zerto evidence: a VPG (RPO against its target, journal, status, sites), a
// site (connection, VRAs, VPGs on it that are not healthy) or a protected VM
// (its VPGs), with Zerto's own alerts and events around the incident.
// zerto_alerts is rewritten each poll, so alert counts show what is open now.
const u = require('./util');

const platform = 'zerto';
const HEALTHY = /^(meetingsla|healthy|ok|connected|protecting|up|0)$/i;

function findSubject(db, names) {
  for (const n of names) {
    const vpg = u.one(db, 'SELECT * FROM zerto_vpgs WHERE lower(name) = lower(?) LIMIT 1', n);
    if (vpg) return { kind: 'vpg', vpg };
    const site = u.one(db, 'SELECT * FROM zerto_sites WHERE lower(name) = lower(?) LIMIT 1', n);
    if (site) return { kind: 'site', site };
    const vm = u.one(db, 'SELECT * FROM zerto_vms WHERE lower(name) = lower(?) LIMIT 1', n);
    if (vm) {
      const vpgName = u.listOf(vm.vpg_names)[0];
      const vpg = vpgName ? u.one(db, 'SELECT * FROM zerto_vpgs WHERE lower(name) = lower(?) LIMIT 1', vpgName) : null;
      if (vpg) return { kind: 'vpg', vpg, viaVm: vm.name };
    }
  }
  return null;
}

function vpgLine(v, viaVm) {
  const rpo = v.actual_rpo != null ? `RPO ${v.actual_rpo} s${v.configured_rpo != null ? ` against ${v.configured_rpo} s configured` : ''}` : 'RPO not reported';
  const journal = v.actual_journal_history != null ? `, journal history ${v.actual_journal_history} of ${v.configured_journal_history ?? '?'} (as reported)` : '';
  return `${viaVm ? `VM ${viaVm} is in ` : ''}Zerto VPG ${v.name}: ${rpo}${journal}, status ${v.status || 'unknown'}${v.sub_status ? ` (${v.sub_status})` : ''}, ${v.vms_count ?? '?'} VMs, protected site ${v.protected_site || '-'}, recovery site ${v.recovery_site || '-'}`;
}

function alertLines(db, subjectNames, lines, facts) {
  const ph = subjectNames.map(() => '?').join(',');
  const rows = u.all(db, `SELECT alert_type, severity, description, site_name, collection_time, captured_at FROM zerto_alerts
    WHERE lower(site_name) IN (${ph}) ORDER BY id DESC LIMIT 60`, ...subjectNames.map(u.lc));
  if (!rows.length) return;
  lines.push(`${rows.length} Zerto alerts open for ${subjectNames[0]}: ${[...new Set(rows.map((r) => r.alert_type).filter(Boolean))].slice(0, 4).join(', ') || 'untyped'}`);
  for (const a of rows.slice(0, 3)) lines.push(`Zerto alert ${u.fmtT(a.collection_time || a.captured_at)} ${a.severity || ''} ${a.alert_type || ''}: ${u.clip(a.description, 120)}`);
  facts.openedTimes30d = rows.length;
}

function eventLines(db, ctx, siteName, vpgName) {
  if (!u.hasTable(db, 'zerto_events')) return [];
  const from = u.iso(u.windowStart(ctx)).slice(0, 19);
  const like = vpgName ? `%${String(vpgName).replace(/[%_]/g, '')}%` : null;
  const rows = u.all(db, `SELECT event_type, category, description, occurred_on FROM zerto_events
    WHERE occurred_on >= ? AND (lower(site_name) = lower(?) ${like ? 'OR description LIKE ?' : ''}) ORDER BY occurred_on DESC LIMIT 6`,
  ...[from, siteName || '', ...(like ? [like] : [])]);
  return rows.map((r) => `Zerto event ${u.fmtT(r.occurred_on)} ${r.event_type || r.category || 'event'}: ${u.clip(r.description, 120)}`);
}

function run(db, ctx) {
  const names = u.subjectsFor(ctx, platform);
  if (!names.length) return null;
  const sub = findSubject(db, names);
  if (!sub) return null;
  const facts = u.emptyFacts();
  const lines = [];

  if (sub.kind === 'vpg') {
    const v = sub.vpg;
    lines.push(vpgLine(v, sub.viaVm));
    facts.state = v.status || null;
    facts.replication = { kind: 'zerto', lagMinutes: v.actual_rpo != null ? Math.round(v.actual_rpo / 60) : null, status: v.status || null };
    facts.metric = { name: 'rpo', now: v.actual_rpo ?? null, avg30d: null, max30d: null, unit: 's' };
    const hist = u.one(db, `SELECT AVG(avg_actual_rpo) a, MAX(avg_actual_rpo) m FROM zerto_metrics_history WHERE captured_at >= ?`, u.zl(Date.now() - 30 * u.DAY_MS));
    if (hist && hist.a != null) {
      facts.metric.avg30d = Math.round(hist.a);
      facts.metric.max30d = Math.round(hist.m);
      lines.push(`Zerto estate average RPO over 30 days: avg ${Math.round(hist.a)} s, max ${Math.round(hist.m)} s (all VPGs, not this one alone)`);
    }
    alertLines(db, [v.protected_site, v.recovery_site].filter(Boolean), lines, facts);
    lines.push(...eventLines(db, ctx, v.protected_site, v.name));
    return u.makeBlock(platform, v.name, `Zerto VPG ${v.name}`, lines, facts);
  }

  const s = sub.site;
  const vras = u.all(db, 'SELECT name, status FROM zerto_vras WHERE lower(site_name) = lower(?) LIMIT 50', s.name);
  const badVras = vras.filter((r) => r.status && !HEALTHY.test(String(r.status).trim()));
  lines.push(`Site ${s.name}: connection ${s.connection_status || 'unknown'}${s.zvm_ip ? ` (ZVM ${s.zvm_ip})` : ''}, ${vras.length} VRAs (${badVras.length} not healthy${badVras.length ? `: ${badVras.slice(0, 4).map((r) => `${r.name} ${r.status}`).join(', ')}` : ''})`);
  facts.state = s.connection_status || null;
  const vpgs = u.all(db, `SELECT name, status, actual_rpo, configured_rpo FROM zerto_vpgs
    WHERE lower(protected_site) = lower(?) OR lower(recovery_site) = lower(?) LIMIT 300`, s.name, s.name);
  const off = vpgs.filter((v) => v.status && !HEALTHY.test(String(v.status).trim()));
  if (vpgs.length) {
    lines.push(`${vpgs.length} VPGs touch site ${s.name}, ${off.length} not meeting SLA${off.length ? `: ${off.slice(0, 4).map((v) => `${v.name} ${v.status} (RPO ${v.actual_rpo ?? '-'} s)`).join(', ')}` : ''}`);
    if (off[0]) facts.replication = { kind: 'zerto', lagMinutes: off[0].actual_rpo != null ? Math.round(off[0].actual_rpo / 60) : null, status: off[0].status };
  }
  alertLines(db, [s.name], lines, facts);
  lines.push(...eventLines(db, ctx, s.name, null));
  return u.makeBlock(platform, s.name, `Zerto site ${s.name}`, lines, facts);
}

module.exports = { platform, run };
