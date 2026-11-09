// Demo rows for the LogicMonitor-derived analytics (Cisco and F5 trend findings, hardware, optics, PoE, routing
// peers, resources, reachability, HA pairs, certificates, pools, GTM). Re-puts instances through the generator's own
// `put` (INSERT OR REPLACE, last write wins) with a `daily` override per metric, so lm_ds_daily carries the stories.
// lm_trend_findings is NOT written here: finalize() runs the real computeTrendFindings over the seeded daily tables.
// Own PRNG, so no earlier draw moves.

const SPAN = 90;

// ---- Daily shape helpers: fn(k) -> { avg, min, max, last } for k days ago (0 = today) --------------------------
const shape = (avg, jit = 0) => ({ avg, min: avg - jit, max: avg + jit, last: avg });
/** cur today, moving `perDay` per day (positive = rising toward today), floored at `floor`. */
const rampTo = (cur, perDay, { jit = 0.2, floor = -Infinity } = {}) => (k) => shape(Math.max(floor, cur - perDay * k), jit);
const flat = (cur, jit = 0) => () => shape(cur, jit);
/** A steady state value with other values on some days (a state change: min and max differ that day). */
const stateDays = (cur, other) => (k) => {
  const o = other[k];
  return o == null ? shape(cur) : { avg: cur, min: Math.min(cur, o), max: Math.max(cur, o), last: cur };
};
/** A counter that grows `perDay` a day and ends at `cur`. */
const counterTo = (cur, perDay) => (k) => { const v = Math.max(0, cur - perDay * k); return { avg: v, min: Math.max(0, v - perDay * 0.9), max: v, last: v }; };
/** Seconds-since-reset counter with resets on the given days ago (a reset happens mid-day). */
function resetting(resetKs, base) {
  return (k) => {
    const rks = resetKs.filter((r) => r >= k);
    if (!rks.length) { const v = base + (SPAN - 1 - k) * 86400; return { avg: v, min: v - 86000, max: v, last: v }; }
    const rk = Math.min(...rks);
    const v = (rk - k) * 86400 + 43200;
    return { avg: v, min: k === rk ? 300 : v - 86000, max: v, last: v };
  };
}
const resetNow = (resetKs, base) => resetting(resetKs, base)(0).last;

function seedAnalytics(devices, { put, rng, ifaces, rngFor }) {
  const r = rngFor ? rngFor('logicmonitor-analytics') : rng;
  const r1 = (v) => Math.round(v * 10) / 10;
  const by = (n) => devices.find((d) => d.name === n);
  const ciscoNet = devices.filter((d) => d.vendor === 'Cisco' && d.isNetwork && d.hostStatus === 'normal'
    && ['core', 'dist', 'access', 'branch-access', 'wan-rtr', 'branch-rtr'].includes(d.kind));

  // ---- Cisco: stack with an open ring and a missing member (phx-acc-01) ----------------------------------------
  const stack = by('phx-acc-01');
  if (stack) {
    put(stack, 'Cisco Switch Stack-', 'Cisco Switch Stack', 'health', '1', { stack_member_state: 4, stack_role: 1 }, null, 'Switch 1', { stack_role: stateDays(1, { 12: 4 }) });
    put(stack, 'Cisco Switch Stack-', 'Cisco Switch Stack', 'health', '2', { stack_member_state: 4, stack_role: 4 }, null, 'Switch 2', { stack_role: stateDays(4, { 12: 1 }) });
    put(stack, 'Cisco Switch Stack-', 'Cisco Switch Stack', 'health', '3', { stack_member_state: 11, stack_role: 3 }, null, 'Switch 3');
    put(stack, 'Cisco Switch Stack Ports-', 'Cisco Switch Stack Ports', 'health', 'Sw1/1', { stack_port_state: 1 }, null, 'Switch 1 Stack Port 1');
    put(stack, 'Cisco Switch Stack Ports-', 'Cisco Switch Stack Ports', 'health', 'Sw1/2', { stack_port_state: 2 }, null, 'Switch 1 Stack Port 2');
    put(stack, 'Cisco Switch Stack Ports-', 'Cisco Switch Stack Ports', 'health', 'Sw2/1', { stack_port_state: 1 }, null, 'Switch 2 Stack Port 1');
  }

  // ---- A hot site: tus-acc-01..03 run hot against the branch switch model; the first one keeps climbing ----------
  ['tus-acc-01', 'tus-acc-02', 'tus-acc-03'].forEach((n, i) => {
    const d = by(n);
    if (d) put(d, 'Cisco_TemperatureSensors', 'Cisco Temperature Sensors', 'health', 'Inlet', { temp_c: 47 + i, temp_state: 1 }, null, 'Inlet temperature',
      { temp_c: i === 0 ? rampTo(47, 0.12, { jit: 0.4 }) : flat(47 + i, 0.4) });
  });

  // ---- Optics: six Rx sensors, two margins under 2 dB, one falling about 0.12 dB a day -----------------------------
  const LOW_WARN = -11.9;
  const margins = [6.2, 5.1, 4.4, 1.4, 0.8, 3.4];
  const optIf = (ifaces || []).filter((x) => x.cls === 'uplink' && ['core', 'dist'].includes(x.device.kind) && x.device.hostStatus === 'normal').slice(0, 6);
  optIf.forEach((f, i) => {
    const cur = LOW_WARN + margins[i];
    put(f.device, 'Cisco_Transceiver_Sensors', 'Cisco Transceiver Sensors', 'optics', `${f.full}-rx`,
      { optic_value: r1(cur * 100) / 100, optic_low_warn: LOW_WARN, optic_high_warn: 1.0, optic_low_alarm: -14.4, optic_state: 1 }, null, `${f.short} Transceiver Rx Power Sensor`,
      { optic_value: i === 5 ? rampTo(cur, -0.12, { jit: 0.05 }) : flat(cur, 0.05), optic_low_warn: flat(LOW_WARN) });
  });

  // ---- PoE: four switches, phx-acc-01 at 88 percent and rising ----------------------------------------------------
  [['phx-acc-01', 88, 0.4], ['phx-acc-02', 42, 0], ['dal-acc-01', 55, 0], ['den-acc-01', 63, 0]].forEach(([n, pct, slope]) => {
    const d = by(n);
    if (!d) return;
    put(d, 'Cisco_PowerOverEthernet', 'Cisco PoE', 'health', 'Switch 1', { poe_used_pct: pct, poe_used_watts: Math.round(pct * 7.4) }, null, 'Switch 1',
      { poe_used_pct: slope ? rampTo(pct, slope, { jit: 0.3 }) : flat(pct, 0.3), poe_used_watts: slope ? rampTo(Math.round(pct * 7.4), slope * 7.4, { jit: 2 }) : flat(Math.round(pct * 7.4), 2) });
  });

  // ---- BGP: phx-wan-rtr-01 peer 1 reset on 5, 3 and 1 days ago ---------------------------------------------------
  const wan = by('phx-wan-rtr-01');
  if (wan) {
    const rk = [5, 3, 1];
    put(wan, 'BGP-', 'BGP', 'routing', '203.0.113.11', { bgp_peer_state: 6, bgp_established_s: resetNow(rk, 86400 * 10), bgp_prefixes_in: 5200 }, null, 'AS6453 peer 1',
      { bgp_established_s: resetting(rk, 86400 * 10) });
  }

  // ---- Memory creep (dal-dist-01), flash filling (phx-dist-02) ------------------------------------------------------
  const creep = by('dal-dist-01');
  if (creep) {
    put(creep, 'Cisco_MemoryPools_SNMP', 'Cisco Memory Pools', 'health', 'Processor', { mem_pct: 76 }, null, null, { mem_pct: rampTo(76, 0.34, { jit: 0.4 }) });
    put(creep, 'SNMP_Host_Uptime', 'SNMP Host Uptime', 'health', 'uptime', { uptime_s: 86400 * 120 }, null, 'Uptime', { uptime_s: resetting([], 86400 * 30) });
  }
  const flash = by('phx-dist-02');
  if (flash) put(flash, 'SNMP_Filesystem_Usage', 'SNMP Filesystem Usage', 'health', 'flash:', { fs_used_pct: 92 }, null, 'flash:', { fs_used_pct: rampTo(92, 0.12, { jit: 0.1 }) });

  // ---- Reboots: den-acc-01 twice in the last 7 days, slc-acc-01 once a month ago ------------------------------------
  [['den-acc-01', [6, 2]], ['slc-acc-01', [40]]].forEach(([n, ks]) => {
    const d = by(n);
    if (d) put(d, 'SNMP_Host_Uptime', 'SNMP Host Uptime', 'health', 'uptime', { uptime_s: resetNow(ks, 86400 * 200) }, null, 'Uptime', { uptime_s: resetting(ks, 86400 * 200) });
  });

  // ---- Ping on every Cisco network device (loss on two), NTP (one unsynced, one offset outlier) ----------------------
  for (const d of ciscoNet) {
    const bad = d.name === 'abq-acc-01' ? [12, 180] : d.name === 'tus-acc-03' ? [4.5, 95] : [0, r1(1 + r() * 9)];
    put(d, 'Ping', 'Ping', 'health', 'ping', { ping_loss_pct: bad[0], ping_rtt_ms: bad[1], ping_rtt_max_ms: r1(bad[1] * 1.6) }, null, 'Ping',
      bad[0] > 0 ? { ping_loss_pct: rampTo(bad[0], 0.05, { jit: 0.2, floor: 0 }), ping_rtt_ms: rampTo(bad[1], 0.4, { jit: 2 }) } : { ping_rtt_ms: flat(bad[1], 0.6) });
    if (['core', 'dist', 'access'].includes(d.kind)) {
      const unsynced = d.name === 'den-acc-02'; const outlier = d.name === 'phx-acc-05';
      put(d, 'Cisco_NTP', 'Cisco NTP', 'health', 'ntp', { ntp_synced: unsynced ? 0 : 1, ntp_stratum: unsynced ? 16 : 3, ntp_offset_ms: outlier ? 240 : r1(r() * 12) }, null, 'NTP');
    }
  }

  // ---- F5 -------------------------------------------------------------------------------------------------------------
  const f5 = (n) => by(n);
  const E1 = f5('phx-edge-01'); const E2 = f5('phx-edge-02');
  if (E1 && E2) {
    // Asymmetric pair: the standby carries 30 percent of the active's connections. edge-01 CPU heads to 80 in about 25 days.
    put(E1, 'F5_BigIP_System', 'F5 BIG-IP System', 'loadbalancer', 'system', { cpu_pct: 62, client_connections: 24000, server_connections: 22000, client_bytes_in: 1.2e8, client_bytes_out: 2.6e8 },
      null, null, { cpu_pct: rampTo(62, 0.72, { jit: 1.2 }), client_connections: flat(24000, 900) });
    put(E2, 'F5_BigIP_System', 'F5 BIG-IP System', 'loadbalancer', 'system', { cpu_pct: 21, client_connections: 7200, server_connections: 6600 },
      null, null, { cpu_pct: flat(21, 1), client_connections: flat(7200, 300) });
    put(E2, 'F5_BigIP_FailoverStatus', 'F5 BIG-IP Failover Status', 'loadbalancer', 'failover', { failover_state: 3, sync_state: 3 }, null, null, { failover_state: stateDays(3, { 33: 4 }) });
    // Swap in use, memory available falling, /var/log filling.
    put(E1, 'F5_BigIP_Memory', 'F5 BIG-IP Memory', 'loadbalancer', 'memory',
      { mem_total_bytes: 3.2e10, mem_avail_bytes: 2.1e9, mem_free_bytes: 9e8, swap_total_bytes: 4e9, swap_avail_bytes: 3.1e9 }, null, null,
      { mem_avail_bytes: rampTo(2.1e9, -1.5e7, { jit: 1e7 }), swap_avail_bytes: rampTo(3.1e9, -8e6, { jit: 1e7 }) });
    put(E1, 'F5_BigIP_Filesystem', 'F5 BIG-IP Filesystem', 'loadbalancer', '/var/log', { fs_used_pct: 85 }, null, null, { fs_used_pct: rampTo(85, 0.1, { jit: 0.1 }) });
    // Pools: a single member carrying traffic, and a pool with one member at 0 beside busy siblings.
    const pm = (key, conn, bits) => put(E1, 'F5_BigIP_PoolMemberStats', 'F5 BIG-IP Pool Member Stats', 'loadbalancer', key,
      { member_avail: 1, member_enabled: 1, member_connections: conn, member_bits_in: bits, member_bits_out: bits * 1.5 });
    pm('api-solo/10.10.90.11:443', 650, 4e7);
    [420, 400, 0, 380].forEach((c, i) => pm(`web-imb/10.10.91.${11 + i}:443`, c, c ? 2.5e7 : 0));
  }
  const L1 = f5('phx-ltm-01');
  if (L1) put(L1, 'F5_BigIP_System', 'F5 BIG-IP System', 'loadbalancer', 'system', { client_connections: 92000 }); // a connection spike against its own hour baseline
  const D2 = f5('dal-f5-02');
  if (D2) put(D2, 'f5_tmm_service_status', 'f5_tmm_service_status', 'loadbalancer', 'tmm', { daemon_exit: 0 }, null, 'tmm', { daemon_exit: stateDays(0, { 2: 1, 9: 2, 10: 1 }) });
  const P2 = f5('phx-f5-02');
  if (P2) put(P2, 'F5_BigIP_FailoverStatus', 'F5 BIG-IP Failover Status', 'loadbalancer', 'failover', { failover_state: 3, sync_state: 3 }, null, null, { failover_state: stateDays(3, { 14: 4, 40: 4 }) });
  const DL1 = f5('dal-ltm-01');
  if (DL1) put(DL1, 'F5_BigIP_FailoverStatus', 'F5 BIG-IP Failover Status', 'loadbalancer', 'failover', { failover_state: 3, sync_state: 3 }, null, null, { failover_state: stateDays(3, { 22: 4 }) });

  // Certificates: expired and expiring ones on both phx units (the duplicates an HA pair always carries).
  [['legacy-a', -5], ['legacy-b', -19], ['old-portal', -2], ['vpn', 8], ['mail', 21], ['sso2', 27]].forEach(([c, days]) => {
    for (const n of ['phx-f5-01', 'phx-f5-02']) {
      const d = f5(n);
      if (d) put(d, 'F5_BigIP_SSL_VIP_Certs', 'F5 BIG-IP SSL VIP Certificates', 'loadbalancer', `${c}.acme-example.com`, { cert_days_left: days });
    }
  });

  // GTM on phx-f5-01: request and resolution counters over 90 days, wide IP and data center availability changes.
  const G = f5('phx-f5-01');
  if (G) {
    put(G, 'F5_GTM_Global', 'F5 GTM Global', 'loadbalancer', 'global', { gtm_requests: 1.3e8, gtm_resolutions: 1.17e8 }, null, null,
      { gtm_requests: counterTo(1.3e8, 1.4e6), gtm_resolutions: counterTo(1.17e8, 1.25e6) });
    [['portal', 6e5], ['pay', 2.4e5], ['api', 4.5e5]].forEach(([w, per]) => {
      const avail = w === 'pay' ? stateDays(1, { 9: 3, 3: 3 }) : flat(1);
      put(G, 'F5_GTM_WideIP-', 'F5 GTM Wide IPs', 'loadbalancer', `${w}.acme-example.com`, { wideip_avail: 1, wideip_requests: per * 80, wideip_resolutions: per * 72 }, null, null,
        { wideip_avail: avail, wideip_requests: counterTo(per * 80, per), wideip_resolutions: counterTo(per * 72, per * 0.9) });
    });
    put(G, 'F5_GTM_Datacenters-', 'F5 GTM Datacenters', 'loadbalancer', 'dallas-dc', { dc_avail: 1 }, null, null, { dc_avail: stateDays(1, { 9: 3, 15: 3 }) });
  }
}

/** Interface forecast story: the first phx-core-01 uplink climbs about 0.7 points a day toward 80 percent. */
function seedAnalyticsInterfaces(db, { sid, ifaces, nowMs }) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lm_interface_daily'").get()) return 0;
  const f = (ifaces || []).find((x) => x.cls === 'uplink' && x.device.name === 'phx-core-01');
  if (!f) return 0;
  const ins = db.prepare(`
    INSERT OR REPLACE INTO lm_interface_daily (source_id, instance_id, day, samples, down_samples, flaps, max_in_util_pct, max_out_util_pct,
      avg_in_util_pct, avg_out_util_pct, errors_sum, discards_sum, in_mbps_avg, out_mbps_avg)
    VALUES (?, ?, ?, 96, 0, 0, ?, ?, ?, ?, 0, 0, ?, ?)
  `);
  let n = 0;
  for (let k = SPAN - 1; k >= 0; k -= 1) {
    const day = new Date(nowMs - k * 86400000).toISOString().slice(0, 10);
    const inU = Math.max(8, 64 - 0.7 * k) + ((k * 7) % 5) * 0.2;
    const outU = Math.max(6, 28 - 0.1 * k);
    ins.run(sid, f.instanceId, day, Math.round(inU * 100) / 100, Math.round(outU * 100) / 100, Math.round(inU * 55) / 100, Math.round(outU * 55) / 100,
      Math.round((inU * f.speed) / 1e8 * 55) / 100, Math.round((outU * f.speed) / 1e8 * 55) / 100);
    n += 1;
  }
  return n;
}

/** Run the real trend engine over the seeded daily tables (after vendor classification, which it reads). */
function finalize(db, { sourceId, nowMs }) {
  const trends = require('../../services/logicmonitorTrends');
  return trends.computeTrendFindings(db, { sourceId, nowMs, thresholds: {} });
}

/** New BIG-IP pairs appended to the device plan: both active, neither active, and the asymmetric edge pair. */
const F5_ANALYTICS_DEVICES = ['phx-ltm-01', 'phx-ltm-02', 'dal-ltm-01', 'dal-ltm-02', 'phx-edge-01', 'phx-edge-02'];
const F5_ANALYTICS_ACTIVE = { 'phx-ltm-01': true, 'phx-ltm-02': true, 'phx-edge-01': true };

module.exports = { seedAnalytics, seedAnalyticsInterfaces, finalize, F5_ANALYTICS_DEVICES, F5_ANALYTICS_ACTIVE };
