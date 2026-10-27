// History slice: a bounded series from the history tables ICC's pollers
// already fill, so the agent can ask "was this rising for hours or a blip?"
// without leaving the box. DB only, no vendor call, so it also runs in the
// public demo. The metric menu is built per target from the tables that
// actually hold rows for it; the model picks from that menu and never writes
// a table or column name.
const L = require('./lib');
const { historyMetricFor } = require('../../agentProfiles/defaults');

const MAX_POINTS = 48;
const DEFAULT_HOURS = 24;
const marks = (a) => a.map(() => '?').join(',');
const SHORT = "lower(substr(name, 1, instr(name || '.', '.') - 1))";
const pct = (n, d) => (n != null && d ? (Number(n) / Number(d)) * 100 : null);

/** Evenly thin a series to at most n points, keeping the first and the last. */
function thin(series, n = MAX_POINTS) {
  if (series.length <= n) return series;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(series[Math.round((i * (series.length - 1)) / (n - 1))]);
  return out;
}

/** Day-keyed tables: one point per UTC day at 00:00. */
const dayPoint = (day, v) => ({ t: `${day}T00:00:00.000Z`, v });
const stampPoint = (ts, v) => ({ t: L.isoOfSqlite(ts), v });

/** Metric definitions available for this target: [{ name, unit, series(hours) -> [{t, v}] }]. */
function metricDefs(target) {
  const defs = [];
  const forms = L.nameForms(target);
  const ref = target.identity && target.identity.ref;
  const has = (sql, ...a) => !!L.sq(sql, ...a);
  const add = (name, unit, series) => defs.push({ name, unit, series });
  // Subject id for a platform: the polled source itself, else the table row the name matches, else
  // the identity ref's id when that row still exists (the identity index is cached for a minute).
  const idFor = (platform, table, refField) => {
    if (target.source && target.source.platform === platform && target.source.id != null) return Number(target.source.id);
    if (forms.length) {
      const r = L.sq(`SELECT id FROM ${table} WHERE lower(name) IN (${marks(forms)}) LIMIT 1`, ...forms);
      if (r) return r.id;
    }
    if (ref && ref.platform === platform && ref[refField] != null && L.sq(`SELECT 1 x FROM ${table} WHERE id = ?`, ref[refField])) return ref[refField];
    return null;
  };

  // vCenter host and VM (daily tables)
  if (forms.length) {
    const host = L.sq(`SELECT vcenter_id, name FROM vcenter_hosts WHERE lower(name) IN (${marks(forms)}) OR ${SHORT} IN (${marks(forms)}) LIMIT 1`, ...forms, ...forms);
    if (host && has('SELECT 1 FROM vcenter_host_daily WHERE vcenter_id = ? AND host_name = ? LIMIT 1', host.vcenter_id, host.name)) {
      const q = (cols) => (hours) => L.sqAll(`SELECT day, ${cols} FROM vcenter_host_daily WHERE vcenter_id = ? AND host_name = ? AND day >= ? ORDER BY day`, host.vcenter_id, host.name, L.sqliteStamp(Date.now() - hours * L.HOUR).slice(0, 10));
      add('vcenter_host_cpu_pct', '%', (h) => q('cpu_last_mhz a, cpu_capacity_mhz_last b')(h).map((r) => dayPoint(r.day, pct(r.a, r.b))));
      add('vcenter_host_mem_pct', '%', (h) => q('mem_last_bytes a, mem_capacity_bytes_last b')(h).map((r) => dayPoint(r.day, pct(r.a, r.b))));
    }
    const vm = L.sq(`SELECT vcenter_id, name FROM vcenter_vms WHERE lower(name) IN (${marks(forms)}) LIMIT 1`, ...forms);
    if (vm && has('SELECT 1 FROM vcenter_vm_daily WHERE vcenter_id = ? AND vm_name = ? LIMIT 1', vm.vcenter_id, vm.name)) {
      const q = (col) => (hours) => L.sqAll(`SELECT day, ${col} v FROM vcenter_vm_daily WHERE vcenter_id = ? AND vm_name = ? AND day >= ? ORDER BY day`, vm.vcenter_id, vm.name, L.sqliteStamp(Date.now() - hours * L.HOUR).slice(0, 10)).map((r) => dayPoint(r.day, r.v));
      add('vcenter_vm_cpu_mhz', 'MHz', q('cpu_last_mhz'));
      add('vcenter_vm_mem_mb', 'MB', q('mem_last_mb'));
    }
    const ds = L.sq(`SELECT datastore_name n FROM vcenter_datastore_history WHERE lower(datastore_name) IN (${marks(forms)}) LIMIT 1`, ...forms);
    if (ds) {
      add('vcenter_datastore_free_pct', '%', (hours) => L.sqAll('SELECT captured_at ts, free_bytes f, capacity_bytes c FROM vcenter_datastore_history WHERE datastore_name = ? AND captured_at >= ? ORDER BY captured_at', ds.n, L.sqliteStamp(Date.now() - hours * L.HOUR)).map((r) => stampPoint(r.ts, pct(r.f, r.c))));
    }
  }

  // Pure
  const pureId = idFor('pure', 'pure_arrays', 'arrayId');
  if (pureId != null && has('SELECT 1 FROM pure_metrics_history WHERE array_id = ? LIMIT 1', pureId)) {
    const q = (cols) => (hours) => L.sqAll(`SELECT captured_at ts, ${cols} FROM pure_metrics_history WHERE array_id = ? AND captured_at >= ? ORDER BY captured_at`, pureId, L.sqliteStamp(Date.now() - hours * L.HOUR));
    add('pure_used_pct', '%', (h) => q('used_bytes a, capacity_bytes b')(h).map((r) => stampPoint(r.ts, pct(r.a, r.b))));
    add('pure_read_latency_us', 'us', (h) => q('read_latency_us a')(h).map((r) => stampPoint(r.ts, r.a)));
    add('pure_write_latency_us', 'us', (h) => q('write_latency_us a')(h).map((r) => stampPoint(r.ts, r.a)));
  }

  // NetApp
  const naId = idFor('netapp', 'netapp_arrays', 'arrayId');
  if (naId != null && has('SELECT 1 FROM netapp_metrics_history WHERE array_id = ? LIMIT 1', naId)) {
    const q = (cols) => (hours) => L.sqAll(`SELECT captured_at ts, ${cols} FROM netapp_metrics_history WHERE array_id = ? AND captured_at >= ? ORDER BY captured_at`, naId, L.sqliteStamp(Date.now() - hours * L.HOUR));
    add('netapp_used_pct', '%', (h) => q('used_bytes a, total_bytes b')(h).map((r) => stampPoint(r.ts, pct(r.a, r.b))));
    add('netapp_read_latency_us', 'us', (h) => q('read_latency_us a')(h).map((r) => stampPoint(r.ts, r.a)));
  }

  // Cohesity cluster
  const coId = idFor('cohesity', 'clusters', 'clusterId');
  if (coId != null && has('SELECT 1 FROM metrics_history WHERE cluster_id = ? LIMIT 1', coId)) {
    add('cohesity_used_pct', '%', (hours) => L.sqAll('SELECT captured_at ts, used_bytes a, total_capacity_bytes b FROM metrics_history WHERE cluster_id = ? AND captured_at >= ? ORDER BY captured_at', coId, L.sqliteStamp(Date.now() - hours * L.HOUR)).map((r) => stampPoint(r.ts, pct(r.a, r.b))));
  }

  // Brocade: CRC errors on the host's ports
  if (forms.length) {
    const ports = L.sqAll(`SELECT source_id, wwn FROM brocade_device_ports WHERE wwn IS NOT NULL AND (lower(COALESCE(fdmi_host_name,'')) IN (${marks(forms)}) OR lower(COALESCE(device_symbolic_name,'')) IN (${marks(forms)})) LIMIT 32`, ...forms, ...forms);
    // brocade_port_stats keys on the switch-side port WWN; the device-side wwn list is the best-effort join.
    const sw = ports.length ? L.sqAll(`SELECT source_id, switch_port_wwn w FROM brocade_device_ports WHERE wwn IN (${marks(ports.map((p) => p.wwn))}) AND switch_port_wwn IS NOT NULL`, ...ports.map((p) => p.wwn)) : [];
    if (sw.length && has(`SELECT 1 FROM brocade_port_stats WHERE port_wwn IN (${marks(sw)}) LIMIT 1`, ...sw.map((s) => s.w))) {
      add('brocade_crc_errors', 'errors', (hours) => L.sqAll(`SELECT ts, MAX(crc_errors) v FROM brocade_port_stats WHERE port_wwn IN (${marks(sw)}) AND ts >= ? GROUP BY ts ORDER BY ts`, ...sw.map((s) => s.w), L.sqliteStamp(Date.now() - hours * L.HOUR)).map((r) => stampPoint(r.ts, r.v)));
    }
  }

  // LogicMonitor datapoints stored for the device
  if (forms.length) {
    const dev = L.sq(`SELECT lm_device_id id FROM lm_devices WHERE lower(display_name) IN (${marks(forms)}) OR lower(COALESCE(name,'')) IN (${marks(forms)}) LIMIT 1`, ...forms, ...forms);
    if (dev) {
      const metrics = L.sqAll('SELECT DISTINCT metric FROM lm_ds_metrics_history WHERE lm_device_id = ? ORDER BY metric LIMIT 12', dev.id);
      for (const m of metrics) {
        add(`lm_${m.metric}`, '', (hours) => L.sqAll('SELECT sampled_at_epoch e, MAX(value) v FROM lm_ds_metrics_history WHERE lm_device_id = ? AND metric = ? AND sampled_at_epoch >= ? GROUP BY sampled_at_epoch ORDER BY sampled_at_epoch', dev.id, m.metric, Math.floor((Date.now() - hours * L.HOUR) / 1000)).map((r) => ({ t: new Date(r.e * 1000).toISOString(), v: r.v })));
      }
    }
  }
  return defs;
}

const round = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);

function summarize(def, hours) {
  const raw = def.series(hours).filter((p) => p.v != null && Number.isFinite(Number(p.v))).map((p) => ({ t: p.t, v: Number(p.v) }));
  if (!raw.length) return null;
  const vs = raw.map((p) => p.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
  const last = raw[raw.length - 1].v;
  return {
    series: thin(raw).map((p) => ({ t: p.t, v: round(p.v) })),
    min: round(min), max: round(max), avg: round(avg), last: round(last), unit: def.unit, samples: raw.length,
  };
}

/** Playbook choice: the metric the alert type maps to, for a metric this target has. */
function playbookMetric(target, ctx) {
  const defs = metricDefs(target);
  if (!defs.length) return null;
  const names = new Set(defs.map((d) => d.name));
  const wanted = String(target.name || '').toLowerCase();
  for (const a of (ctx && ctx.alerts) || []) {
    if (a.cleared_at || !a.type) continue;
    const host = String(a.host || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').split(/[\s,]/)[0];
    if (host && host !== wanted && host.split('.')[0] !== wanted.split('.')[0]) continue;
    const m = (historyMetricFor[a.platform] || {})[a.type];
    if (m && names.has(m)) return defs.find((d) => d.name === m);
  }
  return null;
}

module.exports = {
  id: 'history_slice',
  label: 'History slice (stored metrics)',
  description: 'Reads a stored metric series for the system from ICC\'s own history tables (host CPU and memory, datastore free space, array latency and capacity, port errors, LogicMonitor datapoints) over 1 to 720 hours, thinned to at most 48 points with min, average, max and last. Reads only the ICC database; nothing leaves the box.',
  risk: 'read-only',
  defaultEnabled: true,
  timeoutMs: 4000,
  deepOnly: false,
  localOnly: true, // reads ICC's own database only, so it also runs in the public demo
  platform: null,
  // Tool mode: the model picks metric (from the per-target menu) and hours.
  params: {
    properties: {
      metric: { type: 'string', description: 'Which stored metric to read; one of the names offered for the chosen system.' },
      hours: { type: 'integer', minimum: 1, maximum: 720, description: 'How far back to read, in hours (default 24).' },
    },
    required: ['metric'],
  },
  paramEnums: { metric: (target) => metricDefs(target).map((d) => d.name) },
  appliesTo(target) { return metricDefs(target).length > 0; },
  async run(target, ctx, args = {}) {
    let def;
    const hasArgs = args && args.metric !== undefined;
    if (hasArgs) {
      def = metricDefs(target).find((d) => d.name === args.metric);
      if (!def) return { ok: false, summary: `unknown metric "${String(args.metric).slice(0, 60)}" for this target`, data: null };
    } else {
      def = playbookMetric(target, ctx);
      if (!def) return null; // nothing maps: skipped, not an error
    }
    const hours = args && args.hours !== undefined ? args.hours : DEFAULT_HOURS;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { ok: false, summary: 'hours must be an integer from 1 to 720', data: null };
    const s = summarize(def, hours);
    if (!s) return { ok: true, summary: `${def.name} over ${hours} h: no stored samples`, data: { series: [], unit: def.unit } };
    return {
      ok: true,
      summary: `${def.name} over ${hours} h: min ${s.min}, avg ${s.avg}, max ${s.max}, last ${s.last}${def.unit ? ` ${def.unit}` : ''}`,
      data: s,
    };
  },
  // exported for tests
  _metricDefs: metricDefs,
  _thin: thin,
};
