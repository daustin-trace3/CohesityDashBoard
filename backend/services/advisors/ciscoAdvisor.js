// Cisco AI Advisor presets. The Cisco platform is derived: it has no tables of its own and every gather
// reads the LogicMonitor connector through feeds (coreApi.feeds.query('logicmonitor', <feed>, params)).
// Nothing here touches an lm_* table. The shared engine (coreApi.advisor.createPlatformAdvisor)
// anonymizes the gathered JSON before it leaves the box.
//
// Use: const advisor = createCiscoAdvisor({ feeds: coreApi.feeds, advisor: coreApi.advisor });
// The cache table cisco_ai_reports is created on first use because a derived platform has no migrations.

const REPORT_KEYS = ['cisco_health', 'cisco_switching_hardware', 'cisco_wireless_review', 'cisco_ise_posture',
  'cisco_firewall_review', 'cisco_voice_review', 'cisco_change_review'];
const FEED_CONNECTOR = 'logicmonitor';
const VENDOR_KEYS = ['cisco', 'meraki'];
const DETAIL_CAP = 15;
const HW_RE = /fan|psu|power|supply|line.?card|module|stack|poe|optic|transceiver|sfp|hardware|temperature|temp|sensor|supervisor|chassis/i;

const rowsOf = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const k of keys.concat(['items', 'rows'])) if (Array.isArray(v[k])) return v[k];
  return [];
};
const nameOf = (r) => r.deviceName || r.displayName || r.name || null;
const round1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);
const norm = (s) => (s === 'failed' || s === 'critical' ? 'failed' : s === 'degraded' || s === 'warning' ? 'degraded' : s === 'ok' ? 'ok' : 'unknown');

function createCiscoAdvisor({ feeds, advisor }) {
  const q = (name, params) => feeds.query(FEED_CONNECTOR, name, params || {});
  const hasFeed = (name) => !!(feeds.hasFeed && feeds.hasFeed(FEED_CONNECTOR, name));
  /** Optional family feed: null when the connector lacks it or it fails. */
  const optional = (name, params) => { try { return q(name, { vendorKeys: VENDOR_KEYS, ...(params || {}) }); } catch { return null; } };
  const perKey = (name, params) => VENDOR_KEYS.flatMap((vendorKey) => rowsOf(q(name, { vendorKey, ...(params || {}) }), 'issues'));
  const devices = () => perKey('devices');
  const issues = () => perKey('issues');
  const openAlerts = () => perKey('alerts', { open: true });

  function issuesByType(list) {
    const m = new Map();
    for (const i of list) {
      const k = `${i.type}|${i.severity}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([k, count]) => { const [type, severity] = k.split('|'); return { type, severity, count }; })
      .sort((a, b) => (b.severity === 'critical') - (a.severity === 'critical') || b.count - a.count).slice(0, 30);
  }
  const issueRows = (list) => list.map((i) => ({ target: i.target, type: i.type, severity: i.severity, message: i.message })).slice(0, 40);
  const tally = (list, fn) => list.reduce((m, d) => { const k = fn(d) || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});

  function gatherHealth() {
    const devs = devices();
    const iss = issues();
    const alerts = openAlerts();
    return {
      generatedAt: new Date().toISOString(),
      byKind: tally(devs, (d) => d.vendorKind),
      byFamily: tally(devs, (d) => d.vendorKey),
      byState: tally(devs, (d) => norm(d.state)),
      worstDevices: devs.filter((d) => norm(d.state) !== 'ok').map((d) => ({
        device: nameOf(d), family: d.vendorKey, kind: d.vendorKind || null, state: d.state || 'unknown', reasons: d.reasons || [],
        model: d.model || null, version: d.version || null, openAlerts: d.openAlerts || 0, site: d.siteName || null,
      })).slice(0, 60),
      openIssuesByType: issuesByType(iss),
      openAlertCounts: {
        critical: alerts.filter((a) => a.severityNorm === 'critical').length,
        warning: alerts.filter((a) => a.severityNorm === 'warning').length,
      },
      note: devs.length === 0 ? 'No Cisco or Meraki devices are present in the LogicMonitor inventory.' : undefined,
    };
  }

  function gatherSwitchingHardware() {
    const devs = devices().filter((d) => ['switch', 'nexus', 'router', 'ms'].includes(d.vendorKind));
    const hw = issues().filter((i) => HW_RE.test(`${i.type} ${i.message}`));
    const names = new Set(hw.map((i) => String(i.target || '').toLowerCase().split(' ')[0]));
    const suspects = devs.filter((d) => names.has(String(nameOf(d)).toLowerCase())).slice(0, DETAIL_CAP);
    const metrics = [];
    for (const d of suspects) {
      let m = [];
      try { m = rowsOf(q('metrics', { deviceId: d.id, sourceId: d.sourceId })); } catch { m = []; }
      const interesting = m.filter((x) => HW_RE.test(String(x.metric || x.label || ''))).slice(0, 12);
      if (interesting.length) metrics.push({ device: nameOf(d), metrics: interesting.map((x) => ({ metric: x.metric, value: x.value })) });
    }
    return {
      generatedAt: new Date().toISOString(),
      note: 'Hardware issues are those whose type or message names a fan, power supply, line card, stack member, PoE, optic or temperature sensor. Metric values are the latest polled samples.',
      switchingDevices: devs.length,
      devicesWithHardwareIssues: new Set(hw.map((i) => i.target)).size,
      hardwareIssues: issueRows(hw),
      deviceHardwareMetrics: metrics,
      stateByKind: tally(devs, (d) => `${d.vendorKind}:${norm(d.state)}`),
    };
  }

  function gatherWireless() {
    const ov = optional('wirelessOverview');
    const ctl = rowsOf(optional('wirelessControllers'));
    const rf = optional('wirelessRf');
    if (!ov && !ctl.length) return { generatedAt: new Date().toISOString(), note: 'No Cisco or Meraki wireless data is available.', controllers: [] };
    const a = (ov && ov.analytics) || {};
    return {
      generatedAt: new Date().toISOString(),
      totals: (ov && ov.totals) || null,
      controllers: ctl.map((c) => ({
        controller: c.deviceName, model: c.model, version: c.version, state: c.state, apsTotal: c.apsTotal, apsDown: c.apsDown, clients: c.clients,
        clientUsagePct: round1(c.clientUsagePct), hotRadios: c.hotRadios, radiusUnresponsive: c.radiusUnresponsive, ha: c.haText || null,
      })).slice(0, 40),
      downAps: rowsOf(a.downAps).map((x) => ({ ap: x.ap, controller: x.controller, status: x.status })).slice(0, 40),
      byBand: rowsOf(a.byBand),
      hottestRadios: rowsOf(a.hottestRadios).map((x) => ({ radio: x.radio, ap: x.ap, band: x.band, channelUtilPct: round1(x.channelUtilPct), clients: x.clients })).slice(0, 10),
      rfBands: rowsOf(rf && rf.bands).map((b) => ({ band: b.band, radios: b.radios, down: b.down, hot: b.hot, profileFailures: b.profileFailures })),
    };
  }

  function gatherIse() {
    const nodes = rowsOf(optional('ise'));
    const names = nodes.map((n) => String(n.deviceName || ''));
    return {
      generatedAt: new Date().toISOString(),
      nodes: nodes.map((n) => ({
        node: n.deviceName, state: n.state, sessions: n.sessions ?? null, diskUsedMaxPct: round1(n.diskUsedMaxPct), cpuPct: round1(n.cpuPct), memPct: round1(n.memPct),
        certDaysMin: round1(n.certDaysMin), nodesDown: n.nodesDown ?? null, openIssues: n.openIssues ?? 0,
      })).slice(0, 40),
      iseIssues: issueRows(issues().filter((i) => names.some((n) => n && String(i.target || '').startsWith(n)))),
      note: nodes.length === 0 ? 'No Cisco ISE nodes are present in the LogicMonitor inventory.' : undefined,
    };
  }

  function gatherFirewalls() {
    const fw = rowsOf(optional('firewalls'));
    return {
      generatedAt: new Date().toISOString(),
      firewalls: fw.map((f) => ({
        firewall: f.deviceName, vendor: f.vendor, model: f.model, version: f.version, state: f.state, ha: f.haText || null,
        sessionsUtilPct: round1(f.sessionsUtilPct), cpuPct: round1(f.dataplaneCpuPct ?? f.mgmtCpuPct), memPct: round1(f.memPct),
        tunnelsUp: f.tunnelsUp ?? null, tunnelsDown: f.tunnelsDown ?? null, configSynced: f.configSynced ?? null,
      })).slice(0, 60),
      firewallIssues: issueRows(issues().filter((i) => /fw-|firewall|tunnel|ha-/i.test(`${i.type} ${i.message}`))),
      note: fw.length === 0 ? 'No Cisco ASA or Meraki MX firewalls are present in the LogicMonitor inventory.' : undefined,
    };
  }

  function gatherVoice() {
    const v = rowsOf(optional('voice'));
    return {
      generatedAt: new Date().toISOString(),
      devices: v.map((d) => ({
        device: d.deviceName, kind: d.kind, model: d.model, version: d.version, state: d.state, cpuPct: round1(d.cpuPct), memPct: round1(d.memPct),
        poolUtilMaxPct: round1(d.poolUtilMaxPct), poolFailures: d.poolFailures ?? null, sipServerErrPerSec: d.sipServerErrPerSec ?? null,
        sipClientErrPerSec: d.sipClientErrPerSec ?? null, fansBad: d.fansBad ?? null, psusBad: d.psusBad ?? null, openIssues: d.openIssues ?? 0,
      })).slice(0, 60),
      voiceIssues: issueRows(issues().filter((i) => /voice|sbc|sip|cube/i.test(`${i.type} ${i.message}`))),
      note: v.length === 0 ? 'No Cisco voice devices are present in the LogicMonitor inventory.' : undefined,
    };
  }

  function gatherChangeReview() {
    if (!hasFeed('configChanges')) {
      return {
        generatedAt: new Date().toISOString(),
        note: 'The LogicMonitor connector does not expose a configuration change feed on this ICC build, so no Cisco change history is available.',
        changes: [],
      };
    }
    const changes = [];
    for (const vendorKey of VENDOR_KEYS) {
      try { changes.push(...rowsOf(q('configChanges', { vendorKey, days: 30 }), 'changes')); } catch { /* none for this key */ }
    }
    return {
      generatedAt: new Date().toISOString(),
      windowDays: 30,
      changes: changes.slice(0, 60),
      note: changes.length === 0 ? 'The config ledger holds no Cisco or Meraki device changes in the last 30 days (or the ledger does not cover them yet).' : undefined,
    };
  }

  return advisor.createPlatformAdvisor({
    platform: 'cisco',
    feature: 'Cisco AI Advisor',
    table: 'cisco_ai_reports',
    reports: {
      cisco_health: {
        system:
          'You are a Cisco and Meraki network operations engineer. You are given every non-healthy device with its ICC state and reasons, counts by ' +
          'kind, family (cisco or meraki) and state, open issues by type and open LogicMonitor alert counts. Separate systemic themes (one site, one ' +
          'model, one software version) from isolated devices. Do not invent data. Markdown sections: **Summary**, **Needs attention (worst first)**, ' +
          '**Themes**, **Recommended actions**. Keep under ~400 words.',
        gather: gatherHealth, noun: 'Cisco health review',
      },
      cisco_switching_hardware: {
        system:
          'You are a Cisco switching hardware reviewer (Catalyst, Nexus, Meraki MS). You are given hardware issues (fans, power supplies, line cards, ' +
          'stack members, PoE, optics, temperature) and the latest hardware metric values for the suspect devices. Group by device and by failed ' +
          'component type, and say which items need a part replaced versus which need a look at the optic or cable. Samples are single values, so say ' +
          'when a trend is needed. Do not invent data. Markdown sections: **Summary**, **Hardware faults**, **Likely causes**, **Recommended actions**. ' +
          'Keep under ~350 words.',
        gather: gatherSwitchingHardware, noun: 'Cisco switching hardware review',
      },
      cisco_wireless_review: {
        system:
          'You are a Cisco and Meraki wireless engineer. You are given controllers (WLC, Catalyst 9800), AP totals and down APs, client counts against ' +
          'controller limits, hot radios by band and RF profile failures. Say which controllers carry the problem and whether down APs cluster on one ' +
          'controller or site. Do not invent data. Markdown sections: **Summary**, **Controllers and APs**, **RF and capacity**, **Recommended actions**. ' +
          'Keep under ~350 words.',
        gather: gatherWireless, noun: 'Cisco wireless review',
      },
      cisco_ise_posture: {
        system:
          'You are a Cisco ISE administrator. You are given each ISE node with session counts, disk use, CPU, memory, minimum certificate days left, ' +
          'deployment nodes down and the open ISE issues. Certificate expiry and a deployment node down are the first things to call out; a node near ' +
          'full disk is next. Do not invent data. Markdown sections: **Summary**, **Nodes needing attention**, **Certificates**, **Recommended actions**. ' +
          'Keep under ~300 words.',
        gather: gatherIse, noun: 'Cisco ISE posture review',
      },
      cisco_firewall_review: {
        system:
          'You are a firewall engineer reviewing Cisco ASA and Meraki MX appliances. You are given HA state, session use against the maximum, CPU and ' +
          'memory, VPN tunnels up and down, configuration sync and the open firewall issues. A degraded HA pair or an unsynced configuration comes ' +
          'first, tunnels down next. Do not invent data. Markdown sections: **Summary**, **Needs attention**, **HA and tunnels**, **Recommended actions**. ' +
          'Keep under ~350 words.',
        gather: gatherFirewalls, noun: 'Cisco firewall review',
      },
      cisco_voice_review: {
        system:
          'You are a voice engineer reviewing Cisco CUBE and gateway devices. You are given CPU, memory, session pool use and failures, SIP error rates, ' +
          'failed fans and power supplies and the open voice issues. Pool exhaustion and SIP error bursts are service-affecting; hardware faults are ' +
          'redundancy loss. Do not invent data. Markdown sections: **Summary**, **Service-affecting**, **Redundancy and hardware**, ' +
          '**Recommended actions**. Keep under ~300 words.',
        gather: gatherVoice, noun: 'Cisco voice review',
      },
      cisco_change_review: {
        system:
          'You are a change reviewer for Cisco and Meraki devices. You are given configuration changes recorded in the ICC config ledger over the last ' +
          '30 days. If the data says no change feed or no changes exist, say that plainly and stop. Otherwise group changes by device and day, flag ' +
          'changes that precede an incident, and do not infer intent. Do not invent data. Markdown sections: **Summary**, **Changes by device**, ' +
          '**Recommended actions**. Keep under ~300 words.',
        gather: gatherChangeReview, noun: 'Cisco change review',
      },
    },
  });
}

module.exports = { createCiscoAdvisor, REPORT_KEYS };
