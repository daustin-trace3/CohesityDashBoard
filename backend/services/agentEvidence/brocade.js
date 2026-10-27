// Brocade evidence (SANnav): a switch (status, health score, ports down), or a
// host's switch port with its CRC and invalid-word counts, plus SANnav events
// around the incident and how often the same issue opened. Current-state
// tables have no captured_at; they carry updated_at.
const u = require('./util');

const platform = 'brocade';

/** "brocade:<sourceId>:<type>:<target>" -> { sourceId, type, target } (events carry "event:<id>" and are skipped). */
function parseKey(key) {
  const m = /^brocade:(\d+):([^:]+):(.+)$/.exec(String(key || ''));
  return m && m[2] !== 'event' ? { sourceId: Number(m[1]), type: m[2], target: m[3] } : null;
}

function switchByName(db, name) {
  return u.one(db, `SELECT s.*, f.name AS fabric FROM brocade_switches s LEFT JOIN brocade_fabrics f
    ON f.source_id = s.source_id AND f.principal_switch_wwn = s.principal_switch_wwn
    WHERE lower(s.name) = lower(?) ORDER BY s.stale ASC LIMIT 1`, name);
}

function findSubject(db, ctx, names) {
  const keyed = u.alertsFor(ctx, platform).map((a) => parseKey(a.source_key)).filter(Boolean);
  const cands = [...names, ...keyed.map((k) => k.target)];
  for (const n of cands) {
    const sw = switchByName(db, n);
    if (sw) return { sw, name: sw.name };
    const dp = u.one(db, `SELECT * FROM brocade_device_ports WHERE lower(fdmi_host_name) = lower(?) OR lower(enclosure_name) = lower(?)
      OR lower(symbolic_name) = lower(?) ORDER BY stale ASC LIMIT 1`, n, n, n);
    if (dp) {
      const sw2 = switchByName(db, dp.switch_name);
      if (sw2) return { sw: sw2, name: n, devicePort: dp };
    }
  }
  return null;
}

function portLine(db, sw, dp, hostName, facts, now) {
  const sp = u.one(db, 'SELECT * FROM brocade_switch_ports WHERE source_id = ? AND wwn = ? LIMIT 1', dp.source_id, dp.switch_port_wwn || '')
    || u.one(db, 'SELECT * FROM brocade_switch_ports WHERE source_id = ? AND switch_wwn = ? AND slot_number = ? AND port_number = ? LIMIT 1', dp.source_id, sw.wwn, dp.slot_number ?? -1, dp.port_number ?? -1);
  const label = dp.switch_port_name || `${dp.slot_number ?? 0}/${dp.port_number ?? '?'}`;
  const wwn = (sp && sp.wwn) || dp.switch_port_wwn;
  let crc24 = null;
  let inv24 = null;
  let crc30 = null;
  if (wwn && u.hasTable(db, 'brocade_port_stats')) {
    const a = u.one(db, 'SELECT SUM(crc_errors_delta) c, SUM(invalid_words) w FROM brocade_port_stats WHERE source_id = ? AND port_wwn = ? AND ts >= ?', dp.source_id, wwn, u.zl(now - u.DAY_MS));
    const b = u.one(db, 'SELECT SUM(crc_errors_delta) c FROM brocade_port_stats WHERE source_id = ? AND port_wwn = ? AND ts >= ?', dp.source_id, wwn, u.zl(now - 30 * u.DAY_MS));
    crc24 = a && a.c != null ? a.c : null;
    inv24 = a && a.w != null ? a.w : null;
    crc30 = b && b.c != null ? b.c : null;
  }
  if (crc24 != null) {
    facts.metric = { name: 'crc_errors_24h', now: crc24, avg30d: crc30 != null ? Math.round(crc30 / 30) : null, max30d: null, unit: 'count' };
  }
  return `Port ${sw.name} ${label} for ${hostName}: state ${(sp && sp.state) || 'unknown'}${sp && sp.speed ? ` at ${sp.speed}` : ''}${crc24 != null ? `, CRC errors ${crc24} in 24 h` : ''}${inv24 != null ? `, invalid words ${inv24} in 24 h` : ''}${sp && (sp.fenced || sp.blocked) ? ', fenced or blocked' : ''}`;
}

function run(db, ctx) {
  const sub = findSubject(db, ctx, u.subjectsFor(ctx, platform));
  if (!sub) return null;
  const sw = sub.sw;
  const facts = u.emptyFacts();
  const lines = [];
  const now = Date.now();

  const score = u.one(db, `SELECT score, status FROM brocade_health_scores WHERE source_id = ?
    AND (lower(entity_name) = lower(?) OR entity_wwn = ?) ORDER BY id DESC LIMIT 1`, sw.source_id, sw.name || '', sw.wwn || '');
  const ports = u.all(db, 'SELECT state, occupied, persistent_disable FROM brocade_switch_ports WHERE source_id = ? AND switch_wwn = ? LIMIT 1000', sw.source_id, sw.wwn);
  const down = ports.filter((p) => (p.occupied == null || p.occupied === 1) && !p.persistent_disable && p.state && !/^online$/i.test(String(p.state).trim()));
  const status = sw.status || sw.operational_status || sw.health || 'unknown';
  facts.state = status;
  const where = [sw.fabric || sw.fabric_name ? `fabric ${sw.fabric || sw.fabric_name}` : null, sw.firmware_version ? `FOS ${sw.firmware_version}` : null].filter(Boolean);
  lines.push(`Brocade switch ${sw.name}${where.length ? ` (${where.join(', ')})` : ''}: status ${status}${score && score.score != null ? `, health score ${Math.round(score.score)}` : ''}${ports.length ? `, ${ports.length} ports, ${down.length} down` : ''}${sw.status_reason ? `, reason: ${u.clip(sw.status_reason, 80)}` : ''}`);

  if (sub.devicePort) lines.push(portLine(db, sw, sub.devicePort, sub.name, facts, now));

  const since24 = u.windowStart(ctx);
  const ev = u.all(db, `SELECT severity_norm, description, last_occurred_ms FROM brocade_events
    WHERE source_id = ? AND last_occurred_ms >= ? AND (lower(source_name) = lower(?) OR source_address = ? OR lower(source_wwn) = lower(?))
    ORDER BY last_occurred_ms DESC LIMIT 60`, sw.source_id, since24, sw.name || '', sw.ip_address || '', sw.wwn || '');
  if (ev.length) {
    const warn = ev.filter((e) => /warn/i.test(String(e.severity_norm))).length;
    const crit = ev.filter((e) => /crit|alert|error/i.test(String(e.severity_norm))).length;
    lines.push(`Events: ${ev.length} in 24 h (${crit} critical, ${warn} warning); newest ${u.fmtT(ev[0].last_occurred_ms)}: ${u.clip(ev[0].description, 120)}`);
    for (const e of ev.slice(1, 3)) lines.push(`Brocade event ${u.fmtT(e.last_occurred_ms)} ${e.severity_norm || ''}: ${u.clip(e.description, 120)}`);
  }

  // Issue history: no issue_key and no status column; open means resolved_at IS NULL.
  const keyed = u.alertsFor(ctx, platform).map((a) => parseKey(a.source_key)).filter(Boolean).find((k) => u.lc(k.target) === u.lc(sub.name) || u.lc(k.target) === u.lc(sw.name));
  const target = keyed ? keyed.target : sub.name;
  const rows = u.all(db, `SELECT type, first_seen, resolved_at FROM brocade_issue_history
    WHERE lower(target) = lower(?) ${keyed ? 'AND type = ?' : ''} AND first_seen >= ? ORDER BY first_seen DESC LIMIT 200`,
  ...[target, ...(keyed ? [keyed.type] : []), u.zl(now - 30 * u.DAY_MS)]);
  const { line, stats } = u.issueLine(keyed ? keyed.type : rows[0] && rows[0].type, target, rows);
  if (line) lines.push(line);
  if (stats.opened) { facts.openedTimes30d = stats.opened; facts.meanMinutesOpen30d = stats.meanMinutes; }

  return u.makeBlock(platform, sub.name, `Brocade ${sub.devicePort ? `host ${sub.name} on switch ${sw.name}` : `switch ${sw.name}`}`, lines, facts);
}

module.exports = { platform, run };
