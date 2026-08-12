// Computed UniFi issues (shared by router.js and poller.js) plus their
// lifecycle history — nutanixIssues.js model exactly. Issue identity is
// `type|source|target` — stable across polls even as the message text
// changes.
//
// Ported from backend/services/unifiIssues.js — db/getSetting now come from
// coreApi rather than direct host requires.
function clampedInt(coreApi, key, def, min, max) {
  const n = Number(coreApi.settings.getSetting(key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
}

const wanLatencyWarnMs = (coreApi) => clampedInt(coreApi, 'unifi_wan_latency_warn_ms', 75, 1, 5000);
const wanAvailWarnPct = (coreApi) => clampedInt(coreApi, 'unifi_wan_avail_warn_pct', 99, 0, 100);
const portErrDeltaWarn = (coreApi) => clampedInt(coreApi, 'unifi_port_err_delta_warn', 500, 1, 1000000);
const portFlapWarn = (coreApi) => clampedInt(coreApi, 'unifi_port_flap_warn', 3, 1, 100);
const deviceCpuWarnPct = (coreApi) => clampedInt(coreApi, 'unifi_device_cpu_warn_pct', 90, 1, 100);
const deviceMemWarnPct = (coreApi) => clampedInt(coreApi, 'unifi_device_mem_warn_pct', 92, 1, 100);
const tempWarnC = (coreApi) => clampedInt(coreApi, 'unifi_temp_warn_c', 80, 1, 200);
const satisfactionWarn = (coreApi) => clampedInt(coreApi, 'unifi_satisfaction_warn', 50, 1, 100);
const newDeviceDays = (coreApi) => clampedInt(coreApi, 'unifi_new_device_days', 7, 1, 30);

// Module toggles (Settings → Feature Modules). Disabled modules poll nothing
// and surface nothing — including their issue rules.
const featureEnabled = (coreApi, name) => coreApi.settings.getSetting(`unifi_feature_${name}`) !== '0';

const thresholdGetters = {
  unifiWanLatencyWarnMs: wanLatencyWarnMs,
  unifiWanAvailWarnPct: wanAvailWarnPct,
  unifiPortErrDeltaWarn: portErrDeltaWarn,
  unifiPortFlapWarn: portFlapWarn,
  unifiDeviceCpuWarnPct: deviceCpuWarnPct,
  unifiDeviceMemWarnPct: deviceMemWarnPct,
  unifiTempWarnC: tempWarnC,
  unifiSatisfactionWarn: satisfactionWarn,
  unifiNewDeviceDays: newDeviceDays,
};

/**
 * Port error growth over the trailing 24h of unifi_port_history: delta
 * between the oldest and newest (rx_errors+tx_errors) sample for the port.
 * Returns null if fewer than 2 samples exist in the window.
 */
function portErrorDelta24h(coreApi, sourceId, deviceMac, portIdx) {
  const rows = coreApi.db.prepare(`
    SELECT rx_errors, tx_errors FROM unifi_port_history
    WHERE source_id = ? AND device_mac = ? AND port_idx = ? AND captured_at >= datetime('now', '-1 day')
    ORDER BY captured_at ASC
  `).all(sourceId, deviceMac, portIdx);
  if (rows.length < 2) return null;
  const first = (rows[0].rx_errors || 0) + (rows[0].tx_errors || 0);
  const last = (rows[rows.length - 1].rx_errors || 0) + (rows[rows.length - 1].tx_errors || 0);
  const delta = last - first;
  return delta > 0 ? delta : 0;
}

/** Count of up-state transitions (0->1 or 1->0) in the trailing 24h history. */
function portFlapCount24h(coreApi, sourceId, deviceMac, portIdx) {
  const rows = coreApi.db.prepare(`
    SELECT up FROM unifi_port_history
    WHERE source_id = ? AND device_mac = ? AND port_idx = ? AND captured_at >= datetime('now', '-1 day')
    ORDER BY captured_at ASC
  `).all(sourceId, deviceMac, portIdx);
  let transitions = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].up !== rows[i - 1].up) transitions += 1;
  }
  return transitions;
}

function computeIssues(coreApi) {
  const db = coreApi.db;
  const issues = [];
  const sources = db.prepare('SELECT * FROM unifi_sources').all();
  const srcName = new Map(sources.map((s) => [s.id, s.name]));

  // Rule 1: source-unreachable
  for (const src of sources) {
    if (src.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'source-unreachable', source: src.name, target: src.host,
        message: `UniFi source ${src.name} is unreachable: ${src.last_poll_error || 'poll failed'}` });
    }
  }

  // Rule 2: device-offline / Rule 6: device-load / Rule 7: device-overheating
  // Rule 11: firmware-upgrade
  const cpuWarn = deviceCpuWarnPct(coreApi);
  const memWarn = deviceMemWarnPct(coreApi);
  const tWarn = tempWarnC(coreApi);
  const devices = db.prepare('SELECT * FROM unifi_devices').all();
  for (const d of devices) {
    const source = srcName.get(d.source_id) || `source ${d.source_id}`;
    if (d.state !== 1) {
      issues.push({ severity: 'critical', type: 'device-offline', source, target: d.name || d.mac,
        message: `Device ${d.name || d.mac} is offline (state ${d.state})` });
    }
    if ((d.cpu_pct != null && d.cpu_pct >= cpuWarn) || (d.mem_pct != null && d.mem_pct >= memWarn)) {
      issues.push({ severity: 'warning', type: 'device-load', source, target: d.name || d.mac,
        message: `Device ${d.name || d.mac} is under load (cpu ${d.cpu_pct ?? '—'}%, mem ${d.mem_pct ?? '—'}%)` });
    }
    let hotTemp = null;
    if (d.temps_json) {
      try {
        const temps = JSON.parse(d.temps_json) || [];
        for (const t of temps) {
          if (typeof t?.value === 'number' && t.value >= tWarn) { hotTemp = t.value; break; }
        }
      } catch { /* ignore */ }
    }
    if (d.overheating === 1 || hotTemp != null) {
      issues.push({ severity: 'warning', type: 'device-overheating', source, target: d.name || d.mac,
        message: `Device ${d.name || d.mac} is overheating${hotTemp != null ? ` (${hotTemp}C)` : ''}` });
    }
    if (d.upgradable === 1) {
      issues.push({ severity: 'info', type: 'firmware-upgrade', source, target: d.name || d.mac,
        message: `Device ${d.name || d.mac} has a firmware upgrade available` });
    }
  }

  // Rule 3: poe-fault / Rule 4: port-errors / Rule 5: port-flapping
  const errDeltaWarn = portErrDeltaWarn(coreApi);
  const flapWarn = portFlapWarn(coreApi);
  const deviceByMac = new Map(devices.map((d) => [`${d.source_id}|${d.mac}`, d]));
  const ports = db.prepare('SELECT * FROM unifi_ports').all();
  for (const p of ports) {
    const source = srcName.get(p.source_id) || `source ${p.source_id}`;
    const dev = deviceByMac.get(`${p.source_id}|${p.device_mac}`);
    const devName = dev?.name || p.device_mac;
    const target = `${devName} port ${p.port_idx}`;
    if (p.poe_enable === 1 && p.poe_good === 0) {
      issues.push({ severity: 'critical', type: 'poe-fault', source, target,
        message: `PoE fault on ${target}` });
    }
    const errDelta = portErrorDelta24h(coreApi, p.source_id, p.device_mac, p.port_idx);
    if (errDelta != null && errDelta >= errDeltaWarn) {
      issues.push({ severity: 'warning', type: 'port-errors', source, target,
        message: `${target} has grown ${errDelta} error(s) in the last 24h` });
    }
    const flaps = portFlapCount24h(coreApi, p.source_id, p.device_mac, p.port_idx);
    if (flaps >= flapWarn) {
      issues.push({ severity: 'warning', type: 'port-flapping', source, target,
        message: `${target} has flapped ${flaps} time(s) in the last 24h` });
    }
  }

  // Rule 8: wan-latency / wan-availability
  const latencyWarn = wanLatencyWarnMs(coreApi);
  const availWarn = wanAvailWarnPct(coreApi);
  for (const w of db.prepare('SELECT * FROM unifi_wan').all()) {
    const source = srcName.get(w.source_id) || `source ${w.source_id}`;
    const target = w.isp_name || w.wan_name || 'WAN';
    if (w.latency_ms != null && w.latency_ms >= latencyWarn) {
      issues.push({ severity: 'warning', type: 'wan-latency', source, target,
        message: `WAN latency is ${w.latency_ms}ms on ${target}` });
    }
    if (w.availability_pct != null && w.availability_pct < availWarn) {
      issues.push({ severity: 'warning', type: 'wan-availability', source, target,
        message: `WAN availability is ${w.availability_pct}% on ${target}` });
    }
  }

  // Rule 9: rogue-ap (WiFi module)
  if (featureEnabled(coreApi, 'wifi')) for (const r of db.prepare('SELECT * FROM unifi_rogue_aps WHERE is_rogue = 1').all()) {
    const source = srcName.get(r.source_id) || `source ${r.source_id}`;
    const target = r.essid || r.bssid;
    issues.push({ severity: 'warning', type: 'rogue-ap', source, target,
      message: `Rogue AP detected: ${target}` });
  }

  // Rule 10: ips-disabled (Security module) — one per source (site granularity
  // not tracked in this table set), target = source name.
  if (featureEnabled(coreApi, 'security')) for (const src of sources) {
    if (src.health_json) {
      // Best-effort: ips settings are not persisted as their own table per
      // contract's schema; the poller stamps ips-enabled state onto the
      // source via a dedicated flag captured in health_json.ips.
      let enabled = null;
      try { enabled = JSON.parse(src.health_json)?.ips?.enabled ?? null; } catch { enabled = null; }
      if (enabled === false) {
        issues.push({ severity: 'info', type: 'ips-disabled', source: src.name, target: src.name,
          message: `IPS/IDS is disabled on ${src.name}` });
      }
    }
  }

  // Rule 13: camera-offline (Protect module) — cameras/chimes not CONNECTED.
  if (featureEnabled(coreApi, 'protect')) try {
    for (const c of db.prepare("SELECT c.*, s.name AS source_name FROM unifi_cameras c JOIN unifi_sources s ON s.id = c.source_id WHERE c.state IS NOT NULL AND c.state != 'CONNECTED'").all()) {
      issues.push({ severity: 'warning', type: 'camera-offline', source: c.source_name, target: c.name || c.mac,
        message: `Protect ${c.model_key === 'chime' ? 'chime' : 'camera'} ${c.name || c.mac} is ${String(c.state).toLowerCase()}` });
    }
  } catch { /* unifi_cameras arrives in migration v2 — tolerate older DBs */ }

  // Rule 14: protect-breach (Protect module) — NVR alarm reports a breach.
  if (featureEnabled(coreApi, 'protect')) for (const src of sources) {
    if (!src.health_json) continue;
    let arm = null;
    try { arm = JSON.parse(src.health_json)?.protect?.nvr?.armMode ?? null; } catch { arm = null; }
    if (arm && (arm.breachDetectedAt || (arm.breachEventCount || 0) > 0)) {
      issues.push({ severity: 'critical', type: 'protect-breach', source: src.name, target: src.name,
        message: `Protect alarm breach on ${src.name} (${arm.breachEventCount || 1} event(s))` });
    }
  }

  // Rule 15: new-device — client first seen within the window (post-bootstrap),
  // info severity; auto-resolves when the window slides past first_seen.
  try {
    const days = newDeviceDays(coreApi);
    for (const src of sources) {
      const bootstrap = db.prepare('SELECT MIN(first_seen) t FROM unifi_client_seen WHERE source_id = ?').get(src.id).t;
      if (!bootstrap) continue;
      const rows = db.prepare(`
        SELECT mac, name FROM unifi_client_seen
        WHERE source_id = ? AND first_seen >= datetime('now', ?)
          AND first_seen > datetime(?, '+1 hour')
      `).all(src.id, `-${days} days`, bootstrap);
      for (const r of rows) {
        issues.push({ severity: 'info', type: 'new-device', source: src.name, target: r.name || r.mac,
          message: `New client on the network: ${r.name || r.mac} (first seen within ${days}d)` });
      }
    }
  } catch { /* unifi_client_seen arrives in migration v3 — tolerate older DBs */ }

  // Rule 12: wifi-experience — >=3 wireless clients under the satisfaction
  // threshold, grouped per source/site.
  const satWarn = satisfactionWarn(coreApi);
  const wifiOn = featureEnabled(coreApi, 'wifi');
  const bySite = new Map(); // `${source_id}|${site}` -> [clients]
  if (wifiOn) for (const c of db.prepare('SELECT * FROM unifi_clients WHERE is_wired = 0 AND satisfaction IS NOT NULL').all()) {
    if (c.satisfaction >= satWarn) continue;
    const key = `${c.source_id}|${c.site}`;
    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key).push(c);
  }
  for (const [key, clients] of bySite) {
    if (clients.length < 3) continue;
    const [sourceIdStr, site] = key.split('|');
    const source = srcName.get(Number(sourceIdStr)) || `source ${sourceIdStr}`;
    const worst = clients.reduce((min, c) => (c.satisfaction < min.satisfaction ? c : min), clients[0]);
    issues.push({ severity: 'info', type: 'wifi-experience', source, target: site,
      message: `${clients.length} wireless client(s) with poor satisfaction on ${site} (worst: ${worst.name || worst.hostname || worst.mac} at ${worst.satisfaction})` });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.source}|${i.target}`;

/**
 * Sync the computed issue set into unifi_issue_history: new issues open a
 * row, still-present ones bump last_seen, and open rows whose issue is gone
 * get resolved. Idempotent — safe to run after every poll. Rows resolved
 * >90 days ago are pruned.
 */
function reconcileIssueHistory(coreApi) {
  const db = coreApi.db;
  const run = db.transaction(() => {
    const current = new Map(computeIssues(coreApi).map((i) => [issueKey(i), i]));
    const open = db.prepare("SELECT * FROM unifi_issue_history WHERE status = 'open'").all();

    const touch = db.prepare(`
      UPDATE unifi_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
    `);
    const resolve = db.prepare(`
      UPDATE unifi_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
    `);
    const insert = db.prepare(`
      INSERT INTO unifi_issue_history (issue_key, source, severity, type, target, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const openKeys = new Set();
    for (const row of open) {
      const cur = current.get(row.issue_key);
      if (cur) {
        openKeys.add(row.issue_key);
        touch.run(cur.message, cur.severity, row.id);
      } else {
        resolve.run(row.id);
      }
    }
    for (const [key, i] of current) {
      if (!openKeys.has(key)) insert.run(key, i.source, i.severity, i.type, i.target, i.message);
    }
    db.prepare("DELETE FROM unifi_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
  });
  run();
}

module.exports = {
  wanLatencyWarnMs, wanAvailWarnPct, portErrDeltaWarn, portFlapWarn,
  deviceCpuWarnPct, deviceMemWarnPct, tempWarnC, satisfactionWarn, newDeviceDays,
  featureEnabled,
  thresholdGetters,
  computeIssues, reconcileIssueHistory,
  portErrorDelta24h, portFlapCount24h,
};
