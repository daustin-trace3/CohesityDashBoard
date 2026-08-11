// Server 360 contribution (host manifest hook, 2026-08-03): when the ops
// Server 360 page pivots on a name/IP, the host calls server360(coreApi, ctx)
// on every enabled installed plugin and renders the returned DISPLAY-READY
// section generically (see backend/core/registry.js getServer360Providers()
// and backend/routes/server360.js). Reference implementation:
// plugin-sdk/proxmox/backend/src/server360.js.
//
// Ported from the built-in's raw `netbackup: { clients: [...] }` contribution
// in backend/routes/server360.js (client lookup by name only — NetBackup jobs
// carry no IP data) and the inline netbackup block of that file's /suggest
// route, reshaped into display-ready facts/lines/link groups.
const ACCENT = '#B1181E';

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};

const statusTone = (status) => (status === 'success' ? 'ok' : status === 'failed' ? 'crit' : 'neutral');
const lower = (s) => String(s || '').toLowerCase();

function server360(coreApi, { names } = {}) {
  const nameList = (names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  if (!nameList.length) return null;

  const db = coreApi.db;
  const ph = nameList.map(() => '?').join(',');
  const jobs = db.prepare(`
    SELECT j.*, s.name AS source_name FROM netbackup_jobs j
    JOIN netbackup_sources s ON s.id = j.source_id
    WHERE lower(j.client_name) IN (${ph}) AND j.started_at >= datetime('now', '-7 days')
  `).all(...nameList);
  if (!jobs.length) return null;

  const byClient = new Map();
  for (const j of jobs) {
    const key = `${lower(j.client_name)}|${j.source_id}`;
    let c = byClient.get(key);
    if (!c) {
      c = {
        clientName: j.client_name, sourceName: j.source_name, policies: new Set(),
        jobs7d: 0, failed7d: 0, lastStatus: null, lastRunAt: null, lastSuccessAt: null, logicalBytes: null,
      };
      byClient.set(key, c);
    }
    if (j.policy_name) c.policies.add(j.policy_name);
    c.jobs7d += 1;
    const failed = j.state === 'FAILED' || (['EXITED', 'DONE'].includes(j.state) && Number(j.status_code || 0) > 0);
    const succeeded = !failed && ['EXITED', 'DONE'].includes(j.state);
    if (failed) c.failed7d += 1;
    const runAt = j.ended_at || j.started_at;
    if (runAt && (!c.lastRunAt || runAt > c.lastRunAt)) {
      c.lastRunAt = runAt;
      c.lastStatus = failed ? 'failed' : succeeded ? 'success' : (j.state || null);
    }
    if (succeeded && runAt && (!c.lastSuccessAt || runAt > c.lastSuccessAt)) {
      c.lastSuccessAt = runAt;
      c.logicalBytes = j.kilobytes != null ? j.kilobytes * 1024 : null;
    }
  }

  const groups = [...byClient.values()].map((c) => {
    const facts = [
      { label: 'Client', value: c.clientName },
      { label: 'Source', value: c.sourceName },
      { label: 'Policies', value: c.policies.size ? [...c.policies].join(', ') : '—' },
      { label: 'Jobs (7d)', value: `${c.jobs7d - c.failed7d}/${c.jobs7d} ok` },
      c.lastRunAt
        ? { label: 'Last Run', value: `${c.lastStatus || '—'} · ${new Date(c.lastRunAt).toLocaleString()}`, tone: statusTone(c.lastStatus) }
        : { label: 'Last Run', value: '—' },
      c.lastSuccessAt
        ? { label: 'Last Success', value: `${new Date(c.lastSuccessAt).toLocaleString()} (${fmtBytes(c.logicalBytes)})` }
        : { label: 'Last Success', value: '—' },
    ];

    return {
      facts,
      lines: [],
      link: { label: 'Open Object 360 →', href: `/netbackup/object-360?name=${encodeURIComponent(c.clientName)}` },
    };
  });

  return { title: 'Backup (NetBackup)', chip: { label: 'NetBackup', color: ACCENT }, groups };
}

function server360Suggest(coreApi, q) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return coreApi.db
    .prepare(`SELECT DISTINCT client_name AS name FROM netbackup_jobs WHERE client_name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`)
    .all(pattern)
    .map((r) => r.name);
}

module.exports = { server360, server360Suggest };
