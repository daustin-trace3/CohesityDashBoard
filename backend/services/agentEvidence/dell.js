// Dell evidence (OpenManage): one server with its health, components not ok,
// OME alerts on its service tag, hardware log entries around the incident and
// firmware compliance. Dell has no issue history table, so alert counts stand in.
const u = require('./util');

const platform = 'dell';
const OK = /^(ok|healthy|normal|good|ready|present|enabled|online|unknown|n\/a)$/i;

function findDevice(db, ctx, names) {
  for (const n of names) {
    const d = u.one(db, 'SELECT * FROM dell_devices WHERE lower(name) = lower(?) OR lower(service_tag) = lower(?) OR lower(os_hostname) = lower(?) LIMIT 1', n, n, n);
    if (d) return d;
  }
  for (const a of u.alertsFor(ctx, platform)) {
    const m = /^d(\d+):(.+)$/.exec(String(a.source_key || ''));
    if (!m) continue;
    const al = u.one(db, 'SELECT service_tag, device_name FROM dell_alerts WHERE ome_id = ? AND alert_id = ? LIMIT 1', Number(m[1]), m[2]);
    if (!al) continue;
    const d = u.one(db, 'SELECT * FROM dell_devices WHERE ome_id = ? AND (lower(service_tag) = lower(?) OR lower(name) = lower(?)) LIMIT 1', Number(m[1]), al.service_tag || '', al.device_name || '');
    if (d) return d;
  }
  return null;
}

function run(db, ctx) {
  const d = findDevice(db, ctx, u.subjectsFor(ctx, platform));
  if (!d) return null;
  const facts = u.emptyFacts();
  const lines = [];
  const now = Date.now();
  facts.state = d.health || null;

  const comps = u.all(db, 'SELECT kind, name, status FROM dell_components WHERE ome_id = ? AND device_id = ? LIMIT 400', d.ome_id, d.device_id);
  const rank = (c) => (/crit|fail|error/i.test(String(c.status)) ? 0 : /warn/i.test(String(c.status)) ? 1 : 2);
  const bad = comps.filter((c) => c.status && !OK.test(String(c.status).trim())).sort((a, b) => rank(a) - rank(b));
  lines.push([
    `Dell ${d.name || d.service_tag}${d.service_tag ? ` (${d.service_tag})` : ''}${d.model ? ` ${d.model}` : ''}: health ${d.health || 'unknown'}, power ${d.power_state || 'unknown'}, connection ${d.connection_state || 'unknown'}${d.ip_address ? `, iDRAC ${d.ip_address}` : ''}`,
    bad.length ? `components not ok: ${bad.slice(0, 6).map((c) => `${c.name || c.kind} ${c.status}`).join(', ')}` : `${comps.length} components, none not ok`,
  ].join(', '));
  const readings = [
    d.cpu_util_pct != null ? `CPU ${u.pctText(d.cpu_util_pct)}` : null, d.mem_util_pct != null ? `memory ${u.pctText(d.mem_util_pct)}` : null,
    d.inlet_temp_c != null ? `inlet ${u.num(d.inlet_temp_c)} C` : null, d.power_w != null ? `${u.num(d.power_w)} W` : null,
  ].filter(Boolean);
  if (readings.length) lines.push(`Dell ${d.name || d.service_tag} now: ${readings.join(', ')}`);

  // OME alerts for this tag: created_at is the raw OME stamp, so filter on parsed time.
  const alerts = u.all(db, `SELECT severity, status, category, message, created_at FROM dell_alerts
    WHERE ome_id = ? AND (lower(service_tag) = lower(?) OR lower(device_name) = lower(?)) ORDER BY id DESC LIMIT 300`, d.ome_id, d.service_tag || '', d.name || '');
  const stamped = alerts.map((a) => ({ ...a, ms: u.parseMs(a.created_at) }));
  const w24 = u.windowStart(ctx);
  const in24 = stamped.filter((a) => a.ms != null && a.ms >= w24);
  const in30 = stamped.filter((a) => a.ms != null && a.ms >= now - 30 * u.DAY_MS);
  if (in24.length) {
    const cats = [...new Set(in24.map((a) => a.category).filter(Boolean))].slice(0, 3);
    lines.push(`${in24.length} OME alerts in 24 h${cats.length ? ` (${cats.join(', ')})` : ''}; newest: ${u.clip(in24[0].message, 120)}`);
  }
  if (in30.length > in24.length) {
    const by = {};
    for (const a of in30) by[a.category || 'other'] = (by[a.category || 'other'] || 0) + 1;
    lines.push(`OME alerts on ${d.name || d.service_tag} in 30 days: ${in30.length} (${Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  }
  facts.openedTimes30d = in30.length || null;

  const logs = u.all(db, `SELECT severity, message_id, message, created_at FROM dell_hardware_logs
    WHERE ome_id = ? AND device_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 6`, d.ome_id, d.device_id, u.zl(w24));
  for (const l of logs) lines.push(`Hardware log ${u.fmtT(l.created_at)} ${l.message_id || ''} ${l.severity || ''}: ${u.clip(l.message, 120)}`.replace(/\s{2,}/g, ' '));

  const fw = u.one(db, `SELECT status, noncompliant_components, baseline_name FROM dell_firmware_compliance
    WHERE ome_id = ? AND (device_id = ? OR lower(service_tag) = lower(?)) ORDER BY id DESC LIMIT 1`, d.ome_id, d.device_id, d.service_tag || '');
  if (fw) lines.push(`Firmware: ${fw.status || 'status unknown'}${fw.noncompliant_components != null ? `, ${fw.noncompliant_components} components behind baseline${fw.baseline_name ? ` ${fw.baseline_name}` : ''}` : ''}`);

  return u.makeBlock(platform, d.name || d.service_tag, `Dell server ${d.name || d.service_tag}`, lines, facts);
}

module.exports = { platform, run };
