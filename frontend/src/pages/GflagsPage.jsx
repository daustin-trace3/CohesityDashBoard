import { useCallback, useEffect, useMemo, useState } from 'react';
import { Flag, ChevronDown, ChevronRight, Download, History, ListTree, Columns3 } from 'lucide-react';
import client from '../api/client';
import {
  PageHeader, Panel, Badge, LoadingPanel, RefreshButton, SyncStatusChip, LastUpdated,
} from '../components/ui/primitives';
import { useTableControls, TableControls, SortTh, TablePager } from '../components/ui/tableTools';
import { useToast } from '../components/ui/Toaster';

// The v1 API's flag timestamp shows up as epoch seconds, ms, or µs depending
// on cluster version — normalize by magnitude.
function tsToDate(ts) {
  if (ts == null || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return null;
  let n = Number(ts);
  if (n > 1e14) n = n / 1000;      // µs → ms
  else if (n < 1e11) n = n * 1000; // s → ms
  return new Date(n);
}

function fmtTs(ts) {
  const d = tsToDate(ts);
  return d ? d.toISOString().slice(0, 10) : '—';
}

const CHANGE_TONE = { added: 'ok', modified: 'warn', removed: 'neutral' };

// Display-only: Cohesity service names come through as kBridge/kMagneto — drop
// the Hungarian k. Raw names stay in the DB and exports (support needs exact).
const serviceLabel = (s) => String(s || '').replace(/^k(?=[A-Z])/, '');

function ServiceGroup({ service, flags, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-cohesity-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-overlay text-left hover:text-ink transition-colors"
      >
        {open ? <ChevronDown size={14} className="text-ink-faint" /> : <ChevronRight size={14} className="text-ink-faint" />}
        <span className="text-sm font-semibold text-ink font-mono">{service}</span>
        <Badge tone="neutral">{flags.length} flag{flags.length === 1 ? '' : 's'}</Badge>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-ink-faint uppercase tracking-wide border-b border-cohesity-border">
                <th className="text-left py-2 px-3">Flag Name</th>
                <th className="text-left py-2 pr-3">Value</th>
                <th className="text-left py-2 pr-3 w-2/5">Reason</th>
                <th className="text-left py-2 pr-3">Set Date</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={`${f.clusterId}-${f.flagName}`} className="border-b border-cohesity-border/50 last:border-0 align-top">
                  <td className="py-2 px-3 font-mono text-xs text-ink whitespace-nowrap">{f.flagName}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-ink break-all">{f.flagValue ?? '—'}</td>
                  <td className="py-2 pr-3 text-xs text-ink-muted whitespace-pre-wrap">{f.reason || <span className="text-ink-faint">no reason recorded</span>}</td>
                  <td className="py-2 pr-3 text-xs text-ink-muted tnum whitespace-nowrap">{fmtTs(f.sourceTimestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CurrentTab({ data, clusterId }) {
  const [q, setQ] = useState('');

  const flags = useMemo(() => {
    let list = data?.gflags || [];
    if (clusterId) list = list.filter((f) => f.clusterId === clusterId);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter((f) =>
        String(f.flagName).toLowerCase().includes(term) ||
        String(f.reason || '').toLowerCase().includes(term) ||
        String(f.serviceName).toLowerCase().includes(term));
    }
    return list;
  }, [data, clusterId, q]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const f of flags) {
      const key = clusterId ? serviceLabel(f.serviceName) : `${f.clusterName} · ${serviceLabel(f.serviceName)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    }
    // Groups with a recently-set flag sort first and start expanded.
    const cutoff = Date.now() - 30 * 86400000;
    const newest = (rows) => Math.max(...rows.map((r) => tsToDate(r.sourceTimestamp)?.getTime() || 0));
    return [...map.entries()]
      .map(([service, rows]) => ({ service, rows, recent: newest(rows) >= cutoff }))
      .sort((a, b) => newest(b.rows) - newest(a.rows));
  }, [flags, clusterId]);

  if (!flags.length) {
    return (
      <Panel>
        <p className="text-sm text-ink-muted py-6 text-center">
          {q ? 'No gflags match your search.' : 'No gflags recorded yet — run a refresh, or this cluster simply has none set.'}
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search flag name or reason…"
            className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-sm text-ink focus:border-brand/60 outline-none"
          />
        </div>
        <span className="text-[11px] text-ink-faint tnum ml-auto">{flags.length} flag{flags.length === 1 ? '' : 's'}</span>
      </div>
      {groups.map((g) => (
        <ServiceGroup key={g.service} service={g.service} flags={g.rows} defaultOpen={g.recent || !!q} />
      ))}
    </div>
  );
}

const DAY_CHOICES = [
  { v: 7, label: 'Last 7 days' },
  { v: 30, label: 'Last 30 days' },
  { v: 90, label: 'Last 90 days' },
  { v: 365, label: 'Last year' },
  { v: 0, label: 'All time' },
];

function ChangesTab({ clusterId }) {
  const [changes, setChanges] = useState(null);
  const [days, setDays] = useState(90);

  useEffect(() => {
    const params = {};
    if (clusterId) params.clusterId = clusterId;
    if (days) params.days = days;
    client.get('/gflags/changes', { params })
      .then(({ data }) => setChanges(Array.isArray(data?.changes) ? data.changes : []))
      .catch(() => setChanges([]));
  }, [clusterId, days]);

  const rows = useMemo(
    () => (changes || []).map((c) => ({ ...c, serviceName: serviceLabel(c.serviceName) })),
    [changes]
  );

  const ctl = useTableControls(rows, {
    searchKeys: ['flagName', 'serviceName', 'clusterName', 'sourceReason', 'oldValue', 'newValue'],
    defaultSortKey: 'detectedAt',
    defaultSortDir: 'desc',
    paginate: true,
    defaultPageSize: 25,
  });

  if (changes === null) return <LoadingPanel label="Loading change history…" />;

  return (
    <Panel title="Change history" icon={History}
      actions={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer">
          {DAY_CHOICES.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
        </select>
      }>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Search flag, reason, value…"
        filters={[{ k: 'clusterName', label: 'clusters' }, { k: 'serviceName', label: 'services' }, { k: 'changeType', label: 'change types' }]} />
      {ctl.rows.length === 0 ? (
        <p className="text-sm text-ink-muted py-6 text-center">No gflag changes recorded in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-ink-faint border-b border-cohesity-border">
                <SortTh k="detectedAt" label="Detected" ctl={ctl} />
                <SortTh k="clusterName" label="Cluster" ctl={ctl} />
                <SortTh k="serviceName" label="Service" ctl={ctl} />
                <SortTh k="flagName" label="Flag" ctl={ctl} />
                <SortTh k="changeType" label="Change" ctl={ctl} />
                <th className="text-left py-2 pr-3 uppercase tracking-wide">Value</th>
                <th className="text-left py-2 pr-3 uppercase tracking-wide w-1/4">Reason</th>
              </tr>
            </thead>
            <tbody>
              {ctl.pageRows.map((c) => (
                <tr key={c.id} className="border-b border-cohesity-border/50 last:border-0 align-top">
                  <td className="py-2 pr-3 text-xs text-ink-muted tnum whitespace-nowrap">
                    {String(c.detectedAt).slice(0, 16).replace('T', ' ')}
                    {c.changeType === 'removed' && (
                      <span className="block text-[10px] text-ink-faint">removed sometime before this poll</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink whitespace-nowrap">{c.clusterName}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-ink-muted whitespace-nowrap">{c.serviceName}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-ink break-all">{c.flagName}</td>
                  <td className="py-2 pr-3"><Badge tone={CHANGE_TONE[c.changeType] || 'neutral'}>{c.changeType}</Badge></td>
                  <td className="py-2 pr-3 font-mono text-xs text-ink break-all">
                    {c.changeType === 'modified'
                      ? <>{c.oldValue ?? '—'} <span className="text-ink-faint">→</span> {c.newValue ?? '—'}</>
                      : (c.newValue ?? c.oldValue ?? '—')}
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink-muted whitespace-pre-wrap">{c.sourceReason || <span className="text-ink-faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TablePager ctl={ctl} />
        </div>
      )}
    </Panel>
  );
}

const clusterSelectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer';

function CompareTab({ data }) {
  const clusters = data?.clusters || [];
  const [primary, setPrimary] = useState(clusters[0]?.id || 0);
  const [others, setOthers] = useState([0, 0]); // up to two comparison clusters; 0 = none
  const [diffOnly, setDiffOnly] = useState(true);
  const [q, setQ] = useState('');

  // Dedupe in case a comparison pick later becomes the primary.
  const selected = [...new Set([primary, ...others].filter(Boolean))];
  const selectedNames = selected.map((id) => clusters.find((c) => c.id === id)?.name || `#${id}`);

  const rows = useMemo(() => {
    if (selected.length < 2) return [];
    const byCluster = new Map(selected.map((id) => [id, new Map()]));
    for (const f of data?.gflags || []) {
      const m = byCluster.get(f.clusterId);
      if (m) m.set(`${f.serviceName} ${f.flagName}`, f);
    }
    // Union of flags set on ANY selected cluster.
    const keys = new Map();
    for (const m of byCluster.values()) {
      for (const [k, f] of m) if (!keys.has(k)) keys.set(k, f);
    }
    const out = [];
    for (const [k, sample] of keys) {
      const values = selected.map((id) => byCluster.get(id).get(k)?.flagValue);
      const present = values.filter((v) => v !== undefined);
      const same = present.length === selected.length && present.every((v) => v === present[0]);
      out.push({
        key: k,
        service: sample.serviceName,
        flag: sample.flagName,
        reason: sample.reason,
        values,
        same,
      });
    }
    const term = q.trim().toLowerCase();
    return out
      .filter((r) => !diffOnly || !r.same)
      .filter((r) => !term
        || r.flag.toLowerCase().includes(term)
        || String(r.reason || '').toLowerCase().includes(term)
        || r.service.toLowerCase().includes(term))
      .sort((a, b) => (a.same === b.same ? (a.service + a.flag).localeCompare(b.service + b.flag) : a.same ? 1 : -1));
  }, [data, selected.join(','), diffOnly, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const diffCount = useMemo(() => rows.filter((r) => !r.same).length, [rows]);

  const setOther = (idx, val) => setOthers((o) => o.map((v, i) => (i === idx ? val : v)));
  const otherOptions = (idx) => clusters.filter(
    (c) => c.id !== primary && c.id !== others[(idx + 1) % 2]
  );

  return (
    <div className="space-y-3">
      <Panel title="Cluster comparison" icon={Columns3}>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <label className="text-xs text-ink-faint">Primary</label>
          <select value={primary} onChange={(e) => setPrimary(Number(e.target.value))} className={clusterSelectCls}>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="text-xs text-ink-faint ml-2">Compare with</label>
          {[0, 1].map((idx) => (
            <select key={idx} value={others[idx]} onChange={(e) => setOther(idx, Number(e.target.value))} className={clusterSelectCls}>
              <option value={0}>{idx === 0 ? 'Select cluster…' : 'Add another…'}</option>
              {otherOptions(idx).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
            <input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} className="accent-[#6CB33F]" />
            Differences only
          </label>
        </div>
        {selected.length < 2 ? (
          <p className="text-sm text-ink-muted py-6 text-center">Pick at least one cluster to compare against the primary.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search flag, service, or reason…"
                className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-sm text-ink focus:border-brand/60 outline-none"
              />
              <span className="text-[11px] text-ink-faint tnum ml-auto">
                {rows.length} flag{rows.length === 1 ? '' : 's'}{diffOnly ? ' differing' : ` (${diffCount} differing)`}
              </span>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-ink-muted py-6 text-center">
                {diffOnly ? 'No differences between the selected clusters.' : 'No flags set on the selected clusters.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-ink-faint uppercase tracking-wide border-b border-cohesity-border">
                      <th className="text-left py-2 pr-3">Service</th>
                      <th className="text-left py-2 pr-3">Flag</th>
                      {selectedNames.map((n, i) => (
                        <th key={i} className="text-left py-2 pr-3">
                          {n}{i === 0 && <span className="normal-case text-ink-faint font-normal ml-1">(primary)</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className="border-b border-cohesity-border/50 last:border-0 align-top">
                        <td className="py-2 pr-3 font-mono text-xs text-ink-muted whitespace-nowrap">{serviceLabel(r.service)}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-ink break-all" title={r.reason || undefined}>{r.flag}</td>
                        {r.values.map((v, i) => (
                          <td key={i} className={`py-2 pr-3 font-mono text-xs break-all ${
                            v === undefined ? 'text-ink-faint italic'
                              : r.same ? 'text-ink'
                              : v === r.values[0] ? 'text-ink' : 'text-status-warn'
                          }`}>
                            {v === undefined ? 'not set' : (v ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

export default function GflagsPage() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('current');
  const [clusterId, setClusterId] = useState(0); // 0 = all clusters
  const [refreshing, setRefreshing] = useState(false);
  const { toast } = useToast();

  const load = useCallback(() => client.get('/gflags')
    // A stale backend without this route serves the SPA shell with a 200 —
    // accept only the expected shape so that renders as empty, not a crash.
    .then(({ data }) => setData(Array.isArray(data?.clusters)
      ? { ...data, clusters: [...data.clusters].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' })) }
      : { clusters: [], gflags: [] }))
    .catch(() => setData({ clusters: [], gflags: [] })), []);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const params = clusterId ? { clusterId } : {};
      const { data: res } = await client.post('/gflags/refresh', {}, { params, timeout: 300000 });
      const failed = (res.results || []).filter((r) => r.error);
      const changed = (res.results || []).reduce((s, r) => s + (r.changes || 0), 0);
      if (failed.length) toast({ type: 'error', title: `Refresh failed for ${failed.map((f) => f.name).join(', ')}` });
      else toast({ type: 'success', title: changed ? `Refreshed — ${changed} change(s) detected` : 'Refreshed — no changes' });
      await load();
    } catch (err) {
      toast({ type: 'error', title: err.response?.data?.error || 'Gflag refresh failed' });
    } finally {
      setRefreshing(false);
    }
  };

  const exportCluster = async (format) => {
    try {
      const { data: blob } = await client.get('/gflags/export', {
        params: { clusterId, format }, responseType: 'blob',
      });
      const cluster = data?.clusters?.find((c) => c.id === clusterId);
      const safe = String(cluster?.name || 'cluster').replace(/[^A-Za-z0-9._-]/g, '_');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safe}-gflags-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ type: 'error', title: 'Export failed' });
    }
  };

  if (!data) return <LoadingPanel label="Loading gflags…" />;

  const anySyncing = data.clusters.some((c) => c.status?.isSyncing);
  const anyError = data.clusters.some((c) => c.status?.lastPollStatus === 'error');
  const newestEnd = data.clusters.map((c) => c.status?.lastPollEnd).filter(Boolean).sort().pop() || null;
  const chipState = anySyncing ? 'syncing' : anyError ? 'error' : 'live';

  const tabBtn = (key, label, Icon) => (
    <button
      onClick={() => setTab(key)}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
        tab === key ? 'border-brand/50 text-brand bg-brand/10' : 'border-cohesity-border text-ink-muted hover:text-ink'
      }`}
    >
      <Icon size={14} />{label}
    </button>
  );

  return (
    <div>
      <PageHeader
        icon={Flag}
        title="GFlags"
        description="Gflags explicitly set on your clusters (advanced/unsupported API, read-only). Polled daily — use Refresh for a live pull."
      >
        {data.clusters.length > 0 && <SyncStatusChip state={chipState} />}
        <LastUpdated date={newestEnd} />
        <select
          value={clusterId}
          onChange={(e) => setClusterId(Number(e.target.value))}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-2 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer"
        >
          <option value={0}>All clusters</option>
          {data.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {clusterId > 0 && (
          <>
            <button onClick={() => exportCluster('csv')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
              <Download size={14} /> CSV
            </button>
            <button onClick={() => exportCluster('json')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
              <Download size={14} /> JSON
            </button>
          </>
        )}
        <RefreshButton onClick={refresh} refreshing={refreshing} />
      </PageHeader>

      {data.clusters.length === 0 ? (
        <Panel>
          <p className="text-sm text-ink-muted py-6 text-center">
            No clusters registered yet — add a Helios or direct connection on the Clusters page.
          </p>
        </Panel>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-4">
            {tabBtn('current', 'Current Flags', ListTree)}
            {tabBtn('changes', 'Changes', History)}
            {tabBtn('compare', 'Compare', Columns3)}
          </div>
          {tab === 'current' && <CurrentTab data={data} clusterId={clusterId} />}
          {tab === 'changes' && <ChangesTab clusterId={clusterId} />}
          {tab === 'compare' && <CompareTab data={data} />}
        </>
      )}
    </div>
  );
}
