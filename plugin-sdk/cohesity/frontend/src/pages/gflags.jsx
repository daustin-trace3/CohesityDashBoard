// Cohesity plugin — GFlags page. Ported from frontend/src/pages/GflagsPage.jsx.
import {
  apiFetch, apiFetchBlob, useToast, downloadBlob,
  PageHeader, Panel, Badge, LoadingPanel, RefreshButton, SyncStatusChip, LastUpdated,
  useTableControls, TableControls, SortTh, TablePager,
} from '../ui.jsx';
import { Flag, ChevronDown, ChevronRight, Download, History, ListTree, Columns3 } from '../icons.jsx';

function tsToDate(ts) {
  if (ts == null || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return null;
  let n = Number(ts);
  if (n > 1e14) n = n / 1000;
  else if (n < 1e11) n = n * 1000;
  return new Date(n);
}
function fmtTs(ts) { const d = tsToDate(ts); return d ? d.toISOString().slice(0, 10) : '—'; }

const CHANGE_TONE = { added: 'ok', modified: 'warn', removed: 'neutral' };
const serviceLabel = (s) => String(s || '').replace(/^k(?=[A-Z])/, '');

function ServiceGroup({ service, flags, defaultOpen }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div style={{ border: '1px solid var(--co-border)', borderRadius: 8, overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--co-surface-overlay)', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        {open ? <ChevronDown size={14} style={{ color: 'var(--co-ink-faint)' }} /> : <ChevronRight size={14} style={{ color: 'var(--co-ink-faint)' }} />}
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', fontFamily: 'monospace' }}>{service}</span>
        <Badge tone="neutral">{flags.length} flag{flags.length === 1 ? '' : 's'}</Badge>
      </button>
      {open && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead><tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--co-border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Flag Name</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Value</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', width: '40%' }}>Reason</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Set Date</th>
            </tr></thead>
            <tbody>
              {flags.map((f) => (
                <tr key={`${f.clusterId}-${f.flagName}`} style={{ borderBottom: '1px solid rgba(31,43,55,.5)', verticalAlign: 'top' }}>
                  <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12, color: 'var(--co-ink)', whiteSpace: 'nowrap' }}>{f.flagName}</td>
                  <td className="break-all" style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12, color: 'var(--co-ink)' }}>{f.flagValue ?? '—'}</td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink-muted)', whiteSpace: 'pre-wrap' }}>{f.reason || <span style={{ color: 'var(--co-ink-faint)' }}>no reason recorded</span>}</td>
                  <td className="tnum" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink-muted)', whiteSpace: 'nowrap' }}>{fmtTs(f.sourceTimestamp)}</td>
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
  const [q, setQ] = React.useState('');
  const flags = React.useMemo(() => {
    let list = data?.gflags || [];
    if (clusterId) list = list.filter((f) => f.clusterId === clusterId);
    const term = q.trim().toLowerCase();
    if (term) list = list.filter((f) => String(f.flagName).toLowerCase().includes(term) || String(f.reason || '').toLowerCase().includes(term) || String(f.serviceName).toLowerCase().includes(term));
    return list;
  }, [data, clusterId, q]);

  const groups = React.useMemo(() => {
    const map = new Map();
    for (const f of flags) {
      const key = clusterId ? serviceLabel(f.serviceName) : `${f.clusterName} · ${serviceLabel(f.serviceName)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    }
    const cutoff = Date.now() - 30 * 86400000;
    const newest = (rows) => Math.max(...rows.map((r) => tsToDate(r.sourceTimestamp)?.getTime() || 0));
    return [...map.entries()].map(([service, rows]) => ({ service, rows, recent: newest(rows) >= cutoff })).sort((a, b) => newest(b.rows) - newest(a.rows));
  }, [flags, clusterId]);

  if (!flags.length) return <Panel><p style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>{q ? 'No gflags match your search.' : 'No gflags recorded yet — run a refresh, or this cluster simply has none set.'}</p></Panel>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search flag name or reason…" className="co-input" style={{ width: '100%', maxWidth: 320 }} />
        <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginLeft: 'auto' }}>{flags.length} flag{flags.length === 1 ? '' : 's'}</span>
      </div>
      {groups.map((g) => <ServiceGroup key={g.service} service={g.service} flags={g.rows} defaultOpen={g.recent || !!q} />)}
    </div>
  );
}

const DAY_CHOICES = [{ v: 7, label: 'Last 7 days' }, { v: 30, label: 'Last 30 days' }, { v: 90, label: 'Last 90 days' }, { v: 365, label: 'Last year' }, { v: 0, label: 'All time' }];

function ChangesTab({ clusterId }) {
  const [changes, setChanges] = React.useState(null);
  const [days, setDays] = React.useState(90);

  React.useEffect(() => {
    const params = new URLSearchParams();
    if (clusterId) params.set('clusterId', clusterId);
    if (days) params.set('days', days);
    apiFetch(`/cohesity/gflags/changes?${params}`).then((data) => setChanges(Array.isArray(data?.changes) ? data.changes : [])).catch(() => setChanges([]));
  }, [clusterId, days]);

  const rows = React.useMemo(() => (changes || []).map((c) => ({ ...c, serviceName: serviceLabel(c.serviceName) })), [changes]);
  const ctl = useTableControls(rows, { searchKeys: ['flagName', 'serviceName', 'clusterName', 'sourceReason', 'oldValue', 'newValue'], defaultSortKey: 'detectedAt', defaultSortDir: 'desc', paginate: true, defaultPageSize: 25 });

  if (changes === null) return <LoadingPanel label="Loading change history…" />;

  return (
    <Panel title="Change history" icon={History} actions={
      <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
        {DAY_CHOICES.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
      </select>
    }>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Search flag, reason, value…" filters={[{ k: 'clusterName', label: 'clusters' }, { k: 'serviceName', label: 'services' }, { k: 'changeType', label: 'change types' }]} />
      {ctl.rows.length === 0 ? <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No gflag changes recorded in this window.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead><tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)' }}>
              <SortTh k="detectedAt" label="Detected" ctl={ctl} />
              <SortTh k="clusterName" label="Cluster" ctl={ctl} />
              <SortTh k="serviceName" label="Service" ctl={ctl} />
              <SortTh k="flagName" label="Flag" ctl={ctl} />
              <SortTh k="changeType" label="Change" ctl={ctl} />
              <th style={{ textAlign: 'left', padding: '8px 12px', textTransform: 'uppercase' }}>Value</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', textTransform: 'uppercase', width: '25%' }}>Reason</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid rgba(31,43,55,.5)', verticalAlign: 'top' }}>
                  <td className="tnum" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink-muted)', whiteSpace: 'nowrap' }}>
                    {String(c.detectedAt).slice(0, 16).replace('T', ' ')}
                    {c.changeType === 'removed' && <span style={{ display: 'block', fontSize: 10, color: 'var(--co-ink-faint)' }}>removed sometime before this poll</span>}
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink)', whiteSpace: 'nowrap' }}>{c.clusterName}</td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink-muted)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{c.serviceName}</td>
                  <td className="break-all" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink)', fontFamily: 'monospace' }}>{c.flagName}</td>
                  <td style={{ padding: '8px 12px' }}><Badge tone={CHANGE_TONE[c.changeType] || 'neutral'}>{c.changeType}</Badge></td>
                  <td className="break-all" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink)', fontFamily: 'monospace' }}>
                    {c.changeType === 'modified' ? <>{c.oldValue ?? '—'} <span style={{ color: 'var(--co-ink-faint)' }}>→</span> {c.newValue ?? '—'}</> : (c.newValue ?? c.oldValue ?? '—')}
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--co-ink-muted)', whiteSpace: 'pre-wrap' }}>{c.sourceReason || <span style={{ color: 'var(--co-ink-faint)' }}>—</span>}</td>
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

function CompareTab({ data }) {
  const clusters = data?.clusters || [];
  const [primary, setPrimary] = React.useState(clusters[0]?.id || 0);
  const [others, setOthers] = React.useState([0, 0]);
  const [diffOnly, setDiffOnly] = React.useState(true);
  const [q, setQ] = React.useState('');

  const selected = [...new Set([primary, ...others].filter(Boolean))];
  const selectedNames = selected.map((id) => clusters.find((c) => c.id === id)?.name || `#${id}`);

  const rows = React.useMemo(() => {
    if (selected.length < 2) return [];
    const byCluster = new Map(selected.map((id) => [id, new Map()]));
    for (const f of data?.gflags || []) { const m = byCluster.get(f.clusterId); if (m) m.set(`${f.serviceName} ${f.flagName}`, f); }
    const keys = new Map();
    for (const m of byCluster.values()) for (const [k, f] of m) if (!keys.has(k)) keys.set(k, f);
    const out = [];
    for (const [k, sample] of keys) {
      const values = selected.map((id) => byCluster.get(id).get(k)?.flagValue);
      const present = values.filter((v) => v !== undefined);
      const same = present.length === selected.length && present.every((v) => v === present[0]);
      out.push({ key: k, service: sample.serviceName, flag: sample.flagName, reason: sample.reason, values, same });
    }
    const term = q.trim().toLowerCase();
    return out.filter((r) => !diffOnly || !r.same)
      .filter((r) => !term || r.flag.toLowerCase().includes(term) || String(r.reason || '').toLowerCase().includes(term) || r.service.toLowerCase().includes(term))
      .sort((a, b) => (a.same === b.same ? (a.service + a.flag).localeCompare(b.service + b.flag) : a.same ? 1 : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selected.join(','), diffOnly, q]);

  const diffCount = React.useMemo(() => rows.filter((r) => !r.same).length, [rows]);
  const setOther = (idx, val) => setOthers((o) => o.map((v, i) => (i === idx ? val : v)));
  const otherOptions = (idx) => clusters.filter((c) => c.id !== primary && c.id !== others[(idx + 1) % 2]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title="Cluster comparison" icon={Columns3}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <label style={{ fontSize: 12, color: 'var(--co-ink-faint)' }}>Primary</label>
          <select value={primary} onChange={(e) => setPrimary(Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label style={{ fontSize: 12, color: 'var(--co-ink-faint)', marginLeft: 8 }}>Compare with</label>
          {[0, 1].map((idx) => (
            <select key={idx} value={others[idx]} onChange={(e) => setOther(idx, Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
              <option value={0}>{idx === 0 ? 'Select cluster…' : 'Add another…'}</option>
              {otherOptions(idx).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ))}
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--co-ink-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} className="accent-brand" /> Differences only
          </label>
        </div>
        {selected.length < 2 ? <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>Pick at least one cluster to compare against the primary.</p> : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search flag, service, or reason…" className="co-input" style={{ width: '100%', maxWidth: 320 }} />
              <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginLeft: 'auto' }}>{rows.length} flag{rows.length === 1 ? '' : 's'}{diffOnly ? ' differing' : ` (${diffCount} differing)`}</span>
            </div>
            {rows.length === 0 ? <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>{diffOnly ? 'No differences between the selected clusters.' : 'No flags set on the selected clusters.'}</p> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead><tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--co-border)' }}>
                    <th style={{ textAlign: 'left', padding: '8px 12px' }}>Service</th>
                    <th style={{ textAlign: 'left', padding: '8px 12px' }}>Flag</th>
                    {selectedNames.map((n, i) => <th key={i} style={{ textAlign: 'left', padding: '8px 12px' }}>{n}{i === 0 && <span style={{ textTransform: 'none', color: 'var(--co-ink-faint)', fontWeight: 400, marginLeft: 4 }}>(primary)</span>}</th>)}
                  </tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} style={{ borderBottom: '1px solid rgba(31,43,55,.5)', verticalAlign: 'top' }}>
                        <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12, color: 'var(--co-ink-muted)', whiteSpace: 'nowrap' }}>{serviceLabel(r.service)}</td>
                        <td className="break-all" style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12, color: 'var(--co-ink)' }} title={r.reason || undefined}>{r.flag}</td>
                        {r.values.map((v, i) => (
                          <td key={i} className="break-all" style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12, color: v === undefined ? 'var(--co-ink-faint)' : r.same ? 'var(--co-ink)' : v === r.values[0] ? 'var(--co-ink)' : 'var(--co-warn)', fontStyle: v === undefined ? 'italic' : 'normal' }}>
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
  const [data, setData] = React.useState(null);
  const [tab, setTab] = React.useState('current');
  const [clusterId, setClusterId] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const { toast } = useToast();

  const load = React.useCallback(() => apiFetch('/cohesity/gflags')
    .then((data) => setData(Array.isArray(data?.clusters)
      ? { ...data, clusters: [...data.clusters].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' })) }
      : { clusters: [], gflags: [] }))
    .catch(() => setData({ clusters: [], gflags: [] })), []);

  React.useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const params = clusterId ? `?clusterId=${clusterId}` : '';
      const res = await apiFetch(`/cohesity/gflags/refresh${params}`, { method: 'POST' });
      const failed = (res.results || []).filter((r) => r.error);
      const changed = (res.results || []).reduce((s, r) => s + (r.changes || 0), 0);
      if (failed.length) toast({ type: 'error', title: `Refresh failed for ${failed.map((f) => f.name).join(', ')}` });
      else toast({ type: 'success', title: changed ? `Refreshed — ${changed} change(s) detected` : 'Refreshed — no changes' });
      await load();
    } catch (err) { toast({ type: 'error', title: err.payload?.error || 'Gflag refresh failed' }); }
    finally { setRefreshing(false); }
  };

  const exportCluster = async (format) => {
    try {
      const blob = await apiFetchBlob(`/cohesity/gflags/export?clusterId=${clusterId}&format=${format}`);
      const cluster = data?.clusters?.find((c) => c.id === clusterId);
      const safe = String(cluster?.name || 'cluster').replace(/[^A-Za-z0-9._-]/g, '_');
      downloadBlob(blob, `${safe}-gflags-${new Date().toISOString().slice(0, 10)}.${format}`);
    } catch { toast({ type: 'error', title: 'Export failed' }); }
  };

  if (!data) return <LoadingPanel label="Loading gflags…" />;

  const anySyncing = data.clusters.some((c) => c.status?.isSyncing);
  const anyError = data.clusters.some((c) => c.status?.lastPollStatus === 'error');
  const newestEnd = data.clusters.map((c) => c.status?.lastPollEnd).filter(Boolean).sort().pop() || null;
  const chipState = anySyncing ? 'syncing' : anyError ? 'error' : 'live';

  const tabBtn = (key, label, Icon) => (
    <button onClick={() => setTab(key)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: `1px solid ${tab === key ? 'rgba(108,179,63,0.5)' : 'var(--co-border)'}`, background: tab === key ? 'rgba(108,179,63,0.1)' : 'transparent', color: tab === key ? 'var(--co-brand)' : 'var(--co-ink-muted)', cursor: 'pointer' }}>
      <Icon size={14} />{label}
    </button>
  );

  return (
    <div>
      <PageHeader icon={Flag} title="GFlags" description="Gflags explicitly set on your clusters (advanced/unsupported API, read-only). Polled daily — use Refresh for a live pull.">
        {data.clusters.length > 0 && <SyncStatusChip state={chipState} />}
        <LastUpdated date={newestEnd} />
        <select value={clusterId} onChange={(e) => setClusterId(Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
          <option value={0}>All clusters</option>
          {data.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {clusterId > 0 && (
          <>
            <button onClick={() => exportCluster('csv')} className="co-btn-ghost"><Download size={14} /> CSV</button>
            <button onClick={() => exportCluster('json')} className="co-btn-ghost"><Download size={14} /> JSON</button>
          </>
        )}
        <RefreshButton onClick={refresh} refreshing={refreshing} />
      </PageHeader>

      {data.clusters.length === 0 ? (
        <Panel><p style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No clusters registered yet — add a Helios or direct connection on the Clusters page.</p></Panel>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
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
