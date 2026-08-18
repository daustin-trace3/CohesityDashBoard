// Pure AI Advisor: capacity/performance/alert-triage reports across the
// Pure1 SaaS fleet and/or direct-connect arrays. Ported from
// backend/services/advisors/pureAdvisor.js. The original module eagerly
// required the host's db + services/platformAdvisor at require-time; a
// bundled plugin has neither available until coreApi is handed to it, so
// this exports a FACTORY — createPureAdvisor(coreApi) — built lazily by
// router.js once coreApi is known (dell/nutanix advisor.js pattern). Per the
// plugin contract, coreApi.advisor is the host's services/platformAdvisor
// module (createPlatformAdvisor/linReg/parseUtcMs/fmtBytes), never required
// directly.
function createPureAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = coreApi.advisor;

  // ── capacity: pure1 fleet (SaaS) preferred, falls back to direct-connect ──
  function gatherCapacity() {
    const pure1Arrays = db.prepare('SELECT * FROM pure1_arrays').all();
    if (pure1Arrays.length) {
      const hist = db.prepare(`
        SELECT captured_at, total_capacity_bytes, total_used_bytes
        FROM pure1_metrics_history
        WHERE captured_at >= datetime('now', '-30 days')
        ORDER BY captured_at ASC
      `).all();
      const pts = hist.filter((h) => h.total_used_bytes != null).map((h) => ({ x: parseUtcMs(h.captured_at), y: h.total_used_bytes }));
      const reg = linReg(pts);
      const growthPerDay = reg ? reg.slope * 86400000 : 0;
      const arrays = pure1Arrays.map((a) => ({
        array: a.name,
        model: a.model,
        health: a.health,
        capacity: fmtBytes(a.capacity_bytes),
        used: fmtBytes(a.used_bytes),
        pctUsed: a.capacity_bytes > 0 ? +((a.used_bytes / a.capacity_bytes) * 100).toFixed(1) : null,
        dataReduction: a.data_reduction != null ? +a.data_reduction.toFixed(2) : null,
      })).sort((x, y) => (y.pctUsed ?? -1) - (x.pctUsed ?? -1));
      let fleetUsed = 0;
      let fleetTotal = 0;
      for (const a of pure1Arrays) { fleetUsed += a.used_bytes || 0; fleetTotal += a.capacity_bytes || 0; }
      return {
        generatedAt: new Date().toISOString(),
        source: 'pure1',
        fleet: {
          arrays: pure1Arrays.length,
          usedPct: fleetTotal > 0 ? +((fleetUsed / fleetTotal) * 100).toFixed(1) : null,
          used: fmtBytes(fleetUsed),
          total: fmtBytes(fleetTotal),
          growthPerDay: growthPerDay > 0 ? `${fmtBytes(growthPerDay)}/day` : 'flat/declining',
          dataPoints: hist.length,
        },
        arrays,
      };
    }

    const arrays = db.prepare('SELECT id, name FROM pure_arrays').all();
    const history = db.prepare(`
      SELECT array_id, captured_at, capacity_bytes, used_bytes, data_reduction
      FROM pure_metrics_history
      WHERE captured_at >= datetime('now', '-30 days')
      ORDER BY array_id, captured_at ASC
    `).all();
    const byArray = new Map();
    for (const r of history) {
      if (!byArray.has(r.array_id)) byArray.set(r.array_id, []);
      byArray.get(r.array_id).push(r);
    }
    let fleetUsed = 0;
    let fleetTotal = 0;
    const out = arrays.map((a) => {
      const series = byArray.get(a.id) || [];
      const latest = series[series.length - 1];
      const total = latest?.capacity_bytes || 0;
      const used = latest?.used_bytes || 0;
      if (total > 0) { fleetUsed += used; fleetTotal += total; }
      const pts = series.filter((r) => r.used_bytes != null).map((r) => ({ x: parseUtcMs(r.captured_at), y: r.used_bytes }));
      const reg = linReg(pts);
      const growthPerDay = reg ? reg.slope * 86400000 : 0;
      return {
        array: a.name,
        pctUsed: total > 0 ? +((used / total) * 100).toFixed(1) : null,
        used: fmtBytes(used),
        total: fmtBytes(total),
        growthPerDay: growthPerDay > 0 ? `${fmtBytes(growthPerDay)}/day` : 'flat/declining',
        dataReduction: latest?.data_reduction != null ? +latest.data_reduction.toFixed(2) : null,
        dataPoints: series.length,
      };
    }).sort((x, y) => (y.pctUsed ?? -1) - (x.pctUsed ?? -1));
    return {
      generatedAt: new Date().toISOString(),
      source: 'direct',
      fleet: {
        arrays: arrays.length,
        usedPct: fleetTotal > 0 ? +((fleetUsed / fleetTotal) * 100).toFixed(1) : null,
        used: fmtBytes(fleetUsed),
        total: fmtBytes(fleetTotal),
      },
      arrays: out,
      note: arrays.length === 0 ? 'No Pure arrays registered (direct or Pure1 SaaS).' : undefined,
    };
  }

  // ── performance: latest per-array metrics + volume hotspots ─────────────
  function gatherPerformance() {
    const pure1Perf = db.prepare(`
      SELECT name, read_iops, write_iops, read_latency_us, write_latency_us,
             read_bw_bytes, write_bw_bytes, perf_captured_at
      FROM pure1_arrays
      WHERE read_iops IS NOT NULL OR write_iops IS NOT NULL OR read_latency_us IS NOT NULL
    `).all().map((r) => ({
      array: r.name,
      readIops: r.read_iops != null ? Math.round(r.read_iops) : null,
      writeIops: r.write_iops != null ? Math.round(r.write_iops) : null,
      readLatencyUs: r.read_latency_us != null ? Math.round(r.read_latency_us) : null,
      writeLatencyUs: r.write_latency_us != null ? Math.round(r.write_latency_us) : null,
      readBw: `${fmtBytes(r.read_bw_bytes)}/s`,
      writeBw: `${fmtBytes(r.write_bw_bytes)}/s`,
      capturedAt: r.perf_captured_at,
    }));

    const arrays = db.prepare('SELECT id, name FROM pure_arrays').all();
    if (!arrays.length && pure1Perf.length) {
      return { generatedAt: new Date().toISOString(), arrays: pure1Perf, hotspots: [], note: 'Array-level metrics from Pure1; volume-level hotspot history requires direct array connections.' };
    }
    if (!arrays.length) {
      return { generatedAt: new Date().toISOString(), note: 'No performance data captured yet — Pure1 poll has not run and no direct-connect arrays are registered.', arrays: [], hotspots: [] };
    }
    const latest = db.prepare(`
      SELECT m.array_id, m.captured_at, m.read_iops, m.write_iops, m.read_latency_us, m.write_latency_us, m.read_bw_bytes, m.write_bw_bytes
      FROM pure_metrics_history m
      JOIN (SELECT array_id, MAX(captured_at) mx FROM pure_metrics_history GROUP BY array_id) t
        ON t.array_id = m.array_id AND t.mx = m.captured_at
    `).all();
    const names = new Map(arrays.map((a) => [a.id, a.name]));
    const arrayMetrics = latest.map((m) => ({
      array: names.get(m.array_id) || `Array ${m.array_id}`,
      readIops: m.read_iops != null ? Math.round(m.read_iops) : null,
      writeIops: m.write_iops != null ? Math.round(m.write_iops) : null,
      readLatencyUs: m.read_latency_us != null ? Math.round(m.read_latency_us) : null,
      writeLatencyUs: m.write_latency_us != null ? Math.round(m.write_latency_us) : null,
      readBw: `${fmtBytes(m.read_bw_bytes)}/s`,
      writeBw: `${fmtBytes(m.write_bw_bytes)}/s`,
      capturedAt: m.captured_at,
    }));
    const hotspots = db.prepare(`
      SELECT v.array_id, v.volume_name, v.read_iops, v.write_iops, v.read_latency_us, v.write_latency_us
      FROM pure_volume_history v
      JOIN (SELECT array_id, volume_name, MAX(captured_at) mx FROM pure_volume_history GROUP BY array_id, volume_name) t
        ON t.array_id = v.array_id AND t.volume_name = v.volume_name AND t.mx = v.captured_at
      ORDER BY (COALESCE(v.read_latency_us,0) + COALESCE(v.write_latency_us,0)) DESC
      LIMIT 20
    `).all().map((v) => ({
      array: names.get(v.array_id) || `Array ${v.array_id}`,
      volume: v.volume_name,
      readIops: v.read_iops != null ? Math.round(v.read_iops) : null,
      writeIops: v.write_iops != null ? Math.round(v.write_iops) : null,
      readLatencyUs: v.read_latency_us != null ? Math.round(v.read_latency_us) : null,
      writeLatencyUs: v.write_latency_us != null ? Math.round(v.write_latency_us) : null,
    }));
    // Merge: direct-array metrics win per array name; Pure1 fills the rest.
    const seen = new Set(arrayMetrics.map((a) => a.array));
    const merged = [...arrayMetrics, ...pure1Perf.filter((p) => !seen.has(p.array))];
    return {
      generatedAt: new Date().toISOString(),
      arrays: merged,
      hotspots,
      note: merged.length === 0 ? 'No performance metrics captured yet for these arrays.' : undefined,
    };
  }

  // ── alert_triage: open alerts across pure1 (SaaS) + direct arrays ───────
  function gatherAlertTriage() {
    const pure1Open = db.prepare(`
      SELECT severity, category, component_type, summary, array_name, COUNT(*) count
      FROM pure1_alerts WHERE state != 'closed'
      GROUP BY severity, category, component_type, summary, array_name
      ORDER BY count DESC LIMIT 20
    `).all();
    const pure1Totals = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical, SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
      FROM pure1_alerts WHERE state != 'closed'
    `).get();
    const directOpen = db.prepare(`
      SELECT a.severity, a.category, a.component_type, a.summary, ar.name AS array_name, COUNT(*) count
      FROM pure_alerts a JOIN pure_arrays ar ON ar.id = a.array_id
      WHERE a.state != 'closed'
      GROUP BY a.severity, a.category, a.component_type, a.summary, ar.name
      ORDER BY count DESC LIMIT 20
    `).all();
    const directTotals = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical, SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
      FROM pure_alerts WHERE state != 'closed'
    `).get();
    return {
      generatedAt: new Date().toISOString(),
      pure1: {
        active: { total: pure1Totals.total || 0, critical: pure1Totals.critical || 0, warning: pure1Totals.warning || 0 },
        topAlerts: pure1Open,
      },
      direct: {
        active: { total: directTotals.total || 0, critical: directTotals.critical || 0, warning: directTotals.warning || 0 },
        topAlerts: directOpen,
      },
    };
  }

  return createPlatformAdvisor({
    platform: 'pure',
    feature: 'Pure AI Advisor',
    table: 'pure_ai_reports',
    reports: {
      capacity: {
        system:
          'You are a senior SAN/storage engineer for a Pure Storage fleet (Pure1 SaaS and/or directly connected FlashArrays). ' +
          'You are given fleet totals and per-array capacity: usage %, used/total, data-reduction ratio, and modeled daily ' +
          'growth where history exists. Produce a capacity plan: identify arrays needing expansion soonest, flag anomalous ' +
          'growth, and suggest reclamation or rebalancing actions. Do not invent data; if growth history is thin, say so. ' +
          'Markdown sections: **Fleet summary**, **Needs attention (soonest first)**, **Recommended actions**. ' +
          'Keep under ~400 words.',
        gather: gatherCapacity,
        noun: 'capacity plan',
      },
      performance: {
        system:
          'You are a senior SAN/storage performance engineer for a Pure Storage fleet. You are given the latest per-array ' +
          'IOPS/latency/bandwidth snapshot (from Pure1 fleet metrics and/or direct array connections) and the top ' +
          'volume-level latency hotspots (volume detail requires direct connections — say so if absent). Identify arrays or ' +
          'volumes with elevated latency or saturated IOPS, and suggest likely causes and remediation. Do not invent data. ' +
          'Markdown sections: **Summary**, **Hotspots**, **Recommended actions**. Keep under ~350 words.',
        gather: gatherPerformance,
        noun: 'performance review',
      },
      alert_triage: {
        system:
          'You are an operations lead triaging active alerts across a Pure Storage fleet (Pure1 SaaS and/or directly ' +
          'connected arrays). You are given active alert totals by severity for each source and the noisiest alert types ' +
          'grouped by array. Separate signal from noise and give a prioritized triage plan. Do not invent data. ' +
          'Markdown sections: **Summary**, **Systemic patterns**, **Recommended triage order**. Keep under ~350 words.',
        gather: gatherAlertTriage,
        noun: 'alert triage report',
      },
    },
  });
}

module.exports = { createPureAdvisor };
