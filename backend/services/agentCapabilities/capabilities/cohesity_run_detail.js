// Deep pass: the newest runs of the protection group behind the failing
// object, read live from the Cohesity cluster, so the model sees the real
// error text and timing instead of the last poll's summary. One v1 call
// (fetchProtectionRuns) per target; the cluster row goes to the API module,
// which does its own credential handling.
const L = require('./lib');

const OK_STATUS = "('kSuccess','Succeeded','kRunning','Running','kAccepted','Accepted','kWarning','SucceededWithWarning')";

function groupNames(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v.map(String); } catch { /* plain text */ }
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/** { clusterId, jobId, jobName } or null. */
function resolve(target) {
  const src = target.source;
  if (src && src.platform === 'cohesity' && src.id != null) {
    const r = L.sq(`SELECT job_id, job_name FROM protection_runs WHERE cluster_id = ? AND job_id IS NOT NULL AND status NOT IN ${OK_STATUS} ORDER BY start_time DESC LIMIT 1`, Number(src.id));
    return r ? { clusterId: Number(src.id), jobId: r.job_id, jobName: r.job_name } : null;
  }
  const forms = L.nameForms(target);
  if (!forms.length) return null;
  const marks = forms.map(() => '?').join(',');
  const objs = L.sqAll(`SELECT cluster_id, protection_groups FROM cohesity_objects WHERE lower(name) IN (${marks}) AND protection_groups IS NOT NULL LIMIT 10`, ...forms);
  let first = null;
  for (const o of objs) {
    for (const g of groupNames(o.protection_groups)) {
      const bad = L.sq(`SELECT job_id, job_name FROM protection_runs WHERE cluster_id = ? AND job_name = ? AND job_id IS NOT NULL AND status NOT IN ${OK_STATUS} ORDER BY start_time DESC LIMIT 1`, o.cluster_id, g);
      if (bad) return { clusterId: o.cluster_id, jobId: bad.job_id, jobName: bad.job_name };
      if (!first) {
        const any = L.sq('SELECT job_id, job_name FROM protection_runs WHERE cluster_id = ? AND job_name = ? AND job_id IS NOT NULL ORDER BY start_time DESC LIMIT 1', o.cluster_id, g);
        if (any) first = { clusterId: o.cluster_id, jobId: any.job_id, jobName: any.job_name };
      }
    }
  }
  return first;
}

const usecsMs = (u) => (u ? Number(u) / 1000 : NaN);

module.exports = {
  id: 'cohesity_run_detail',
  label: 'Cohesity protection group runs (live)',
  description: 'Reads the five newest runs of the protection group that backs up the failing object straight from the Cohesity cluster: start, status, duration and the error text. One read-only call.',
  risk: 'platform-api',
  defaultEnabled: false,
  timeoutMs: 8000,
  deepOnly: true,
  platform: null,
  appliesTo(target) { return !!resolve(target); },
  async run(target) {
    const r = resolve(target);
    if (!r) return { ok: false, summary: 'no protection group found for this target', data: { lines: [] } };
    const cluster = L.sq('SELECT * FROM clusters WHERE id = ?', r.clusterId);
    if (!cluster) return { ok: false, summary: 'cluster not on record', data: { lines: [] } };
    const since = (Date.now() - 7 * 86400000) * 1000;
    const runs = await L.api('cohesityApi').fetchProtectionRuns(cluster, 5, since, null, r.jobId);
    const rows = (Array.isArray(runs) ? runs : []).map((x) => {
      const br = x.backupRun || {};
      const st = br.stats || {};
      const err = br.error && (typeof br.error === 'string' ? br.error : br.error.message);
      const s = usecsMs(st.startTimeUsecs);
      const e = usecsMs(st.endTimeUsecs);
      return { s, e, status: String(br.status || 'unknown').replace(/^k/, ''), err: err ? String(err) : '' };
    }).sort((a, b) => (b.s || 0) - (a.s || 0)).slice(0, 5);
    const lines = L.boundLines(rows.map((x) => `Run ${Number.isFinite(x.s) ? L.isoAt(x.s) : 'unknown time'} ${x.status} ${Number.isFinite(x.s) && Number.isFinite(x.e) ? L.fmtMs(x.e - x.s) : 'no duration'}${x.err ? ` ${x.err}` : ''}`));
    const failed = rows.filter((x) => !/^(Success|Succeeded|Running|Accepted)$/i.test(x.status)).length;
    return {
      ok: true,
      summary: `${r.jobName}: ${rows.length} newest run(s), ${failed} not successful`,
      data: { lines, group: r.jobName },
    };
  },
};
