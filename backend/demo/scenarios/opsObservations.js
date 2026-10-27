// Ops Agent observations story for the demo. The rows are real engine output:
// each subject's samples are replayed through agentObservations.ingest with
// capturedAt stepping 15 minutes, so the states, outcomes and series match
// what the live tick would have produced. Subjects (five, picked from the
// vCenter rows the generator already wrote):
//   - a VM with a CPU episode that is critical now (118%, peak 124%, 10 samples)
//   - a VM with a memory episode that is degrading (93%, promoted 30 min ago)
//   - a VM with a CPU episode still watching (2 elevated samples, not promoted)
//   - a VM with four closed one-off CPU bursts in the last 7 days (in pattern)
//   - an ESX host with a memory episode that closed yesterday (sustained, 90 min)
//   - a second VM with five one-off CPU bursts in the last 6 days: its sticky
//     pattern incident is emailed 30 h ago, reminded once, and still waiting
//     on a person; the four-burst VM above has the same kind of incident,
//     acknowledged by "demo" two hours ago with a note
// The matching vcenter_vms / vcenter_hosts usage columns are set so the
// inventory pages agree with the episodes. The demo has no agent tick, so the
// scenario also opens the incidents the tick would have opened (degrading and
// critical episodes, plus the pattern item; the watching episode opens nothing
// and shows only in the Ops Agent watch list) through the agent's
// own grouping code, and gives the critical one a canned triaged analysis built
// from the real evidence gatherer so the demo shows the full incident page.
// Re-runnable: it deletes the observer rows for these four observers and the
// incidents made only of their alerts first.
const STEP_MS = 15 * 60 * 1000;
const PREFERRED = { cpuCritical: 'app-db-01', memDegrading: 'web-02', cpuWatching: 'batch-01', cpuPattern: 'report-01', cpuPatternSticky: 'file-01' };
const OBSERVER_IDS = ['vcenter:vm-cpu', 'vcenter:vm-memory', 'vcenter:host-cpu', 'vcenter:host-memory'];
const SETTINGS = { enabled: true, sustainSamples: 3, clearSamples: 2, patternMin: 3, patternDays: 7, historyDays: 90, disabledIds: [] };

function pickVms(db) {
  const rows = db.prepare(`
    SELECT v.vcenter_id, v.name, v.host_name, v.cluster_name, v.cpu_count, v.memory_mb,
           h.cpu_mhz_capacity, h.cpu_cores, vc.name AS vcenter_name
      FROM vcenter_vms v
      JOIN vcenter_hosts h ON h.vcenter_id = v.vcenter_id AND h.name = v.host_name
      JOIN vcenter_vcenters vc ON vc.id = v.vcenter_id
     WHERE UPPER(v.power_state) = 'POWERED_ON' AND v.cpu_count > 0 AND v.memory_mb > 0
       AND h.cpu_cores > 0 AND h.cpu_mhz_capacity > 0
     ORDER BY v.name, v.vcenter_id`).all();
  const used = new Set();
  const take = (preferred) => {
    let row = rows.find((r) => r.name === preferred && !used.has(r.name));
    if (!row) row = rows.find((r) => !used.has(r.name));
    if (row) used.add(row.name);
    return row;
  };
  return {
    cpuCritical: take(PREFERRED.cpuCritical),
    memDegrading: take(PREFERRED.memDegrading),
    cpuWatching: take(PREFERRED.cpuWatching),
    cpuPattern: take(PREFERRED.cpuPattern),
    cpuPatternSticky: take(PREFERRED.cpuPatternSticky),
  };
}

function pickHost(db) {
  return db.prepare(`
    SELECT h.vcenter_id, h.name, h.cluster_name, h.cpu_cores, h.mem_bytes_capacity, vc.name AS vcenter_name
      FROM vcenter_hosts h JOIN vcenter_vcenters vc ON vc.id = h.vcenter_id
     WHERE LOWER(h.connection_state) = 'connected' AND h.in_maintenance = 0 AND h.mem_bytes_capacity > 0
     ORDER BY (h.name = 'demo-esx-03') DESC, h.name, h.vcenter_id LIMIT 1`).get();
}

// values[i] is the sample at (endMs - (n - 1 - i) * STEP_MS) unless times is given.
function stepped(values, endMs) {
  return values.map((v, i) => ({ value: v, ms: endMs - (values.length - 1 - i) * STEP_MS }));
}

function vmSamples(vm, kind, series) {
  const memory = kind === 'mem';
  return series.map((s) => ({
    subjectKey: `vcenter:${vm.vcenter_id}:vm:${vm.name}`,
    label: vm.name,
    host: vm.name,
    sourceId: vm.vcenter_id,
    sourceName: vm.vcenter_name,
    value: s.value,
    capturedAt: new Date(s.ms).toISOString(),
    context: memory
      ? { cluster: vm.cluster_name, esxHost: vm.host_name, memoryMb: vm.memory_mb, cpuCount: vm.cpu_count }
      : { cluster: vm.cluster_name, esxHost: vm.host_name, cpuCount: vm.cpu_count, memoryMb: vm.memory_mb },
  }));
}

function replay(observer, samples, settings, getSetting, engine) {
  const thresholds = observer.thresholds(getSetting);
  for (const sample of samples) {
    engine.ingest(observer, [sample], sample.capturedAt, settings, thresholds);
  }
}

const isObsKey = (col) => `(${col} LIKE 'obs:vcenter:%' OR ${col} LIKE 'obs-pattern:vcenter:%')`;

/** Remove incidents (and their alert rows) made only of these observers' alerts. */
function clearOldIncidents(db) {
  const ids = db.prepare(`
    SELECT incident_id id FROM ops_incident_alerts GROUP BY incident_id
    HAVING SUM(CASE WHEN ${isObsKey('source_key')} THEN 0 ELSE 1 END) = 0
  `).all().map((r) => r.id);
  // Sticky pattern incidents are keyed pattern:<observer>:<subject>; take them
  // whatever else got attached to them.
  for (const r of db.prepare("SELECT id FROM ops_incidents WHERE incident_key LIKE 'pattern:vcenter:%'").all()) if (!ids.includes(r.id)) ids.push(r.id);
  const delAlerts = db.prepare('DELETE FROM ops_incident_alerts WHERE incident_id = ?');
  const delInc = db.prepare('DELETE FROM ops_incidents WHERE id = ?');
  db.transaction(() => { for (const id of ids) { delAlerts.run(id); delInc.run(id); } })();
  return ids.length;
}

/** The canned triage for the critical VM, tied to the names picked above. */
function cannedAnalysis(vm, ep, engine) {
  const minutes = engine.minutesOf(ep);
  const peak = Math.round(ep.peak_value);
  const now = Math.round(ep.last_value);
  const where = `${vm.name} on ${vm.host_name} (${vm.cluster_name}, ${vm.vcenter_name})`;
  return {
    classification: 'incident',
    confidence: 'high',
    title: `${vm.name}: sustained CPU saturation on ${vm.host_name}`,
    summary: [
      `${vm.name} CPU has been over its critical line for ${minutes} min (now ${now}%, peak ${peak}%).`,
      `The ${vm.cpu_count} vCPU guest is asking for more than it is granted, so the condition held across ${ep.samples} polls and was promoted by the watch.`,
      `No other platform reported a fault for ${vm.name}; this is load, not an outage.`,
    ].join('\n'),
    impact: `${where} is CPU bound. Anything served from it is slower than normal and queue depth can grow while the saturation lasts.`,
    correlation: `The episode started as a watched blip and held for ${ep.elevated_samples} elevated samples, so it is not a one-off. Other VMs on ${vm.host_name} show no matching episode in the history ICC holds.`,
    likely_cause: `A workload on ${vm.name} is using more CPU than its ${vm.cpu_count} vCPU allow (a batch job, a runaway process or a change in demand). The host is not the limit.`,
    reviewed: [
      `Observation, VM CPU ${vm.name}: ${ep.state}, ${now}% now, peak ${peak}%, warn ${ep.threshold_warn}% crit ${ep.threshold_crit}%`,
      `vCenter inventory for ${vm.name} (powered on, ${vm.cpu_count} vCPU) and its ESX host ${vm.host_name}`,
      `History of earlier CPU episodes on ${vm.name}`,
    ],
    next_steps: [
      { owner: 'Virtualization', action: `Check what is driving ${vm.name} (top processes, scheduled jobs started around ${ep.opened_at}) before changing anything.` },
      { owner: 'Application owner', action: `Confirm whether the load on ${vm.name} is expected; if it is, size the VM above ${vm.cpu_count} vCPU.` },
      { owner: 'Virtualization', action: `If the saturation continues, compare ${vm.name} against the ready time on ${vm.host_name} to rule out host contention.` },
    ],
    escalate: `Escalate to the application owner if ${vm.name} stays over ${ep.threshold_crit}% for another hour.`,
    human_required: true,
    human_reason: 'The condition has held past the critical line and needs someone to find what is driving the load; ICC can only observe it.',
    source: 'ai',
  };
}

/** Triage a sticky pattern incident the way a tick would have, from the real
 *  evidence, then set the notified / reminded / acknowledged story on it. */
function storyForPattern(db, agent, vm, { now, notifiedHoursAgo, reminderHoursAgo, reminderCount, ack }) {
  const key = `pattern:vcenter:vm-cpu:vcenter:${vm.vcenter_id}:vm:${vm.name}`;
  const inc = db.prepare('SELECT * FROM ops_incidents WHERE incident_key = ? AND state != ? ORDER BY id DESC LIMIT 1').get(key, 'resolved');
  if (!inc) return null;
  const alerts = db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ? ORDER BY attached_at, rowid').all(inc.id);
  const evidence = agent.gatherIncidentEvidence(inc, alerts);
  const base = agent.fallbackTriage(evidence);
  const analysis = {
    ...base,
    source: 'ai',
    confidence: 'medium',
    impact: `${vm.name} is not down. Each burst is short and clears by itself, so users rarely notice, but the same spike keeps coming back.`,
    correlation: `${evidence.pattern ? evidence.pattern.count : 'Several'} separate bursts fit one cadence rather than one long episode, so no single burst is worth an incident; the repetition is.`,
    likely_cause: `A scheduled job or batch window on ${vm.name} that starts at about the same time and runs for a few polls (a report, an export or a backup agent). ICC cannot see the guest, so this is a hypothesis.`,
  };
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
  const notes = ack ? JSON.stringify([{ at: at(ack.hoursAgo), by: 'demo', kind: 'ack', text: ack.note }]) : null;
  db.prepare(`
    UPDATE ops_incidents SET state = 'notified', triaged_at = ?, classification = 'recurring', confidence = 'medium', title = ?, summary = ?,
      analysis_json = ?, evidence_json = ?, model = 'demo', triage_error = NULL, hold_until = ?,
      notified_at = ?, notify_count = 1, email_to = 'oncall@example.com',
      reminder_at = ?, reminder_count = ?, requires_human = 1,
      acknowledged_at = ?, acknowledged_by = ?, notes_json = ?
    WHERE id = ?
  `).run(at(notifiedHoursAgo), inc.title, analysis.summary, JSON.stringify(analysis), JSON.stringify(evidence), at(notifiedHoursAgo),
    at(notifiedHoursAgo), reminderHoursAgo == null ? null : at(reminderHoursAgo), reminderCount,
    ack ? at(ack.hoursAgo) : null, ack ? 'demo' : null, notes, inc.id);
  return inc.id;
}

/** Open the incidents the agent tick would have opened and triage the critical one. */
function openIncidents(db, { now, vms }) {
  const hasTables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name IN ('ops_incidents', 'ops_incident_alerts')").get().c === 2;
  if (!hasTables) return { applied: false, reason: 'ops incident tables missing' };
  try {
    const agent = require('../../services/opsAgent');
    const engine = require('../../services/agentObservations');
    const removed = clearOldIncidents(db);
    const nowIso = new Date(now).toISOString();
    const r = agent.openObservationIncidents(nowIso, { baseline: false });
    const crit = db.prepare("SELECT * FROM ops_observations WHERE state = 'critical' AND subject_key = ? ORDER BY id DESC LIMIT 1")
      .get(`vcenter:${vms.cpuCritical.vcenter_id}:vm:${vms.cpuCritical.name}`);
    let triaged = null;
    if (crit && crit.incident_id) {
      const inc = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(crit.incident_id);
      const alerts = db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ? ORDER BY attached_at, rowid').all(inc.id);
      const analysis = cannedAnalysis(vms.cpuCritical, crit, engine);
      let evidence;
      try {
        evidence = agent.gatherIncidentEvidence(inc, alerts);
      } catch (err) {
        evidence = { incident: { id: inc.id, key: inc.incident_key, title: analysis.title, host: inc.host, severity: inc.severity }, observations: agent.observationEvidence(alerts) };
      }
      db.prepare(`
        UPDATE ops_incidents SET state = 'triaged', triaged_at = ?, classification = 'incident', confidence = 'high', title = ?, summary = ?,
          analysis_json = ?, evidence_json = ?, model = 'demo', triage_error = NULL, hold_until = ?
        WHERE id = ?
      `).run(nowIso, analysis.title, analysis.summary, JSON.stringify(analysis), JSON.stringify(evidence), nowIso, inc.id);
      triaged = inc.id;
    }
    // The two sticky pattern incidents: one waiting on a person and already
    // reminded, one acknowledged with a note.
    const patternWaiting = storyForPattern(db, agent, vms.cpuPatternSticky, { now, notifiedHoursAgo: 30, reminderHoursAgo: 6, reminderCount: 1, ack: null });
    const patternAcked = storyForPattern(db, agent, vms.cpuPattern, {
      now, notifiedHoursAgo: 52, reminderHoursAgo: 28, reminderCount: 2,
      ack: { hoursAgo: 2, note: `Looking at the nightly job schedule on ${vms.cpuPattern.name}; will report back.` },
    });
    return { applied: true, removed, opened: r.incidentsOpened, triaged, patternWaiting, patternAcked };
  } catch (err) {
    return { applied: false, reason: err.message };
  }
}

function applyOpsObservations(db, { now = Date.now() } = {}) {
  const tableOk = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ops_observations'").get();
  if (!tableOk) return { applied: false, reason: 'ops_observations table missing' };

  // Lazy requires: the engine pulls in the db module and the registry.
  const engine = require('../../services/agentObservations');
  const { getSetting } = require('../../services/settings');
  engine.registerBuiltins();
  const cpu = engine.getObserver('vcenter:vm-cpu');
  const mem = engine.getObserver('vcenter:vm-memory');
  const hostMem = engine.getObserver('vcenter:host-memory');
  if (!cpu || !mem || !hostMem) return { applied: false, reason: 'vcenter observers not registered' };

  const vms = pickVms(db);
  const host = pickHost(db);
  if (!vms.cpuCritical || !vms.memDegrading || !vms.cpuWatching || !vms.cpuPattern || !vms.cpuPatternSticky || !host) {
    return { applied: false, reason: 'not enough powered-on VMs or connected hosts' };
  }

  const ph = OBSERVER_IDS.map(() => '?').join(',');
  db.prepare(`DELETE FROM ops_observations WHERE observer_id IN (${ph})`).run(...OBSERVER_IDS);

  const end = Math.floor(now / STEP_MS) * STEP_MS;

  // 1. CPU critical: elevated, two severe samples promote it, then it stays severe.
  replay(cpu, vmSamples(vms.cpuCritical, 'cpu', stepped([96, 103, 108, 112, 115, 124, 121, 119, 120, 118], end)), SETTINGS, getSetting, engine);

  // 2. Memory degrading: five elevated samples, promoted on the third (30 min ago).
  replay(mem, vmSamples(vms.memDegrading, 'mem', stepped([72, 75, 80, 91, 92, 93, 94, 93], end)), SETTINGS, getSetting, engine);

  // 3. CPU watching: two elevated samples, below the sustain count.
  replay(cpu, vmSamples(vms.cpuWatching, 'cpu', stepped([40, 55, 93, 95], end)), SETTINGS, getSetting, engine);

  // 4. CPU pattern: four short bursts, each two elevated then two normal samples.
  const day = 24 * 60 * 60 * 1000;
  const burst = [];
  for (const daysAgo of [6, 4, 2, 1]) {
    const start = end - daysAgo * day + 2 * 60 * 60 * 1000;
    burst.push(...[92, 95, 40, 35].map((v, i) => ({ value: v, ms: start + i * STEP_MS })));
  }
  replay(cpu, vmSamples(vms.cpuPattern, 'cpu', burst), SETTINGS, getSetting, engine);

  // 4b. Five bursts in the last 6 days on a second VM (a sticky pattern incident).
  const burst5 = [];
  for (const daysAgo of [5.5, 4.2, 3, 1.5, 0.5]) {
    const start = end - Math.round(daysAgo * day) + 2 * 60 * 60 * 1000;
    burst5.push(...[91, 96, 38, 33].map((v, i) => ({ value: v, ms: start + i * STEP_MS })));
  }
  replay(cpu, vmSamples(vms.cpuPatternSticky, 'cpu', burst5), SETTINGS, getSetting, engine);

  // 5. Host memory: elevated for 90 minutes starting 30 h ago, then closed.
  const hostStart = end - 30 * 60 * 60 * 1000;
  const hostSeries = [88, 89, 90, 91, 90, 89, 62, 60].map((v, i) => ({ value: v, ms: hostStart + i * STEP_MS }));
  replay(hostMem, hostSeries.map((s) => ({
    subjectKey: `vcenter:${host.vcenter_id}:host:${host.name}`,
    label: host.name,
    host: host.name,
    sourceId: host.vcenter_id,
    sourceName: host.vcenter_name,
    value: s.value,
    capturedAt: new Date(s.ms).toISOString(),
    context: { cluster: host.cluster_name, cpuCores: host.cpu_cores },
  })), SETTINGS, getSetting, engine);

  // Make the inventory agree with the episodes' latest values.
  const setVmCpu = db.prepare(`UPDATE vcenter_vms SET cpu_usage_mhz = ? WHERE vcenter_id = ? AND name = ?`);
  const setVmMem = db.prepare(`UPDATE vcenter_vms SET mem_usage_mb = ? WHERE vcenter_id = ? AND name = ?`);
  const cpuMhz = (vm, pct) => Math.round((pct / 100) * (vm.cpu_mhz_capacity / vm.cpu_cores) * vm.cpu_count);
  const memMb = (vm, pct) => Math.round((pct / 100) * vm.memory_mb);
  setVmCpu.run(cpuMhz(vms.cpuCritical, 118), vms.cpuCritical.vcenter_id, vms.cpuCritical.name);
  setVmMem.run(memMb(vms.memDegrading, 93), vms.memDegrading.vcenter_id, vms.memDegrading.name);
  setVmCpu.run(cpuMhz(vms.cpuWatching, 95), vms.cpuWatching.vcenter_id, vms.cpuWatching.name);
  setVmCpu.run(cpuMhz(vms.cpuPattern, 35), vms.cpuPattern.vcenter_id, vms.cpuPattern.name);
  setVmCpu.run(cpuMhz(vms.cpuPatternSticky, 33), vms.cpuPatternSticky.vcenter_id, vms.cpuPatternSticky.name);
  db.prepare('UPDATE vcenter_hosts SET mem_bytes_used = ? WHERE vcenter_id = ? AND name = ?')
    .run(Math.round(0.6 * host.mem_bytes_capacity), host.vcenter_id, host.name);

  const incidents = openIncidents(db, { now, vms });

  const counts = db.prepare(`SELECT state, COUNT(*) c FROM ops_observations WHERE observer_id IN (${ph}) GROUP BY state`)
    .all(...OBSERVER_IDS);
  return {
    applied: true,
    incidents,
    subjects: { ...Object.fromEntries(Object.entries(vms).map(([k, v]) => [k, v.name])), hostMemory: host.name },
    byState: Object.fromEntries(counts.map((r) => [r.state, r.c])),
  };
}

module.exports = { applyOpsObservations };
