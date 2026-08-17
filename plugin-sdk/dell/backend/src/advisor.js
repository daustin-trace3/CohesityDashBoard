// Dell AI Advisor: hardware health/lifecycle-compliance/alert-triage reports.
// Ported from backend/services/advisors/dellAdvisor.js. The original module
// eagerly required the host's db + services/platformAdvisor at require-time;
// a bundled plugin has neither available until coreApi is handed to it, so
// this exports a FACTORY — createDellAdvisor(coreApi) — built lazily by
// router.js once coreApi is known (nutanix advisor.js pattern). Per the
// plugin contract, coreApi.advisor is the host's services/platformAdvisor
// module (createPlatformAdvisor/linReg/parseUtcMs/fmtBytes), never required
// directly.
function createDellAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor, linReg, parseUtcMs } = coreApi.advisor;

  function gatherHardwareHealth() {
    const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
    const names = new Map(instances.map((i) => [i.id, i.name]));

    const devices = db.prepare(`
      SELECT ome_id, name, service_tag, model, health, power_state, inlet_temp_c, cpu_util_pct, mem_util_pct
      FROM dell_devices WHERE health != 'ok' ORDER BY (health = 'critical') DESC LIMIT 30
    `).all().map((d) => ({
      instance: names.get(d.ome_id) || `OME ${d.ome_id}`,
      device: d.name, serviceTag: d.service_tag, model: d.model, health: d.health,
      powerState: d.power_state, inletTempC: d.inlet_temp_c, cpuUtilPct: d.cpu_util_pct, memUtilPct: d.mem_util_pct,
    }));

    const components = db.prepare(`
      SELECT c.ome_id, c.device_id, d.name AS device_name, c.kind, c.name, c.status
      FROM dell_components c LEFT JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
      WHERE c.status NOT IN ('ok') AND c.status IS NOT NULL
      ORDER BY (c.status = 'critical') DESC LIMIT 30
    `).all().map((c) => ({
      instance: names.get(c.ome_id) || `OME ${c.ome_id}`,
      device: c.device_name || `Device ${c.device_id}`,
      kind: c.kind, component: c.name, status: c.status,
    }));

    const history = db.prepare(`
      SELECT ome_id, captured_at, devices_total, devices_ok, devices_warning, devices_critical, power_w_total
      FROM dell_metrics_history WHERE captured_at >= datetime('now', '-30 days') ORDER BY ome_id, captured_at ASC
    `).all();
    const byOme = new Map();
    for (const r of history) {
      if (!byOme.has(r.ome_id)) byOme.set(r.ome_id, []);
      byOme.get(r.ome_id).push(r);
    }
    const trend = instances.map((i) => {
      const series = byOme.get(i.id) || [];
      const latest = series[series.length - 1];
      const pts = series.filter((r) => r.power_w_total != null).map((r) => ({ x: parseUtcMs(r.captured_at), y: r.power_w_total }));
      const reg = linReg(pts);
      return {
        instance: i.name,
        devicesTotal: latest?.devices_total ?? null,
        devicesOk: latest?.devices_ok ?? null,
        devicesWarning: latest?.devices_warning ?? null,
        devicesCritical: latest?.devices_critical ?? null,
        powerTrend: reg && reg.slope > 0 ? 'rising' : reg && reg.slope < 0 ? 'falling' : 'flat',
        dataPoints: series.length,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      unhealthyDevices: devices,
      nonOkComponents: components,
      trend,
      note: instances.length === 0 ? 'No Dell OME instances registered.' : undefined,
    };
  }

  function gatherLifecycleCompliance() {
    const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
    const names = new Map(instances.map((i) => [i.id, i.name]));

    const warranties = db.prepare(`
      SELECT ome_id, service_tag, device_model, end_date, days_remaining FROM dell_warranties
    `).all();
    const buckets = { expired: 0, within30d: 0, within90d: 0, within365d: 0, beyond: 0 };
    const expiringSoon = [];
    for (const w of warranties) {
      const d = w.days_remaining;
      if (d == null) continue;
      if (d < 0) buckets.expired += 1;
      else if (d <= 30) buckets.within30d += 1;
      else if (d <= 90) buckets.within90d += 1;
      else if (d <= 365) buckets.within365d += 1;
      else buckets.beyond += 1;
      if (d <= 90) {
        expiringSoon.push({
          instance: names.get(w.ome_id) || `OME ${w.ome_id}`,
          serviceTag: w.service_tag, model: w.device_model, endDate: w.end_date, daysRemaining: d,
        });
      }
    }
    expiringSoon.sort((a, b) => a.daysRemaining - b.daysRemaining);

    const firmware = db.prepare(`
      SELECT ome_id, baseline_name, service_tag, device_model, noncompliant_components
      FROM dell_firmware_compliance WHERE status = 'noncompliant' ORDER BY noncompliant_components DESC LIMIT 30
    `).all().map((f) => ({
      instance: names.get(f.ome_id) || `OME ${f.ome_id}`,
      baseline: f.baseline_name, serviceTag: f.service_tag, model: f.device_model,
      noncompliantComponents: f.noncompliant_components,
    }));

    return {
      generatedAt: new Date().toISOString(),
      warrantyBuckets: buckets,
      warrantiesExpiringWithin90d: expiringSoon.slice(0, 30),
      firmwareNoncompliant: firmware,
      note: warranties.length === 0 && firmware.length === 0 ? 'No warranty or firmware compliance data collected yet.' : undefined,
    };
  }

  function gatherAlertTriage() {
    const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
    const names = new Map(instances.map((i) => [i.id, i.name]));
    const totals = db.prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical,
             SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
      FROM dell_alerts WHERE status != 'acknowledged'
    `).get();
    const byCategory = db.prepare(`
      SELECT ome_id, category, subcategory, severity, message, COUNT(*) count
      FROM dell_alerts WHERE status != 'acknowledged'
      GROUP BY ome_id, category, subcategory, severity, message
      ORDER BY count DESC LIMIT 20
    `).all().map((r) => ({
      instance: names.get(r.ome_id) || `OME ${r.ome_id}`,
      category: r.category, subcategory: r.subcategory, severity: r.severity, message: r.message, count: r.count,
    }));
    return {
      generatedAt: new Date().toISOString(),
      active: { total: totals.total || 0, critical: totals.critical || 0, warning: totals.warning || 0 },
      byCategory,
      note: (totals.total || 0) === 0 ? 'No unacknowledged Dell alerts.' : undefined,
    };
  }

  return createPlatformAdvisor({
    platform: 'dell',
    feature: 'Dell AI Advisor',
    table: 'dell_ai_reports',
    reports: {
      hardware_health: {
        system:
          'You are a Dell PowerEdge hardware engineer using OpenManage Enterprise data. You are given devices not in ' +
          'healthy state (power/thermal/utilization), non-ok components, and per-instance device-health trend. Identify ' +
          'which devices/components need attention soonest and likely causes (thermal, power, component failure). Do not ' +
          'invent data. Markdown sections: **Summary**, **Needs attention (prioritized)**, **Recommended actions**. ' +
          'Keep under ~400 words.',
        gather: gatherHardwareHealth,
        noun: 'hardware health report',
      },
      lifecycle_compliance: {
        system:
          'You are a Dell hardware lifecycle manager. You are given warranty expiry buckets and the devices expiring ' +
          'within 90 days, plus firmware-compliance baselines with noncompliant device counts. Produce a lifecycle plan: ' +
          'prioritize renewal/replacement by urgency and flag firmware drift needing remediation. Do not invent data. ' +
          'Markdown sections: **Warranty summary**, **Renewals needed (soonest first)**, **Firmware compliance**, ' +
          '**Recommended actions**. Keep under ~400 words.',
        gather: gatherLifecycleCompliance,
        noun: 'lifecycle and compliance report',
      },
      alert_triage: {
        system:
          'You are an operations lead triaging active alerts across a Dell PowerEdge/OME estate. You are given active ' +
          'alert totals by severity and the noisiest alert categories grouped by instance and device. Separate signal ' +
          'from noise and give a prioritized triage plan. Do not invent data. Markdown sections: **Summary**, ' +
          '**Systemic patterns**, **Recommended triage order**. Keep under ~350 words.',
        gather: gatherAlertTriage,
        noun: 'alert triage report',
      },
    },
  });
}

module.exports = { createDellAdvisor };
