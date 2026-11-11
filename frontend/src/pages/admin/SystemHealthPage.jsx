import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Gauge, Database, Timer, Globe, Info, MemoryStick, HeartPulse, AlertTriangle, Download } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, StatCard, Badge, Panel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import SettingsTabs, { useSettingsTab } from '../../components/settings/SettingsTabs';
import Sparkline from '../../components/ops/Sparkline';
import { useVisibleInterval, saveBlob } from '../logicmonitor/helpers';

const TABS = [
  { key: 'overview', label: 'Overview', icon: Gauge },
  { key: 'database', label: 'Database', icon: Database },
  { key: 'polling', label: 'Polling', icon: Timer },
  { key: 'requests', label: 'Requests', icon: Globe },
  { key: 'versions', label: 'Versions', icon: Info },
];

const REFRESH_MS = 30000;
const SEV_TONE = { crit: 'crit', warn: 'warn', info: 'info' };

// ---- helpers --------------------------------------------------------------

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtMb(n) {
  return n == null ? '-' : `${n} MB`;
}

// ms under 1000, seconds with one decimal under a minute, else m:ss.
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '-';
  const v = Number(ms);
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  const total = Math.round(v / 1000);
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtWhen(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function fmtUptime(sec) {
  if (sec == null) return '-';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const thCls = 'text-[11px] text-ink-faint border-b border-cohesity-border';
const tdCls = 'py-1.5 pr-3 tnum';

function statusTone(s) {
  if (s === 'success') return 'ok';
  if (s === 'error') return 'crit';
  return 'neutral';
}

// ---- tabs -----------------------------------------------------------------

function Overview({ data }) {
  const { processes: p, polling, requests, database } = data;
  const web = p?.web || {};
  const poller = p?.poller || null;
  const worst = (requests?.routes || [])[0] || null;
  const errWeb = web.log?.error ?? 0;
  const errPoller = poller?.log?.error ?? 0;
  const warnWeb = web.log?.warn ?? 0;
  const warnPoller = poller?.log?.warn ?? 0;
  const sum = polling?.summary || {};

  const recent = useMemo(() => {
    const tag = (arr, src) => (arr || []).map(r => ({ ...r, src }));
    return [...tag(web.log?.recent, 'web'), ...tag(poller?.log?.recent, 'poller')]
      .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
  }, [web, poller]);

  const longest = useMemo(
    () => [...(polling?.sources || [])].filter(s => s.maxDurationMs != null).sort((a, b) => (b.maxDurationMs || 0) - (a.maxDurationMs || 0)).slice(0, 8),
    [polling]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
        <StatCard icon={MemoryStick} label="Web memory" value={fmtMb(web.mem?.rssMb)}
          sub={`heap ${fmtMb(web.mem?.heapUsedMb)} of ${fmtMb(web.mem?.heapTotalMb)}`} />
        <StatCard icon={MemoryStick} label="Poller memory" value={poller ? fmtMb(poller.mem?.rssMb) : '-'}
          tone={(poller?.mem?.rssMb || 0) > 1024 ? 'warn' : 'default'}
          sub={poller ? `heap ${fmtMb(poller.mem?.heapUsedMb)} of ${fmtMb(poller.mem?.heapTotalMb)}` : 'no heartbeat'} />
        <StatCard icon={HeartPulse} label="Poller heartbeat"
          value={poller ? (poller.alive ? 'Alive' : 'Silent') : 'None'}
          tone={poller && poller.alive ? 'ok' : 'crit'}
          sub={poller ? `${poller.ageSeconds}s ago, up ${fmtUptime(poller.uptimeSeconds)}` : 'poller has not reported'} />
        <StatCard icon={Activity} label="Event loop lag p99"
          value={`${web.loopLagP99Ms ?? '-'} / ${poller?.loopLagP99Ms ?? '-'} ms`}
          tone={Math.max(web.loopLagP99Ms || 0, poller?.loopLagP99Ms || 0) > 200 ? 'warn' : 'default'}
          sub="web / poller" />
        <StatCard icon={Database} label="Database" value={fmtBytes(database?.fileBytes)}
          sub={`WAL ${fmtBytes(database?.walBytes)}`} />
        <StatCard icon={Timer} label="Polls last 24 h" value={sum.runs24h ?? '-'}
          tone={(sum.failures24h || 0) > 0 ? 'warn' : 'default'} sub={`${sum.failures24h ?? 0} failures`} />
        <StatCard icon={Globe} label="Request p95" value={worst ? `${worst.p95} ms` : '-'}
          tone={worst && worst.p95 > 1500 ? 'warn' : 'default'} sub={worst ? worst.route : 'no requests yet'} />
        <StatCard icon={AlertTriangle} label="Errors since start" value={`${errWeb + errPoller}`}
          tone={errWeb + errPoller > 0 ? 'warn' : 'default'} sub={`${warnWeb + warnPoller} warnings`} />
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
        <Panel title="Recent errors">
          {recent.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No errors or warnings logged since the processes started.</p>
          ) : (
            <table className="w-full table-fixed text-[13px]">
              <thead><tr className={thCls}><th className="text-left py-1.5 pr-3 w-48">Time</th><th className="text-left pr-3 w-20">Proc</th><th className="text-left pr-3 w-20">Level</th><th className="text-left">Message</th></tr></thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={`${r.src}-${r.at}-${i}`} className="border-b border-cohesity-border/40 align-top">
                    <td className={`${tdCls} whitespace-nowrap`}>{fmtWhen(r.at)}</td>
                    <td className="py-1.5 pr-3">{r.src}</td>
                    <td className="py-1.5 pr-3"><Badge tone={r.level === 'error' ? 'crit' : 'warn'}>{r.level}</Badge></td>
                    <td className="py-1.5 text-ink-muted min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{r.msg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Longest polls (24 h)">
          {longest.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No poll runs recorded yet.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead><tr className={thCls}><th className="text-left py-1.5 pr-3">Source</th><th className="text-right pr-3">Max</th><th className="text-right pr-3">Avg</th><th className="text-left">Perf Trend</th></tr></thead>
              <tbody>
                {longest.map(s => (
                  <tr key={`${s.platform}-${s.sourceId}-${s.kind}`} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3">{s.platform} / {s.sourceName || `#${s.sourceId}`}</td>
                    <td className={`${tdCls} text-right`}>{fmtDuration(s.maxDurationMs)}</td>
                    <td className={`${tdCls} text-right`}>{fmtDuration(s.avgDurationMs)}</td>
                    <td className="py-1.5"><Sparkline values={s.series} color="#60A5FA" width={90} height={24} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function DatabaseTab({ data, onRecompute, recomputing, notice }) {
  const db = data.database || {};
  const snap = db.snapshot;
  // The data file and the admin file (users, settings, plugins) each have a row.
  const files = db.files && db.files.length ? db.files : [{ role: 'data', path: db.path, fileBytes: db.fileBytes, walBytes: db.walBytes }];
  const rows = useMemo(
    () => (snap?.tables || []).map(t => {
      const f = files.find(x => x.role === (t.file || 'data'));
      const size = f ? f.fileBytes : db.fileBytes;
      return { ...t, file: t.file || 'data', share: size ? (t.bytes + t.indexBytes) / size : 0 };
    }),
    [snap, db.fileBytes, files]);
  const ctl = useTableControls(rows, { searchKeys: ['name'], defaultSortKey: 'bytes', defaultSortDir: 'desc', paginate: true, deepLink: false });
  const cp = db.lastCheckpoint;

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Database file" actions={
        <button onClick={onRecompute} disabled={recomputing}
          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 disabled:opacity-50 cursor-pointer">
          {recomputing ? 'Working...' : 'Recompute now'}
        </button>}>
        <dl className="grid gap-x-6 gap-y-1.5 text-[13px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {files.map(f => (
            <div key={f.role}><dt className="text-ink-faint text-[11px]">{f.role === 'admin' ? 'Admin file' : 'Data file'}</dt>
              <dd className="text-ink break-all">{f.path || '-'}</dd>
              <dd className="text-ink tnum">{fmtBytes(f.fileBytes)} / WAL {fmtBytes(f.walBytes)}{f.pageCount != null ? `, ${f.pageCount} pages, ${f.freelist} free` : ''}</dd></div>
          ))}
          <div><dt className="text-ink-faint text-[11px]">Journal mode</dt><dd className="text-ink">{snap?.journalMode || '-'}</dd></div>
          <div><dt className="text-ink-faint text-[11px]">Page size / pages / free</dt><dd className="text-ink tnum">{snap ? `${snap.pageSize} / ${snap.pageCount} / ${snap.freelistPages}` : '-'}</dd></div>
          <div><dt className="text-ink-faint text-[11px]">Last checkpoint</dt>
            <dd className="text-ink tnum">{cp ? `${fmtWhen(cp.at)} (${cp.mode}, ${cp.beforeMb} to ${cp.afterMb} MB)` : 'none recorded'}</dd></div>
          <div><dt className="text-ink-faint text-[11px]">Snapshot age</dt>
            <dd className="text-ink tnum">{db.snapshotAgeSeconds != null ? fmtDuration(db.snapshotAgeSeconds * 1000) : '-'}{db.refreshPending ? ' (recompute queued)' : ''}</dd></div>
        </dl>
        {notice && <p className="text-[12px] text-ink-muted mt-3">{notice}</p>}
      </Panel>

      {!snap ? (
        <Panel title="Tables"><p className="text-[13px] text-ink-muted">Waiting for the first sweep. The poller measures table sizes a minute after it starts and every 15 minutes after that.</p></Panel>
      ) : (
        <Panel title={`Tables (${snap.totals?.tables ?? rows.length}, ${fmtBytes((snap.totals?.bytes || 0) + (snap.totals?.indexBytes || 0))})`}
          actions={<CsvExportButton filename="icc-db-tables" rows={rows} columns={[
            { label: 'Table', get: 'name' }, { label: 'File', get: 'file' }, { label: 'Rows', get: 'rows' }, { label: 'Data bytes', get: 'bytes' },
            { label: 'Index bytes', get: 'indexBytes' }, { label: 'Share of file', get: r => (r.share * 100).toFixed(2) + '%' },
          ]} />}>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <TableSearch ctl={ctl} placeholder="Search tables" />
            <span className="text-[11px] text-ink-faint tnum ml-auto">{ctl.rows.length} of {rows.length} tables</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className={thCls}>
                <SortTh k="name" label="Table" ctl={ctl} />
                <SortTh k="file" label="File" ctl={ctl} />
                <SortTh k="rows" label="Rows" ctl={ctl} align="right" />
                <SortTh k="bytes" label="Data" ctl={ctl} align="right" />
                <SortTh k="indexBytes" label="Indexes" ctl={ctl} align="right" />
                <SortTh k="share" label="Share of file" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map(t => (
                  <tr key={`${t.file}:${t.name}`} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink">{t.name}</td>
                    <td className="py-1.5 pr-3 text-ink-muted">{t.file}</td>
                    <td className={`${tdCls} text-right`}>{Number(t.rows).toLocaleString()}</td>
                    <td className={`${tdCls} text-right`}>{fmtBytes(t.bytes)}</td>
                    <td className={`${tdCls} text-right`}>{fmtBytes(t.indexBytes)}</td>
                    <td className={`${tdCls} text-right`}>{(t.share * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </Panel>
      )}
    </div>
  );
}

function PollRow({ s, open, onToggle }) {
  return (
    <>
      <tr onClick={onToggle} className="border-b border-cohesity-border/40 cursor-pointer hover:bg-surface-overlay/50">
        <td className="py-1.5 pr-3 text-ink">{s.platform}</td>
        <td className="py-1.5 pr-3">{s.sourceName || `#${s.sourceId}`}</td>
        <td className="py-1.5 pr-3 text-ink-muted">{s.kind}</td>
        <td className="py-1.5 pr-3"><Badge tone={statusTone(s.lastStatus)}>{s.lastStatus || 'none'}</Badge></td>
        <td className={`${tdCls} text-right`}>{fmtDuration(s.lastDurationMs)}</td>
        <td className={`${tdCls} text-right`}>{fmtDuration(s.avgDurationMs)}</td>
        <td className={`${tdCls} text-right`}>{fmtDuration(s.maxDurationMs)}</td>
        <td className={`${tdCls} text-right`}>{s.runs24h}</td>
        <td className={`${tdCls} text-right`}>{s.failures24h}</td>
        <td className="py-1.5 pr-3"><Sparkline values={s.series} color="#60A5FA" width={90} height={24} /></td>
        <td className="py-1.5">{s.isStale ? <Badge tone="warn">stale</Badge> : null}</td>
      </tr>
      {open && (
        <tr className="border-b border-cohesity-border/40">
          <td colSpan={11} className="py-2 px-3 text-[12px] text-ink-muted break-words">
            <span className="text-ink-faint">Last started {fmtWhen(s.lastStartedAt)}. </span>
            {s.lastError ? s.lastError : 'No error recorded for the last run.'}
          </td>
        </tr>
      )}
    </>
  );
}

function PollingTab({ data }) {
  const polling = data.polling || {};
  const sum = polling.summary || {};
  const rows = useMemo(
    () => (polling.sources || []).map(s => ({ ...s, _id: `${s.platform}:${s.sourceId}:${s.kind}`, status: s.lastStatus || 'none' })),
    [polling]);
  const ctl = useTableControls(rows, { searchKeys: ['platform', 'sourceName'], paginate: true, deepLink: false });
  const [open, setOpen] = useState(null);
  const csvCols = [
    { label: 'Platform', get: 'platform' }, { label: 'Source', get: 'sourceName' }, { label: 'Kind', get: 'kind' },
    { label: 'Last status', get: 'lastStatus' }, { label: 'Last duration ms', get: 'lastDurationMs' },
    { label: 'Avg 24h ms', get: 'avgDurationMs' }, { label: 'Max 24h ms', get: 'maxDurationMs' },
    { label: 'Runs 24h', get: 'runs24h' }, { label: 'Failures 24h', get: 'failures24h' },
    { label: 'Stale', get: s => (s.isStale ? 'yes' : 'no') }, { label: 'Last error', get: 'lastError' },
  ];
  const longest = sum.longest;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        <StatCard icon={Timer} label="Sources" value={sum.sources ?? '-'} />
        <StatCard icon={Timer} label="Stale" value={sum.stale ?? 0} tone={(sum.stale || 0) > 0 ? 'warn' : 'default'} />
        <StatCard icon={Timer} label="Runs 24 h" value={sum.runs24h ?? 0} />
        <StatCard icon={Timer} label="Failures 24 h" value={sum.failures24h ?? 0} tone={(sum.failures24h || 0) > 0 ? 'crit' : 'default'} />
        <StatCard icon={Timer} label="Longest" value={longest ? fmtDuration(longest.durationMs) : '-'}
          sub={longest ? `${longest.platform} / ${longest.sourceName || ''}` : 'no runs yet'} />
      </div>
      <Panel title="Sources, worst first" actions={<CsvExportButton filename="icc-poll-sources" rows={rows} columns={csvCols} />}>
        {rows.length === 0 ? (
          <p className="text-[13px] text-ink-muted">No poll runs have been recorded yet. Runs appear here after the next poll.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <TableSearch ctl={ctl} placeholder="Search platform or source" />
              <FilterSelect ctl={ctl} k="platform" rows={rows} label="platforms" />
              <FilterSelect ctl={ctl} k="status" rows={rows} label="statuses" />
              <span className="text-[11px] text-ink-faint tnum ml-auto">{ctl.rows.length} of {rows.length} sources</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className={thCls}>
                  <SortTh k="platform" label="Platform" ctl={ctl} />
                  <SortTh k="sourceName" label="Source" ctl={ctl} />
                  <SortTh k="kind" label="Kind" ctl={ctl} />
                  <SortTh k="status" label="Last status" ctl={ctl} />
                  <SortTh k="lastDurationMs" label="Last" ctl={ctl} align="right" />
                  <SortTh k="avgDurationMs" label="Avg 24 h" ctl={ctl} align="right" />
                  <SortTh k="maxDurationMs" label="Max 24 h" ctl={ctl} align="right" />
                  <SortTh k="runs24h" label="Runs 24 h" ctl={ctl} align="right" />
                  <SortTh k="failures24h" label="Failures 24 h" ctl={ctl} align="right" />
                  <th className="text-left">Perf Trend</th>
                  <th className="text-left">Stale</th>
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map(s => (
                    <PollRow key={s._id} s={s} open={open === s._id} onToggle={() => setOpen(open === s._id ? null : s._id)} />
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </Panel>
    </div>
  );
}

function RequestsTab({ data }) {
  const req = data.requests || {};
  const rows = useMemo(() => (req.routes || []).map(r => ({ ...r })), [req]);
  const ctl = useTableControls(rows, { searchKeys: ['route'], defaultSortKey: 'p95', defaultSortDir: 'desc', paginate: true, deepLink: false });
  const csvCols = [
    { label: 'Route', get: 'route' }, { label: 'Count', get: 'count' }, { label: 'p50 ms', get: 'p50' },
    { label: 'p95 ms', get: 'p95' }, { label: 'Max ms', get: 'maxMs' }, { label: '4xx', get: 'errors4xx' },
    { label: '5xx', get: 'errors5xx' }, { label: 'Last', get: 'lastAt' },
  ];
  return (
    <Panel title={`Routes (${req.total ?? 0} requests)`} actions={<CsvExportButton filename="icc-requests" rows={rows} columns={csvCols} />}>
      <p className="text-[12px] text-ink-muted mb-3">Measured in the web process since {fmtWhen(req.since)}; resets on restart.</p>
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-muted">No requests recorded yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <TableSearch ctl={ctl} placeholder="Search routes" />
            <span className="text-[11px] text-ink-faint tnum ml-auto">{ctl.rows.length} of {rows.length} routes</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className={thCls}>
                <SortTh k="route" label="Route" ctl={ctl} />
                <SortTh k="count" label="Count" ctl={ctl} align="right" />
                <SortTh k="p50" label="p50" ctl={ctl} align="right" />
                <SortTh k="p95" label="p95" ctl={ctl} align="right" />
                <SortTh k="maxMs" label="Max" ctl={ctl} align="right" />
                <SortTh k="errors4xx" label="4xx" ctl={ctl} align="right" />
                <SortTh k="errors5xx" label="5xx" ctl={ctl} align="right" />
                <SortTh k="lastAt" label="Last" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map(r => (
                  <tr key={r.route} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink break-all">{r.route}</td>
                    <td className={`${tdCls} text-right`}>{r.count}</td>
                    <td className={`${tdCls} text-right`}>{fmtDuration(r.p50)}</td>
                    <td className={`${tdCls} text-right ${r.p95 > 1500 ? 'text-status-warn' : ''}`}>{fmtDuration(r.p95)}</td>
                    <td className={`${tdCls} text-right`}>{fmtDuration(r.maxMs)}</td>
                    <td className={`${tdCls} text-right`}>{r.errors4xx}</td>
                    <td className={`${tdCls} text-right ${r.errors5xx > 0 ? 'text-status-crit' : ''}`}>{r.errors5xx}</td>
                    <td className="py-1.5 whitespace-nowrap">{fmtWhen(r.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </Panel>
  );
}

function Fact({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-cohesity-border/40 py-1.5 text-[13px]">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink tnum text-right break-all">{children}</dd>
    </div>
  );
}

function VersionsTab({ data }) {
  const app = data.app || {};
  const lic = data.license || {};
  const users = data.users || {};
  const plugins = data.platforms?.plugins || [];
  const enabled = data.platforms?.enabled || [];
  const migrations = data.migrations || [];
  return (
    <div className="flex flex-col gap-4">
      <Panel title="This install">
        <dl className="grid gap-x-8" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <div>
            <Fact label="App version">{app.version || '-'}</Fact>
            <Fact label="Node">{app.nodeVersion || '-'}</Fact>
            <Fact label="SQLite">{app.sqliteVersion || '-'}</Fact>
            <Fact label="better-sqlite3">{app.betterSqlite3Version || '-'}</Fact>
            <Fact label="OS / arch">{app.platform || '-'} / {app.arch || '-'}</Fact>
            <Fact label="Hostname">{app.hostname || '-'}</Fact>
          </div>
          <div>
            <Fact label="pm2 id (web)">{app.pm2?.web ?? '-'}</Fact>
            <Fact label="Tenant">{app.tenantId ?? '-'}</Fact>
            <Fact label="Demo mode">{app.demo ? 'yes' : 'no'}</Fact>
            <Fact label="License">{lic.state || '-'}{lic.expiresAt ? `, expires ${fmtWhen(lic.expiresAt)}` : ''}</Fact>
            <Fact label="Customer">{lic.customer || '-'}</Fact>
            <Fact label="Users / active sessions">{users.count ?? '-'} / {users.activeSessions ?? '-'}</Fact>
          </div>
        </dl>
      </Panel>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <Panel title="Migrations">
          <table className="w-full text-[13px]">
            <thead><tr className={thCls}><th className="text-left py-1.5 pr-3">Scope</th><th className="text-right pr-3">Version</th><th className="text-left">Applied</th></tr></thead>
            <tbody>
              {migrations.map(m => (
                <tr key={m.scope} className="border-b border-cohesity-border/40">
                  <td className="py-1.5 pr-3 text-ink">{m.scope}</td>
                  <td className={`${tdCls} text-right`}>v{m.version}</td>
                  <td className="py-1.5 tnum">{fmtWhen(m.appliedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Platforms and plugins">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {enabled.length === 0 ? <span className="text-[13px] text-ink-muted">No platforms enabled.</span>
              : enabled.map(id => <Badge key={id} tone="brand">{id}</Badge>)}
          </div>
          {plugins.length === 0 ? (
            <p className="text-[13px] text-ink-muted">No plugins installed.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead><tr className={thCls}><th className="text-left py-1.5 pr-3">Plugin</th><th className="text-left pr-3">Version</th><th className="text-left pr-3">Status</th><th className="text-left">Enabled</th></tr></thead>
              <tbody>
                {plugins.map(pl => (
                  <tr key={pl.id} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink">{pl.id}</td>
                    <td className={tdCls}>{pl.version || <span className="text-ink-faint">built-in</span>}</td>
                    <td className="py-1.5 pr-3">{pl.status}</td>
                    <td className="py-1.5"><Badge tone={pl.enabled ? 'ok' : 'neutral'}>{pl.enabled ? 'on' : 'off'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ---- page -----------------------------------------------------------------

function errorText(err) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const text = (body && (body.error || body.message)) || err?.message || 'Request failed';
  return status ? `HTTP ${status}: ${text}` : text;
}

export default function SystemHealthPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [notice, setNotice] = useState('');
  const [exportError, setExportError] = useState('');
  const [tab, selectTab] = useSettingsTab(TABS, 'overview');

  const load = useCallback(async (silent) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await client.get('/system/health');
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(true); }, [load]);
  useVisibleInterval(() => load(true), REFRESH_MS);

  const exportJson = async () => {
    setExportError('');
    try {
      const res = await client.get('/system/health/export.json', { responseType: 'blob' });
      const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, '');
      saveBlob(res.data, `icc-health-${data?.app?.hostname || 'export'}-${stamp}.json`);
    } catch (err) {
      setExportError(`Export failed. ${errorText(err)}`);
    }
  };

  const recompute = async () => {
    setRecomputing(true);
    setNotice('');
    try {
      const res = await client.post('/system/health/db-refresh');
      if (res.data?.computedNow && res.data.snapshot) {
        setData(d => (d ? { ...d, database: { ...d.database, snapshot: res.data.snapshot, snapshotAgeSeconds: 0, refreshPending: false } } : d));
        setNotice('Table sizes recomputed just now.');
      } else {
        setData(d => (d ? { ...d, database: { ...d.database, refreshPending: true } } : d));
        setNotice('Queued for the next sweep. The poller picks it up within a minute.');
      }
    } catch (err) {
      setNotice(`Recompute failed. ${errorText(err)}`);
    } finally {
      setRecomputing(false);
    }
  };

  const findings = data?.findings || [];

  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <PageHeader icon={Activity} title="System Health"
        description="How ICC itself is running: both processes, the database, poll durations, request latency and versions.">
        <LastUpdated date={data?.generatedAt} />
        <button onClick={exportJson} disabled={!data}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
          <Download size={15} /> Export JSON
        </button>
        <RefreshButton onClick={() => load(false)} refreshing={refreshing} />
      </PageHeader>

      {exportError && <p className="text-[12px] text-status-crit">{exportError}</p>}

      {loading && !data && <p className="text-ink-muted" role="status">Loading system health...</p>}

      {error && (
        <div className="panel p-4 border-status-crit/40" role="alert">
          <p className="text-status-crit font-semibold">System health did not load</p>
          <p className="text-ink-muted mt-1 break-words">{error}</p>
        </div>
      )}

      {data && (
        <>
          <div className="panel p-3 flex flex-col gap-1.5" aria-label="Findings">
            {findings.length === 0 ? (
              <p className="text-ink-muted"><Badge tone="ok">ok</Badge> All clear. Nothing needs attention right now.</p>
            ) : findings.map(f => (
              <button key={f.id} onClick={() => f.tab && selectTab(f.tab)}
                className="flex items-center gap-2 text-left cursor-pointer hover:text-ink text-ink-muted"
                style={{ background: 'none', border: 'none', padding: 0 }}>
                <Badge tone={SEV_TONE[f.severity] || 'neutral'}>{f.severity}</Badge>
                <span>{f.text}</span>
              </button>
            ))}
          </div>

          <SettingsTabs tabs={TABS} active={tab} onChange={selectTab} label="System health sections" />

          {tab === 'overview' && <Overview data={data} />}
          {tab === 'database' && <DatabaseTab data={data} onRecompute={recompute} recomputing={recomputing} notice={notice} />}
          {tab === 'polling' && <PollingTab data={data} />}
          {tab === 'requests' && <RequestsTab data={data} />}
          {tab === 'versions' && <VersionsTab data={data} />}
        </>
      )}
    </div>
  );
}
