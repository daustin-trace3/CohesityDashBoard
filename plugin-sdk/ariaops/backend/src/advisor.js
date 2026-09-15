// Aria Operations AI Advisor: resource-health/alert-triage/capacity-pressure
// reports. Ported from backend/services/advisors/ariaopsAdvisor.js. The
// original module eagerly required the host's db + services/platformAdvisor
// at require-time; a bundled plugin has neither available until coreApi is
// handed to it, so this exports a FACTORY — createAriaopsAdvisor(coreApi) —
// built lazily by router.js once coreApi is known (dell advisor.js pattern).
// Per the plugin contract, coreApi.advisor is the host's services/
// platformAdvisor module (createPlatformAdvisor/linReg/parseUtcMs/fmtBytes),
// never required directly.
function createAriaopsAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor } = coreApi.advisor;

  function instanceNames() {
    const instances = db.prepare('SELECT id, name, last_poll_status, last_poll_at FROM ariaops_instances').all();
    return { instances, names: new Map(instances.map((i) => [i.id, i.name])) };
  }

  function gatherResourceHealth() {
    const { instances, names } = instanceNames();

    const byKindHealth = db.prepare(`
      SELECT kind, health, COUNT(*) count FROM ariaops_resources
      GROUP BY kind, health ORDER BY kind, health
    `).all();

    const topUnhealthy = db.prepare(`
      SELECT r.instance_id, r.name, r.kind, r.health, r.cpu_pct, r.mem_pct
      FROM ariaops_resources r WHERE r.health IN ('RED', 'ORANGE')
      ORDER BY (r.health = 'RED') DESC, r.cpu_pct DESC LIMIT 30
    `).all().map((r) => ({
      instance: names.get(r.instance_id) || `Instance ${r.instance_id}`,
      resource: r.name, kind: r.kind, health: r.health, cpuPct: r.cpu_pct, memPct: r.mem_pct,
    }));

    const perInstanceTotals = instances.map((i) => {
      const totals = db.prepare(`
        SELECT COUNT(*) total,
          SUM(CASE WHEN health = 'RED' THEN 1 ELSE 0 END) red,
          SUM(CASE WHEN health = 'ORANGE' THEN 1 ELSE 0 END) orange,
          SUM(CASE WHEN health = 'YELLOW' THEN 1 ELSE 0 END) yellow
        FROM ariaops_resources WHERE instance_id = ?
      `).get(i.id);
      return {
        instance: i.name, total: totals.total || 0, red: totals.red || 0,
        orange: totals.orange || 0, yellow: totals.yellow || 0,
        lastPollStatus: i.last_poll_status, lastPollAt: i.last_poll_at,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      countsByKindAndHealth: byKindHealth,
      topUnhealthyResources: topUnhealthy,
      perInstanceTotals,
      note: instances.length === 0 ? 'No Aria Operations instances registered.' : undefined,
    };
  }

  function gatherAlertTriage() {
    const { instances, names } = instanceNames();

    const byLevel = db.prepare(`
      SELECT level, COUNT(*) count FROM ariaops_alerts
      WHERE LOWER(status) IN ('active', 'new') GROUP BY level
    `).all();

    const topDefinitions = db.prepare(`
      SELECT definition_name, COUNT(*) count, MIN(resource_name) example_resource
      FROM ariaops_alerts WHERE LOWER(status) IN ('active', 'new') AND definition_name IS NOT NULL
      GROUP BY definition_name ORDER BY count DESC LIMIT 20
    `).all().map((r) => ({
      definitionName: r.definition_name, count: r.count, exampleResource: r.example_resource,
    }));

    const oldestCritical = db.prepare(`
      SELECT instance_id, resource_name, definition_name, level, started_at_ms
      FROM ariaops_alerts
      WHERE LOWER(status) IN ('active', 'new') AND level IN ('CRITICAL', 'IMMEDIATE') AND started_at_ms IS NOT NULL
      ORDER BY started_at_ms ASC LIMIT 10
    `).all().map((r) => ({
      instance: names.get(r.instance_id) || `Instance ${r.instance_id}`,
      resource: r.resource_name, definitionName: r.definition_name, level: r.level,
      ageHours: Math.round((Date.now() - r.started_at_ms) / 3600000),
    }));

    const perInstanceCounts = instances.map((i) => {
      const c = db.prepare(`
        SELECT COUNT(*) total,
          SUM(CASE WHEN level = 'CRITICAL' THEN 1 ELSE 0 END) critical,
          SUM(CASE WHEN level = 'IMMEDIATE' THEN 1 ELSE 0 END) immediate,
          SUM(CASE WHEN level = 'WARNING' THEN 1 ELSE 0 END) warning
        FROM ariaops_alerts WHERE instance_id = ? AND LOWER(status) IN ('active', 'new')
      `).get(i.id);
      return {
        instance: i.name, total: c.total || 0, critical: c.critical || 0,
        immediate: c.immediate || 0, warning: c.warning || 0,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      openAlertsByLevel: byLevel,
      topDefinitions,
      oldestOpenCriticalOrImmediate: oldestCritical,
      perInstanceCounts,
      note: instances.length === 0 ? 'No Aria Operations instances registered.' : undefined,
    };
  }

  function gatherCapacityPressure() {
    const { instances, names } = instanceNames();

    const topByField = (field) => db.prepare(`
      SELECT instance_id, name, kind, health, ${field} AS value FROM ariaops_resources
      WHERE ${field} IS NOT NULL ORDER BY ${field} DESC LIMIT 20
    `).all().map((r) => ({
      instance: names.get(r.instance_id) || `Instance ${r.instance_id}`,
      resource: r.name, kind: r.kind, health: r.health, value: r.value,
    }));

    const dailyTrend = db.prepare(`
      SELECT date(captured_at) day,
        SUM(resources_red) resourcesRed, SUM(alerts_critical) alertsCritical, SUM(vms_total) vmsTotal
      FROM ariaops_metrics_history
      WHERE captured_at >= datetime('now', '-14 days')
      GROUP BY date(captured_at) ORDER BY day
    `).all();

    const latestPerInstance = instances.map((i) => {
      const latest = db.prepare(`
        SELECT resources_total, vms_total FROM ariaops_metrics_history
        WHERE instance_id = ? ORDER BY captured_at DESC LIMIT 1
      `).get(i.id);
      return {
        instance: i.name,
        resourcesTotal: latest?.resources_total ?? null,
        vmsTotal: latest?.vms_total ?? null,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      topByCpuPct: topByField('cpu_pct'),
      topByMemPct: topByField('mem_pct'),
      dailyTrend14d: dailyTrend,
      latestPerInstance,
      note: instances.length === 0 ? 'No Aria Operations instances registered.' : undefined,
    };
  }

  return createPlatformAdvisor({
    platform: 'ariaops',
    feature: 'Aria Operations AI Advisor',
    table: 'ariaops_ai_reports',
    reports: {
      resource_health: {
        system:
          'You are a VMware Aria Operations (vROps) engineer supporting an enterprise infrastructure team. You are ' +
          'given resource counts by kind and health, the worst RED/ORANGE resources with CPU/memory utilization, ' +
          'per-instance totals, and the last poll status per instance. Identify which resources need attention soonest ' +
          'and likely causes. Names are anonymized tokens; keep them as-is. Do not invent data. Markdown sections: ' +
          '**Summary**, **Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. Keep under ~400 words.',
        gather: gatherResourceHealth,
        noun: 'resource health report',
      },
      alert_triage: {
        system:
          'You are an operations lead triaging active Aria Operations alerts for an enterprise infrastructure team. ' +
          'You are given open-alert counts by level, the noisiest alert definitions with an example resource, and the ' +
          'oldest open CRITICAL/IMMEDIATE alerts with age in hours, plus per-instance counts. Separate signal from noise ' +
          'and give a prioritized triage order. Names are anonymized tokens; keep them as-is. Do not invent data. ' +
          'Markdown sections: **Summary**, **Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. ' +
          'Keep under ~400 words.',
        gather: gatherAlertTriage,
        noun: 'alert triage report',
      },
      capacity_pressure: {
        system:
          'You are a capacity planner for an enterprise infrastructure team using Aria Operations data. You are given ' +
          'the top resources by CPU and by memory utilization, a 14-day daily trend of red resources/critical alerts/VM ' +
          'count, and the latest resource and VM totals per instance. Identify capacity risk and where it is heading. ' +
          'Names are anonymized tokens; keep them as-is. Do not invent data. Markdown sections: **Summary**, ' +
          '**Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. Keep under ~400 words.',
        gather: gatherCapacityPressure,
        noun: 'capacity pressure report',
      },
    },
  });
}

module.exports = { createAriaopsAdvisor };
