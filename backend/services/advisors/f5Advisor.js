// F5 AI Advisor presets. The F5 platform is derived: it has no tables of its own and every gather
// reads the LogicMonitor connector through feeds (coreApi.feeds.query('logicmonitor', <feed>, params)).
// Nothing here touches an lm_* table. The shared engine (coreApi.advisor.createPlatformAdvisor)
// anonymizes the gathered JSON before it leaves the box; LM device names are in the anonymizer
// dictionary (lm_devices display_name, name, sysname, hostname), F5 object names (pools, VIPs,
// certificate names) are not.
//
// Use: const advisor = createF5Advisor({ feeds: coreApi.feeds, advisor: coreApi.advisor });
// advisor has the createPlatformAdvisor surface (REPORTS, generateReport, getCachedReport, gatherFor,
// isConfigured, emailRoute). The cache table f5_ai_reports is created on first use because a derived
// platform has no migrations.

const REPORT_KEYS = ['f5_health', 'f5_capacity', 'f5_cert_audit', 'f5_pool_review', 'f5_change_review', 'f5_ha_review', 'f5_forecast'];
const analytics = require('../../platforms/f5/analytics');
const FEED_CONNECTOR = 'logicmonitor';
const DETAIL_CAP = 40;

const rowsOf = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const k of keys.concat(['items', 'rows'])) if (Array.isArray(v[k])) return v[k];
  return [];
};
const nameOf = (r) => r.deviceName || r.displayName || r.name || null;
const round1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);

function createF5Advisor({ feeds, advisor }) {
  const q = (name, params) => feeds.query(FEED_CONNECTOR, name, params || {});
  const hasFeed = (name) => !!(feeds.hasFeed && feeds.hasFeed(FEED_CONNECTOR, name));
  const devices = () => rowsOf(q('devices', { vendorKey: 'f5' }));
  const lbRows = () => rowsOf(q('loadBalancers', { vendorKey: 'f5' }));
  const issues = () => rowsOf(q('issues', { vendorKey: 'f5' }), 'issues');
  const openAlerts = () => rowsOf(q('alerts', { vendorKey: 'f5', open: true }));
  const detail = (row) => {
    try { return q('loadBalancer', { vendorKey: 'f5', deviceId: row.deviceId ?? row.id, sourceId: row.sourceId }); } catch { return null; }
  };

  function issuesByType(list) {
    const m = new Map();
    for (const i of list) {
      const k = `${i.type}|${i.severity}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => { const [type, severity] = k.split('|'); return { type, severity, count }; })
      .sort((a, b) => (b.severity === 'critical') - (a.severity === 'critical') || b.count - a.count).slice(0, 30);
  }

  function gatherHealth() {
    const devs = devices();
    const lbs = lbRows();
    const iss = issues();
    const alerts = openAlerts();
    return {
      generatedAt: new Date().toISOString(),
      devices: devs.map((d) => ({
        device: nameOf(d), kind: d.vendorKind || null, state: d.state || 'unknown', reasons: d.reasons || [], model: d.model || null,
        version: d.version || null, hostStatus: d.hostStatus || null, openAlerts: d.openAlerts || 0, site: d.siteName || null,
      })).slice(0, 60),
      failover: lbs.map((r) => ({
        device: nameOf(r), failover: r.failoverText || null, sync: r.syncState || null, daemonsDown: r.daemonsDown || 0,
        vipsDown: r.vipsDown || 0, wideIpsDown: r.wideIpsDown || 0, poolsDegraded: r.poolsDegraded || 0, state: r.state || null,
      })).slice(0, 60),
      openIssuesByType: issuesByType(iss),
      openAlertCounts: {
        critical: alerts.filter((a) => a.severityNorm === 'critical').length,
        warning: alerts.filter((a) => a.severityNorm === 'warning').length,
      },
      note: devs.length === 0 ? 'No F5 devices are present in the LogicMonitor inventory.' : undefined,
    };
  }

  function gatherCapacity() {
    const lbs = lbRows();
    const rows = lbs.map((r) => ({
      device: nameOf(r), cpuPct: round1(r.cpuPct), memPct: round1(r.memPct), clientConnections: r.clientConnections ?? null,
      serverConnections: r.serverConnections ?? null, pools: r.pools || 0, membersTotal: r.membersTotal || 0, membersDown: r.membersDown || 0,
      vips: r.vips || 0, failover: r.failoverText || null,
    }));
    const byCpu = rows.slice().sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1)).slice(0, 15);
    const byMem = rows.slice().sort((a, b) => (b.memPct ?? -1) - (a.memPct ?? -1)).slice(0, 15);
    const byConn = rows.slice().sort((a, b) => (b.clientConnections ?? -1) - (a.clientConnections ?? -1)).slice(0, 10);
    // Pool member load comes from the 360 detail of the busiest devices only.
    const busiest = lbs.slice().sort((a, b) => (b.clientConnections ?? -1) - (a.clientConnections ?? -1)).slice(0, 5);
    const poolMemberLoad = [];
    for (const r of busiest) {
      const d = detail(r);
      for (const p of rowsOf(d && d.pools)) {
        const members = rowsOf(p.members).map((m) => ({ member: m.member, connections: m.connections ?? null, avail: m.avail || null }))
          .sort((a, b) => (b.connections ?? -1) - (a.connections ?? -1)).slice(0, 5);
        if (members.length) poolMemberLoad.push({ device: nameOf(r), pool: p.pool, membersUp: p.up, membersDown: p.down, busiestMembers: members });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      note: 'CPU, memory and connection figures are the latest polled values. History (24 points) is on the device 360.',
      highestCpu: byCpu, highestMemory: byMem, mostClientConnections: byConn,
      poolMemberLoad: poolMemberLoad.slice(0, 20),
      deviceCount: rows.length,
    };
  }

  function certEntries() {
    const out = [];
    // One query through the certificates feed (deduped). Certificate names are not in the anonymizer
    // dictionary, so they leave as per-device aliases ("certificate 1"); the reply cannot name the real one.
    const c = analytics.buildCertificates(q);
    if (c.available) {
      const seq = new Map();
      for (const x of c.certs) {
        const dev = x.devices[0] || 'unknown';
        const n = (seq.get(dev) || 0) + 1;
        seq.set(dev, n);
        out.push({ device: dev, certificate: `certificate ${n}`, daysLeft: round1(x.daysLeft), copies: x.copies, devices: x.devices.length });
      }
      return out.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
    }
    // Feed not registered: the per-device 360 detail of the first DETAIL_CAP devices (older connectors).
    // Load balancer rows carry no vendorKind; F5OS has no SSL profiles, so skip it through the device list.
    const f5os = new Set(devices().filter((d) => d.vendorKind === 'f5os').map((d) => `${d.sourceId}:${d.id}`));
    for (const r of lbRows().filter((x) => !f5os.has(`${x.sourceId}:${x.deviceId ?? x.id}`)).slice(0, DETAIL_CAP)) {
      const d = detail(r);
      for (const cc of rowsOf(d && d.certs)) out.push({ device: nameOf(r), certificate: cc.name, daysLeft: round1(cc.daysLeft) });
    }
    return out.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
  }

  function gatherCertAudit() {
    const certs = certEntries();
    const bucket = (lo, hi) => certs.filter((c) => c.daysLeft != null && c.daysLeft >= lo && c.daysLeft < hi).length;
    return {
      generatedAt: new Date().toISOString(),
      buckets: {
        expired: certs.filter((c) => c.daysLeft != null && c.daysLeft < 0).length,
        within30Days: bucket(0, 30), within60Days: bucket(30, 60), within90Days: bucket(60, 90), over90Days: certs.filter((c) => c.daysLeft != null && c.daysLeft >= 90).length,
      },
      soonest: certs.slice(0, 40),
      openCertIssues: issues().filter((i) => i.type === 'lb-cert-expiring').map((i) => ({ target: i.target, severity: i.severity, message: i.message })).slice(0, 30),
      certificatesChecked: certs.length,
      note: certs.length === 0 ? 'No certificate data is available (LogicMonitor does not report SSL profile expiry for these devices, or no BIG-IP has been polled).' : undefined,
    };
  }

  // Pools where one member carries all the traffic. Pool names are not in the anonymizer dictionary, so they
  // leave as per-device aliases ("pool 1").
  function spofPools() {
    const p = analytics.buildPools(q);
    if (!p.available) return [];
    const seq = new Map();
    return p.pools.filter((x) => x.spof || x.zeroMembers.length).slice(0, 25).map((x) => {
      const n = (seq.get(x.device) || 0) + 1;
      seq.set(x.device, n);
      return { device: x.device, pool: `pool ${n}`, members: x.memberCount, carryingTraffic: x.memberCount - x.zeroMembers.length, spof: x.spof, idleMembers: x.zeroMembers.length, cv: x.cv };
    });
  }

  function gatherPoolReview() {
    const lbs = lbRows().filter((r) => (r.poolsDegraded || 0) > 0 || (r.membersDown || 0) > 0);
    const degraded = [];
    for (const r of lbs.slice(0, 15)) {
      const d = detail(r);
      for (const p of rowsOf(d && d.pools).filter((x) => x.down > 0)) {
        degraded.push({
          device: nameOf(r), pool: p.pool, membersUp: p.up, membersDown: p.down,
          downMembers: rowsOf(p.members).filter((m) => m.avail && !/^(up|available|green)/i.test(String(m.avail))).map((m) => ({ member: m.member, avail: m.avail })).slice(0, 10),
        });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      devicesWithDegradedPools: lbs.map((r) => ({ device: nameOf(r), poolsDegraded: r.poolsDegraded || 0, membersDown: r.membersDown || 0, membersTotal: r.membersTotal || 0 })).slice(0, 30),
      degradedPools: degraded.slice(0, 40),
      singlePointOfFailure: spofPools(),
      poolIssues: issues().filter((i) => i.type === 'lb-pool-degraded').map((i) => ({ target: i.target, severity: i.severity, message: i.message })).slice(0, 30),
      note: lbs.length === 0 ? 'No F5 pool has a member down right now.' : undefined,
    };
  }

  function gatherChangeReview() {
    if (!hasFeed('configChanges')) {
      return {
        generatedAt: new Date().toISOString(),
        note: 'The LogicMonitor connector does not expose a configuration change feed on this ICC build, so no F5 change history is available.',
        changes: [],
      };
    }
    let changes = [];
    try { changes = rowsOf(q('configChanges', { vendorKey: 'f5', days: 30 }), 'changes'); } catch { changes = []; }
    return {
      generatedAt: new Date().toISOString(),
      windowDays: 30,
      changes: changes.slice(0, 60),
      note: changes.length === 0 ? 'The config ledger holds no F5 device changes in the last 30 days (or the ledger does not cover F5 yet).' : undefined,
    };
  }

  function gatherHaReview() {
    const ha = analytics.buildHa(q);
    return {
      generatedAt: new Date().toISOString(),
      note: ha.available ? 'Pairs are matched by device group or by site plus name stem; headroom is active p95 CPU plus standby baseline CPU against 80 percent.' : 'The HA state feed is not available on this ICC build.',
      summary: ha.summary,
      pairs: ha.pairs.slice(0, 40).map((p) => ({
        units: p.units.filter(Boolean).map((u) => ({ device: u.device, role: u.role, cpuP95: round1(u.cpuP95), clientConnections: u.clientConnections })),
        severity: p.severity, reasons: p.reasons, syncState: p.syncState, daysSinceFailover: p.daysSinceFailover, failovers90d: p.failovers90d,
        headroom: { sum: round1(p.headroom.sum), ok: p.headroom.ok }, standbySharePct: p.standbyShare == null ? null : Math.round(p.standbyShare * 100),
      })),
    };
  }

  function gatherForecast() {
    const t = analytics.buildTrends(q, { days: 30 });
    return {
      generatedAt: new Date().toISOString(),
      note: t.available ? 'Forecasts are linear fits over daily history, labelled with their basis. insufficient data means too few days or a weak fit; do not extrapolate those.' : 'The device resources feed is not available on this ICC build.',
      units: t.devices.slice(0, 40).map((d) => ({
        device: d.device, cpuNow: round1(d.cpu.now), cpuP95: round1(d.cpu.p95), cpuDaysTo80: d.cpu.forecast.days == null ? null : round1(d.cpu.forecast.days), cpuBasis: d.cpu.forecast.basis,
        memP95: round1(d.mem.p95), memoryCreep: d.mem.creep ? d.mem.creep.basis : null,
        filesystems: d.filesystems.slice(0, 5).map((f) => ({ usedPct: round1(f.usedPct), daysTo90: f.forecast.days == null ? null : round1(f.forecast.days), basis: f.forecast.basis })),
      })),
      connectionAnomalies: t.anomalies.slice(0, 20).map((a) => ({ device: a.device, direction: a.direction, severity: a.severity })),
    };
  }

  const engine = advisor.createPlatformAdvisor({
    platform: 'f5',
    feature: 'F5 AI Advisor',
    table: 'f5_ai_reports',
    reports: {
      f5_health: {
        system:
          'You are an F5 BIG-IP operations engineer. You are given each F5 device with its ICC state and reasons, failover state, sync state, ' +
          'daemons down, VIPs and wide IPs down, pools degraded, open issues by type and open LogicMonitor alert counts. A healthy pair has one unit ' +
          'active and one standby. A daemon exit status of 0 means running. Separate systemic themes from isolated devices. Do not invent data. ' +
          'Markdown sections: **Summary**, **Needs attention (worst first)**, **Failover and sync**, **Recommended actions**. Keep under ~400 words.',
        gather: gatherHealth, noun: 'F5 health review',
      },
      f5_capacity: {
        system:
          'You are an F5 capacity planner. You are given the latest CPU, memory and connection counts per device, the busiest devices, and the ' +
          'busiest pool members. Latest values are single samples, so say when a conclusion needs history. Identify devices closest to their limits ' +
          'and pairs where load is uneven. Do not invent data. Markdown sections: **Summary**, **Highest load**, **Pool member load**, ' +
          '**Recommended actions**. Keep under ~350 words.',
        gather: gatherCapacity, noun: 'F5 capacity review',
      },
      f5_cert_audit: {
        system:
          'You are a certificate lifecycle reviewer for F5 SSL profiles. You are given certificates by days left with expired, 30, 60 and 90 day ' +
          'buckets, the soonest to expire and the open certificate issues. Expired certificates first, then the soonest. Group certificates on ' +
          'both units of a pair. Do not invent data. Markdown sections: **Summary**, **Expired and within 30 days**, **Within 90 days**, ' +
          '**Recommended actions**. Keep under ~300 words.',
        gather: gatherCertAudit, noun: 'F5 certificate audit',
      },
      f5_pool_review: {
        system:
          'You are an F5 application delivery engineer. You are given devices with degraded pools, the pools with members down and the open ' +
          'pool issues. A pool with every member down is an outage for its virtual servers; a pool with some members down is reduced capacity. ' +
          'Say which pools share members or devices. Check the member and its monitor before the F5. Do not invent data. Markdown sections: ' +
          '**Summary**, **Pools with members down**, **Likely causes**, **Recommended actions**. Keep under ~350 words.',
        gather: gatherPoolReview, noun: 'F5 pool review',
      },
      f5_change_review: {
        system:
          'You are a change reviewer for F5 devices. You are given configuration changes recorded in the ICC config ledger over the last 30 days. ' +
          'If the data says no change feed or no changes exist, say that plainly and stop. Otherwise group changes by device and day, flag changes ' +
          'that precede an incident, and do not infer intent. Do not invent data. Markdown sections: **Summary**, **Changes by device**, ' +
          '**Recommended actions**. Keep under ~300 words.',
        gather: gatherChangeReview, noun: 'F5 change review',
      },
      f5_ha_review: {
        system:
          'You are an F5 BIG-IP high availability reviewer. You are given HA pairs with unit roles, sync state, days since the last failover, ' +
          'failovers in 90 days, failover headroom (active p95 CPU plus standby baseline CPU against 80 percent) and the standby share of the ' +
          'active unit connections. Both units active or neither active is an outage risk. Say which pairs cannot absorb a failover. Do not ' +
          'invent data. Markdown sections: **Summary**, **Pairs at risk**, **Headroom and asymmetry**, **Recommended actions**. Keep under ~350 words.',
        gather: gatherHaReview, noun: 'F5 HA review',
      },
      f5_forecast: {
        system:
          'You are an F5 capacity planner working from trend forecasts. Each unit has p95 CPU, days until 80 percent CPU with the basis of the ' +
          'fit, memory creep flags, filesystem days to 90 percent and connection anomalies. Treat any forecast marked insufficient data as unknown. ' +
          'Rank units by urgency and state the basis next to every date. Do not invent data. Markdown sections: **Summary**, **Needs capacity soon**, ' +
          '**Memory and disk**, **Recommended actions**. Keep under ~350 words.',
        gather: gatherForecast, noun: 'F5 forecast review',
      },
    },
  });

  return engine;
}

module.exports = { createF5Advisor, REPORT_KEYS };
