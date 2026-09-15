// UniFi AI Advisor: network health/client experience/WAN reliability/security
// posture reports. Ported from backend/services/advisors/unifiAdvisor.js. The
// original module eagerly required the host's db + services/platformAdvisor
// at require-time; a bundled plugin has neither available until coreApi is
// handed to it, so this exports a FACTORY — createUnifiAdvisor(coreApi) —
// built lazily by router.js once coreApi is known (Dell pack advisor.js
// pattern). Per the plugin contract, coreApi.advisor is the host's
// services/platformAdvisor module (createPlatformAdvisor), never required
// directly.
function createUnifiAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor } = coreApi.advisor;
  const {
    computeIssues, deviceCpuWarnPct, deviceMemWarnPct, tempWarnC,
    wanLatencyWarnMs, wanAvailWarnPct,
  } = require('./issues');

  function maxDeviceTemp(temps_json) {
    if (!temps_json) return null;
    try {
      const temps = JSON.parse(temps_json) || [];
      let max = null;
      for (const t of temps) {
        if (typeof t?.value === 'number') max = max == null ? t.value : Math.max(max, t.value);
      }
      return max;
    } catch { return null; }
  }

  function gatherNetworkHealth() {
    const sources = db.prepare('SELECT id, name FROM unifi_sources').all();
    const srcName = new Map(sources.map((s) => [s.id, s.name]));

    const deviceCountsByType = db.prepare(`
      SELECT type, COUNT(*) total, SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) online
      FROM unifi_devices GROUP BY type
    `).all();
    const deviceCountsByModel = db.prepare(`
      SELECT model, COUNT(*) total, SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) online
      FROM unifi_devices WHERE model IS NOT NULL AND model != ''
      GROUP BY model ORDER BY total DESC LIMIT 20
    `).all();

    const offlineDevices = db.prepare(`
      SELECT source_id, name, mac, model, type, ip FROM unifi_devices
      WHERE state != 1 ORDER BY name LIMIT 30
    `).all().map((d) => ({
      source: srcName.get(d.source_id) || `source ${d.source_id}`,
      device: d.name || d.mac, model: d.model, type: d.type, ip: d.ip,
    }));

    const onlineRows = db.prepare(`
      SELECT source_id, name, mac, model, cpu_pct, mem_pct, temps_json
      FROM unifi_devices WHERE state = 1
    `).all().map((d) => ({ ...d, maxTempC: maxDeviceTemp(d.temps_json) }));

    const label = (d) => ({ source: srcName.get(d.source_id) || `source ${d.source_id}`, device: d.name || d.mac, model: d.model });

    const topCpu = onlineRows.filter((d) => d.cpu_pct != null).sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 15)
      .map((d) => ({ ...label(d), cpuPct: d.cpu_pct }));
    const topMem = onlineRows.filter((d) => d.mem_pct != null).sort((a, b) => b.mem_pct - a.mem_pct).slice(0, 15)
      .map((d) => ({ ...label(d), memPct: d.mem_pct }));
    const topTemperature = onlineRows.filter((d) => d.maxTempC != null).sort((a, b) => b.maxTempC - a.maxTempC).slice(0, 15)
      .map((d) => ({ ...label(d), maxTempC: d.maxTempC }));

    const firmwareUpgradesAvailable = db.prepare(`
      SELECT source_id, name, mac, model, version FROM unifi_devices
      WHERE upgradable = 1 ORDER BY name LIMIT 30
    `).all().map((d) => ({ ...label(d), version: d.version }));

    const issues = computeIssues(coreApi);
    const bySeverity = { critical: 0, warning: 0, info: 0 };
    const byType = {};
    for (const i of issues) {
      bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
    }

    return {
      generatedAt: new Date().toISOString(),
      deviceCountsByType,
      deviceCountsByModel,
      offlineDevices,
      topCpu,
      topMem,
      topTemperature,
      firmwareUpgradesAvailable,
      issuesSummary: {
        bySeverity, byType,
        topMessages: issues.slice(0, 20).map((i) => ({ severity: i.severity, type: i.type, source: i.source, target: i.target, message: i.message })),
      },
      thresholds: { deviceCpuWarnPct: deviceCpuWarnPct(coreApi), deviceMemWarnPct: deviceMemWarnPct(coreApi), tempWarnC: tempWarnC(coreApi) },
      note: sources.length === 0 ? 'No UniFi sources registered.' : undefined,
    };
  }

  function gatherClientExperience() {
    const counts = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN is_wired = 1 THEN 1 ELSE 0 END) wired,
        SUM(CASE WHEN is_wired = 0 THEN 1 ELSE 0 END) wireless, SUM(CASE WHEN is_guest = 1 THEN 1 ELSE 0 END) guest
      FROM unifi_clients
    `).get();

    const clientsByEssid = db.prepare(`
      SELECT essid, COUNT(*) total FROM unifi_clients
      WHERE is_wired = 0 AND essid IS NOT NULL AND essid != ''
      GROUP BY essid ORDER BY total DESC LIMIT 20
    `).all();

    const signalRows = db.prepare('SELECT signal FROM unifi_clients WHERE is_wired = 0 AND signal IS NOT NULL').all();
    const signalBuckets = { excellent: 0, good: 0, fair: 0, poor: 0 };
    for (const r of signalRows) {
      const s = r.signal;
      if (s >= -60) signalBuckets.excellent += 1;
      else if (s >= -70) signalBuckets.good += 1;
      else if (s >= -80) signalBuckets.fair += 1;
      else signalBuckets.poor += 1;
    }

    const deviceNames = new Map(
      db.prepare('SELECT source_id, mac, name FROM unifi_devices').all().map((d) => [`${d.source_id}|${d.mac}`, d.name])
    );
    const weakestWirelessClients = db.prepare(`
      SELECT source_id, name, hostname, essid, signal, ap_mac FROM unifi_clients
      WHERE is_wired = 0 AND signal IS NOT NULL ORDER BY signal ASC LIMIT 20
    `).all().map((c) => ({
      client: c.name || c.hostname || 'unknown',
      essid: c.essid,
      signal: c.signal,
      accessPoint: deviceNames.get(`${c.source_id}|${c.ap_mac}`) || c.ap_mac || null,
    }));

    const wlans = db.prepare('SELECT name, enabled, security, wpa_mode, is_guest FROM unifi_wlans ORDER BY name').all()
      .map((w) => ({ name: w.name, enabled: !!w.enabled, security: w.security, wpaMode: w.wpa_mode, guest: !!w.is_guest }));

    return {
      generatedAt: new Date().toISOString(),
      clientCounts: { total: counts.total || 0, wired: counts.wired || 0, wireless: counts.wireless || 0, guest: counts.guest || 0 },
      clientsByEssid,
      signalBuckets,
      weakestWirelessClients,
      wlans,
      note: (counts.total || 0) === 0 ? 'No UniFi clients observed yet.' : undefined,
    };
  }

  function gatherWanReliability() {
    const sources = db.prepare('SELECT id, name FROM unifi_sources').all();
    const srcName = new Map(sources.map((s) => [s.id, s.name]));

    const wan = db.prepare(`
      SELECT source_id, wan_name, isp_name, latency_ms, availability_pct, xput_down, xput_up FROM unifi_wan
    `).all().map((w) => ({
      source: srcName.get(w.source_id) || `source ${w.source_id}`,
      wanName: w.wan_name, ispName: w.isp_name, latencyMs: w.latency_ms, availabilityPct: w.availability_pct,
      xputDownMbps: w.xput_down, xputUpMbps: w.xput_up,
    }));

    const dailyTrend14d = db.prepare(`
      SELECT date(captured_at) AS day, AVG(wan_latency_ms) AS avgLatencyMs, AVG(devices_online) AS avgDevicesOnline,
        AVG(devices_total) AS avgDevicesTotal, AVG(gw_cpu_pct) AS avgGwCpuPct, MAX(max_temp_c) AS maxTempC
      FROM unifi_metrics_history WHERE captured_at >= datetime('now', '-14 days')
      GROUP BY date(captured_at) ORDER BY day ASC
    `).all();

    const activeWanIssues = computeIssues(coreApi).filter((i) => i.type === 'wan-latency' || i.type === 'wan-availability');

    const wanIssueHistory14d = db.prepare(`
      SELECT source, severity, type, target, message, first_seen, last_seen FROM unifi_issue_history
      WHERE (type = 'wan-latency' OR type = 'wan-availability') AND last_seen >= datetime('now', '-14 days')
      ORDER BY last_seen DESC LIMIT 20
    `).all();

    return {
      generatedAt: new Date().toISOString(),
      wan,
      dailyTrend14d,
      activeWanIssues,
      wanIssueHistory14d,
      thresholds: { wanLatencyWarnMs: wanLatencyWarnMs(coreApi), wanAvailWarnPct: wanAvailWarnPct(coreApi) },
      note: wan.length === 0 ? 'No UniFi WAN data collected yet.' : undefined,
    };
  }

  function gatherSecurityPosture() {
    const sources = db.prepare('SELECT id, name FROM unifi_sources').all();
    const srcName = new Map(sources.map((s) => [s.id, s.name]));

    const rogueApsLast7d = db.prepare(`
      SELECT source_id, essid, bssid, channel, signal, security, first_seen_at FROM unifi_rogue_aps
      WHERE is_rogue = 1 AND (first_seen_at IS NULL OR first_seen_at >= datetime('now', '-7 days'))
      ORDER BY first_seen_at DESC LIMIT 30
    `).all().map((r) => ({
      source: srcName.get(r.source_id) || `source ${r.source_id}`,
      essid: r.essid, bssid: r.bssid, channel: r.channel, signal: r.signal, security: r.security, firstSeenAt: r.first_seen_at,
    }));

    const weakSecurityWlans = db.prepare(`
      SELECT name, security, wpa_mode, is_guest FROM unifi_wlans
      WHERE enabled = 1 AND (
        security IS NULL OR security = 'open' OR UPPER(security) LIKE '%WEP%'
        OR (UPPER(security) LIKE '%WPA%' AND UPPER(security) NOT LIKE '%WPA2%' AND UPPER(security) NOT LIKE '%WPA3%')
        OR is_guest = 1
      )
    `).all().map((w) => ({ name: w.name, security: w.security, wpaMode: w.wpa_mode, guest: !!w.is_guest }));

    const securityIssues = computeIssues(coreApi).filter((i) => ['ips-disabled', 'camera-offline', 'protect-breach', 'rogue-ap'].includes(i.type));

    const portErrorFlapIssues7d = db.prepare(`
      SELECT source, severity, type, target, message, first_seen, last_seen FROM unifi_issue_history
      WHERE (type = 'port-errors' OR type = 'port-flapping') AND last_seen >= datetime('now', '-7 days')
      ORDER BY last_seen DESC LIMIT 20
    `).all();

    return {
      generatedAt: new Date().toISOString(),
      rogueApsLast7d,
      weakSecurityWlans,
      securityIssues,
      portErrorFlapIssues7d,
      note: sources.length === 0 ? 'No UniFi sources registered.' : undefined,
    };
  }

  const REPORTS = {
    network_health: {
      system:
        'You are a network operations engineer monitoring a Ubiquiti UniFi estate (gateways, switches, access points) ' +
        'for an enterprise infrastructure team. You are given device counts by type and model, offline devices, the ' +
        'devices under the highest CPU/memory/temperature load, devices with a firmware upgrade available, and a ' +
        'summary of computed issues by severity with the top messages. Identify which devices need attention soonest ' +
        'and why. Do not invent data. Markdown sections: **Summary**, **Findings (severity-ordered)**, ' +
        '**Recommended actions**, **Data gaps**. Keep under ~400 words.',
      gather: gatherNetworkHealth,
      noun: 'network health report',
    },
    client_experience: {
      system:
        'You are a wireless network engineer reviewing client experience on a Ubiquiti UniFi estate for an enterprise ' +
        'infrastructure team. You are given wired/wireless/guest client counts, clients per SSID, a signal-strength ' +
        'distribution, the 20 weakest wireless clients, and WLAN configuration (enabled, security, WPA mode). Identify ' +
        'coverage or interference problems and clients at risk of a poor experience. Do not invent data. Markdown ' +
        'sections: **Summary**, **Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. Keep under ' +
        '~400 words.',
      gather: gatherClientExperience,
      noun: 'client experience report',
    },
    wan_reliability: {
      system:
        'You are a network reliability engineer reviewing WAN/ISP performance on a Ubiquiti UniFi estate for an ' +
        'enterprise infrastructure team. You are given current WAN circuit stats (latency, availability, throughput), ' +
        'a 14-day daily trend of latency, devices online, gateway CPU, and temperature, plus recent WAN-related issue ' +
        'history. Assess reliability trends and flag any circuit at risk. Do not invent data. Markdown sections: ' +
        '**Summary**, **Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. Keep under ~350 words.',
      gather: gatherWanReliability,
      noun: 'WAN reliability report',
    },
    security_posture: {
      system:
        'You are a network security engineer reviewing the security posture of a Ubiquiti UniFi estate for an ' +
        'enterprise infrastructure team. You are given rogue access points first seen in the last 7 days, WLANs with ' +
        'weak or open security, IPS/Protect-related issues, and recent port error/flap issue history. Identify the ' +
        'highest-priority security exposures. Do not invent data. Markdown sections: **Summary**, ' +
        '**Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. Keep under ~350 words.',
      gather: gatherSecurityPosture,
      noun: 'security posture report',
    },
  };

  const advisor = createPlatformAdvisor({
    platform: 'unifi',
    feature: 'UniFi AI Advisor',
    table: 'unifi_ai_reports',
    reports: REPORTS,
  });
  // Exposed for rehearsal/testing so gather() can be exercised without an LLM call.
  advisor.reports = REPORTS;
  return advisor;
}

module.exports = { createUnifiAdvisor };
