// NetApp Governance - ported from frontend/src/pages/netapp/NetAppGovernancePage.jsx.
// `behind`, `ontap_release` and `release` all come from the backend
// (../../backend/src/router.js handleGetGovernance), computed from the
// canonical parsed version - never recomputed here from the raw stored
// strings, which can differ in format (short "9.13.1P8" for AIQUM-sourced
// arrays vs the direct/node full "NetApp Release 9.13.1P8: <date>" form) for
// the exact same release. No host components (createPortal, react-router-dom
// hooks, tableTools) are imported - everything comes from this pack's own
// icons.jsx / ui.jsx, and React/ReactRouterDOM are window globals (see
// plugin-sdk/build.mjs).
import { ShieldCheck, HardDrive, Cpu, GitCommitVertical, Layers, X } from '../icons.jsx';
import {
  apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, Modal,
  BRAND, fmtBytes, fmtNum, statusTone, timeAgo, useTableControls, SortTh, TablePager, CsvExportButton,
} from '../ui.jsx';

const SECTIONS = ['filers', 'nodes', 'versions', 'models'];

function readFilters(sp) {
  return {
    q: sp.get('q') || '',
    version: sp.get('version') || '',
    model: sp.get('model') || '',
    source: sp.get('source') || '',
    state: sp.get('state') || '',
    behind: sp.get('behind') === '1',
    mixed: sp.get('mixed') === '1',
  };
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Icon size={15} className="text-brand" /> {title}</p>
      {children}
    </div>
  );
}

function NavChip({ count, tone }) {
  if (!count) return null;
  const bg = tone === 'crit' ? 'rgba(248,113,113,.15)' : tone === 'warn' ? 'rgba(251,191,36,.15)' : 'var(--na-surface-overlay)';
  const color = tone === 'crit' ? 'var(--na-crit)' : tone === 'warn' ? 'var(--na-warn)' : 'var(--na-ink-faint)';
  return (
    <span className="tnum text-[10px] font-semibold rounded-full px-1.5 py-0.5" style={{ background: bg, color }}>{count}</span>
  );
}

function CapacityBar({ usedBytes, totalBytes, pct }) {
  if (!totalBytes) return <span className="text-ink-faint text-[11px]">no data</span>;
  const p = pct != null ? pct : 0;
  const color = p >= 90 ? 'var(--na-crit)' : p >= 75 ? 'var(--na-warn)' : BRAND;
  return (
    <div className="flex items-center gap-2" style={{ minWidth: 140 }}>
      <div className="h-2 flex-1 rounded-full bg-surface-overlay overflow-hidden"><div className="h-full rounded-full" style={{ width: `${p}%`, backgroundColor: color }} /></div>
      <span className="text-[11px] tnum text-ink-muted w-16 text-right">{fmtBytes(usedBytes)} / {p}%</span>
    </div>
  );
}

function FilterChip({ label, onClear }) {
  return (
    <Badge tone="brand">
      {label}
      <button onClick={onClear} aria-label={`Clear ${label}`} style={{ marginLeft: 4, padding: 0, border: 'none', background: 'transparent', color: 'inherit', opacity: 0.7, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
        <X size={10} />
      </button>
    </Badge>
  );
}

// Shared search + dropdown filters for the Filers and Nodes tables. Values
// live in the URL query string so a filtered view can be shared.
function FilterBar({ filters, setFilter, clearFilter, clearAll, options, matchedCount, totalCount }) {
  const chips = [];
  if (filters.q) chips.push({ k: 'q', label: `"${filters.q}"` });
  if (filters.version) chips.push({ k: 'version', label: `Version: ${filters.version}` });
  if (filters.model) chips.push({ k: 'model', label: `Model: ${filters.model}` });
  if (filters.source) chips.push({ k: 'source', label: `Source: ${filters.source}` });
  if (filters.state) chips.push({ k: 'state', label: `State: ${filters.state}` });
  if (filters.behind) chips.push({ k: 'behind', label: 'Behind newest' });
  if (filters.mixed) chips.push({ k: 'mixed', label: 'Mixed versions' });

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
          placeholder="Search cluster, node, model, serial, version or host..."
          className="na-input"
          style={{ maxWidth: 320 }}
        />
        <select value={filters.version} onChange={(e) => setFilter('version', e.target.value)} className="na-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All versions</option>
          {options.versions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={filters.model} onChange={(e) => setFilter('model', e.target.value)} className="na-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All models</option>
          {options.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filters.source} onChange={(e) => setFilter('source', e.target.value)} className="na-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All sources</option>
          {options.sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.state} onChange={(e) => setFilter('state', e.target.value)} className="na-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All states</option>
          {options.states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
          <input type="checkbox" checked={filters.behind} onChange={(e) => setFilter('behind', e.target.checked)} className="accent-brand cursor-pointer" />
          Behind newest only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
          <input type="checkbox" checked={filters.mixed} onChange={(e) => setFilter('mixed', e.target.checked)} className="accent-brand cursor-pointer" />
          Mixed versions only
        </label>
        <span className="text-[11px] text-ink-faint tnum ml-auto">
          {matchedCount === totalCount ? `${totalCount} rows` : `${matchedCount} of ${totalCount} rows`}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {chips.map((c) => <FilterChip key={c.k} label={c.label} onClear={() => clearFilter(c.k)} />)}
          <button onClick={clearAll} className="text-[11px] text-ink-faint hover:text-ink underline cursor-pointer">Clear all</button>
        </div>
      )}
    </div>
  );
}

function ClusterDetailModal({ cluster, nodes, onClose }) {
  return (
    <Modal title={cluster.name} subtitle={`${cluster.mgmt_host} | ${cluster.source}`} icon={HardDrive} onClose={onClose} maxWidth="min(760px,92vw)">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-xs">
        <div><p className="text-[10px] uppercase tracking-wide text-ink-faint">ONTAP</p><p className="text-ink tnum" title={cluster.ontap_version || ''}>{cluster.ontap_release || '-'}</p></div>
        <div><p className="text-[10px] uppercase tracking-wide text-ink-faint">Capacity</p><p className="text-ink tnum">{fmtBytes(cluster.capacity_used_bytes)} / {fmtBytes(cluster.capacity_total_bytes)}</p></div>
        <div><p className="text-[10px] uppercase tracking-wide text-ink-faint">Volumes</p><p className="text-ink tnum">{fmtNum(cluster.volume_count)}</p></div>
        <div><p className="text-[10px] uppercase tracking-wide text-ink-faint">Open alerts</p><p className="text-ink tnum">{fmtNum(cluster.open_alert_count)}</p></div>
      </div>
      <p className="text-xs font-semibold text-ink mb-2">Nodes ({nodes.length})</p>
      <div className="overflow-x-auto mb-4">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            <th className="py-1.5 pr-3">Name</th><th className="py-1.5 pr-3">Model</th><th className="py-1.5 pr-3">Serial</th>
            <th className="py-1.5 pr-3">Version</th><th className="py-1.5 pr-3">State</th>
          </tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.name} className="border-b border-cohesity-border/40">
                <td className="py-1.5 pr-3 text-ink">{n.name}</td>
                <td className="py-1.5 pr-3 text-ink-muted">{n.model || '-'}</td>
                <td className="py-1.5 pr-3 text-ink-faint tnum">{n.serial_number || '-'}</td>
                <td className="py-1.5 pr-3 text-ink-muted" title={n.version || ''}>{n.release || '-'}</td>
                <td className="py-1.5 pr-3"><Badge tone={statusTone(n.state)}>{n.state || 'unknown'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReactRouterDOM.Link to="/netapp/hardware" className="text-xs text-brand hover:underline">View in NetApp Hardware &gt;</ReactRouterDOM.Link>
    </Modal>
  );
}

export default function GovernancePage() {
  const [searchParams, setSearchParams] = ReactRouterDOM.useSearchParams();
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailId, setDetailId] = React.useState(null);
  const [status, setStatus] = React.useState(null);

  const flash = (type, msg) => { setStatus({ type, msg }); setTimeout(() => setStatus((s) => (s?.msg === msg ? null : s)), 5000); };

  const rawSection = searchParams.get('section');
  const section = SECTIONS.includes(rawSection) ? rawSection : 'filers';
  const [filters, setFiltersState] = React.useState(() => readFilters(searchParams));

  const [loadError, setLoadError] = React.useState(null);

  // A failed request and an answer of the wrong shape are errors, never an
  // empty estate.
  const load = React.useCallback(() => apiFetch('/netapp/governance')
    .then((json) => {
      if (!json || typeof json !== 'object' || !Array.isArray(json.clusters)) {
        setData({});
        setLoadError('The server did not return governance data. The dashboard service may need a restart.');
        return;
      }
      setLoadError(null);
      setData(json);
      setLastRefreshed(new Date());
    })
    .catch((err) => {
      setData({});
      setLoadError(`Could not load governance data${err?.status ? ` (HTTP ${err.status})` : ''}: ${err?.message || 'request failed'}`);
      flash('error', 'Failed to load governance data');
    }), []);

  React.useEffect(() => { load(); }, [load]);

  // Filters + active section live in the URL so a filtered view is shareable.
  React.useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('section', section);
      for (const k of ['q', 'version', 'model', 'source', 'state']) {
        if (filters[k]) next.set(k, filters[k]); else next.delete(k);
      }
      if (filters.behind) next.set('behind', '1'); else next.delete('behind');
      if (filters.mixed) next.set('mixed', '1'); else next.delete('mixed');
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, filters]);

  const setSection = (id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('section', id);
      return next;
    }, { replace: true });
  };

  const setFilter = (k, v) => setFiltersState((f) => ({ ...f, [k]: v }));
  const clearFilter = (k) => setFiltersState((f) => ({ ...f, [k]: (k === 'behind' || k === 'mixed') ? false : '' }));
  const clearAll = () => setFiltersState({ q: '', version: '', model: '', source: '', state: '', behind: false, mixed: false });

  const jumpToVersion = (version) => { setFiltersState((f) => ({ ...f, version })); setSection('filers'); };
  const jumpToModel = (model) => { setFiltersState((f) => ({ ...f, model })); setSection('nodes'); };

  const rawClusters = data?.clusters || [];
  const rawNodes = data?.nodes || [];
  const versions = data?.versions || [];
  const models = data?.models || [];
  const newestVersion = data?.newest_version || null;
  const majorityVersion = data?.majority_version || null;
  const summary = data?.summary || null;

  const nodesByArray = React.useMemo(() => {
    const m = new Map();
    for (const n of rawNodes) {
      if (!m.has(n.array_id)) m.set(n.array_id, []);
      m.get(n.array_id).push(n);
    }
    return m;
  }, [rawNodes]);

  const clusters = React.useMemo(() => rawClusters.map((c) => ({
    ...c,
    node_states: [...new Set((nodesByArray.get(c.id) || []).map((n) => n.state).filter(Boolean))],
  })), [rawClusters, nodesByArray]);

  const clusterById = React.useMemo(() => new Map(clusters.map((c) => [c.id, c])), [clusters]);

  const nodes = React.useMemo(() => rawNodes.map((n) => {
    const cluster = clusterById.get(n.array_id);
    return {
      ...n,
      mgmt_host: cluster?.mgmt_host ?? null,
      source: cluster?.source ?? null,
      mixed_versions: cluster?.mixed_versions ?? false,
    };
  }), [rawNodes, clusterById]);

  const options = React.useMemo(() => ({
    versions: [...new Set(clusters.map((c) => c.ontap_release).concat(nodes.map((n) => n.release)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    models: [...new Set(nodes.map((n) => n.model).filter(Boolean))].sort(),
    sources: [...new Set(clusters.map((c) => c.source).filter(Boolean))].sort(),
    states: [...new Set(nodes.map((n) => n.state).filter(Boolean))].sort(),
  }), [clusters, nodes]);

  const term = filters.q.trim().toLowerCase();
  const filteredClusters = React.useMemo(() => clusters.filter((c) => {
    if (filters.version && c.ontap_release !== filters.version) return false;
    if (filters.model && !(c.models || []).includes(filters.model)) return false;
    if (filters.source && c.source !== filters.source) return false;
    if (filters.state && !(c.node_states || []).includes(filters.state)) return false;
    if (filters.behind && !c.behind) return false;
    if (filters.mixed && !c.mixed_versions) return false;
    if (term) {
      const hay = [c.name, c.mgmt_host, c.source, c.ontap_version, c.ontap_release, ...(c.models || []), ...(c.serials || []), ...(c.node_versions || [])];
      if (!hay.some((v) => String(v || '').toLowerCase().includes(term))) return false;
    }
    return true;
  }), [clusters, filters, term]);

  const filteredNodes = React.useMemo(() => nodes.filter((n) => {
    if (filters.version && n.release !== filters.version) return false;
    if (filters.model && n.model !== filters.model) return false;
    if (filters.source && n.source !== filters.source) return false;
    if (filters.state && n.state !== filters.state) return false;
    if (filters.behind && !n.behind) return false;
    if (filters.mixed && !n.mixed_versions) return false;
    if (term) {
      const hay = [n.array_name, n.name, n.model, n.serial_number, n.version, n.release, n.mgmt_host];
      if (!hay.some((v) => String(v || '').toLowerCase().includes(term))) return false;
    }
    return true;
  }), [nodes, filters, term]);

  const filerCtl = useTableControls(filteredClusters, { defaultSortKey: 'name', paginate: true });
  const nodeCtl = useTableControls(filteredNodes, { defaultSortKey: 'name', paginate: true });

  const nodesNeedingAttention = nodes.filter((n) => statusTone(n.state) !== 'ok').length;

  const nav = [
    { id: 'filers', label: 'Filers', icon: HardDrive, count: summary?.clusters_behind_newest || 0, tone: summary?.clusters_behind_newest ? 'warn' : 'default' },
    { id: 'nodes', label: 'Nodes', icon: Cpu, count: nodesNeedingAttention, tone: nodesNeedingAttention ? 'warn' : 'default' },
    { id: 'versions', label: 'Code levels', icon: GitCommitVertical, count: (summary?.distinct_versions || 0) > 1 ? summary.distinct_versions : 0, tone: (summary?.distinct_versions || 0) > 1 ? 'warn' : 'default' },
    { id: 'models', label: 'Models', icon: Layers, count: 0, tone: 'default' },
  ];

  const detailCluster = detailId ? clusterById.get(detailId) : null;

  if (data == null) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={ShieldCheck} title="NetApp Governance" description="Consolidated view of the whole ONTAP estate" />
        <LoadingPanel label="Loading governance..." height={300} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={ShieldCheck} title="NetApp Governance" description="Consolidated view of the whole ONTAP estate">
          <RefreshButton onClick={load} />
        </PageHeader>
        <div className="panel p-8 text-center text-sm text-status-crit" style={{ borderTop: `3px solid ${BRAND}` }}>
          {loadError}
        </div>
      </div>
    );
  }

  if (rawClusters.length === 0) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={ShieldCheck} title="NetApp Governance" description="Consolidated view of the whole ONTAP estate">
          <RefreshButton onClick={load} />
        </PageHeader>
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          ICC has no NetApp clusters on record yet. Clusters appear here once an AIQUM gateway or a direct
          cluster has been added under <ReactRouterDOM.Link to="/netapp/settings" className="text-brand hover:underline">Settings</ReactRouterDOM.Link> and polled.
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="NetApp Governance" description="Consolidated view of the whole ONTAP estate: filers, code levels and models">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {status && <p className="text-xs mb-3" style={{ color: status.type === 'error' ? 'var(--na-crit)' : 'var(--na-ok)' }}>{status.msg}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={HardDrive} label="Clusters" value={fmtNum(summary?.cluster_count)} tone="brand" />
        <StatCard icon={Cpu} label="Nodes" value={fmtNum(summary?.node_count)} />
        <StatCard icon={GitCommitVertical} label="Code levels" value={fmtNum(summary?.distinct_versions)}
          sub={newestVersion ? `newest ${newestVersion}${majorityVersion && majorityVersion !== newestVersion ? `, majority ${majorityVersion}` : ''}` : undefined} />
        <StatCard icon={Layers} label="Models" value={fmtNum(summary?.distinct_models)} />
      </div>

      <div className="flex gap-4 items-start">
        <div className="panel p-2 w-56 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSection(n.id)}
              className={`flex items-center gap-2 w-full text-left text-xs rounded-lg px-2.5 py-2 transition-colors cursor-pointer ${
                section === n.id ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay/60'
              }`}
            >
              <n.icon size={14} className={section === n.id ? 'text-brand' : 'text-ink-faint'} />
              <span className="truncate flex-1">{n.label}</span>
              <NavChip count={n.count} tone={n.tone} />
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {section === 'filers' && (
            <Section icon={HardDrive} title="Filers">
              <FilterBar filters={filters} setFilter={setFilter} clearFilter={clearFilter} clearAll={clearAll}
                options={options} matchedCount={filteredClusters.length} totalCount={clusters.length} />
              <div className="flex justify-end mb-2">
                <CsvExportButton filename="netapp-governance-filers" rows={filerCtl.rows} columns={[
                  { label: 'Cluster', get: 'name' }, { label: 'Source', get: 'source' },
                  { label: 'ONTAP', get: 'ontap_release' },
                  { label: 'Models', get: (c) => (c.models || []).join('; ') },
                  { label: 'Nodes', get: 'node_count' },
                  { label: 'Used (GB)', get: (c) => c.capacity_used_bytes != null ? (c.capacity_used_bytes / 1024 ** 3).toFixed(2) : '' },
                  { label: 'Total (GB)', get: (c) => c.capacity_total_bytes != null ? (c.capacity_total_bytes / 1024 ** 3).toFixed(2) : '' },
                  { label: 'Volumes', get: 'volume_count' }, { label: 'Disks', get: 'disk_count' },
                  { label: 'Open Alerts', get: 'open_alert_count' }, { label: 'Last Polled', get: 'last_polled' },
                ]} />
              </div>
              {filerCtl.rows.length === 0 ? (
                <div className="text-sm text-ink-muted py-8 text-center">No clusters match your filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <SortTh k="name" label="Cluster" ctl={filerCtl} />
                      <SortTh k="source" label="Source" ctl={filerCtl} />
                      <SortTh k="ontap_release" label="ONTAP" ctl={filerCtl} />
                      <th className="py-2 pr-3">Models</th>
                      <SortTh k="node_count" label="Nodes" ctl={filerCtl} align="right" />
                      <th className="py-2 pr-3">Capacity</th>
                      <SortTh k="volume_count" label="Volumes" ctl={filerCtl} align="right" />
                      <SortTh k="disk_count" label="Disks" ctl={filerCtl} align="right" />
                      <SortTh k="open_alert_count" label="Alerts" ctl={filerCtl} align="right" />
                      <SortTh k="last_polled" label="Last Polled" ctl={filerCtl} />
                    </tr></thead>
                    <tbody>
                      {filerCtl.pageRows.map((c) => (
                        <tr key={c.id} onClick={() => setDetailId(c.id)}
                          className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                          <td className="py-2 pr-3 text-ink font-medium">{c.name}</td>
                          <td className="py-2 pr-3 text-ink-muted">{c.source}</td>
                          <td className="py-2 pr-3">
                            <span className="text-ink-muted tnum" title={c.ontap_version || ''}>{c.ontap_release || '-'}</span>
                            {c.mixed_versions && <Badge tone="warn" className="ml-1.5">mixed</Badge>}
                            {c.behind && <Badge tone="info" className="ml-1.5">behind</Badge>}
                          </td>
                          <td className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[160px]" title={(c.models || []).join(', ')}>{(c.models || []).join(', ') || '-'}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.node_count)}</td>
                          <td className="py-2 pr-3"><CapacityBar usedBytes={c.capacity_used_bytes} totalBytes={c.capacity_total_bytes} pct={c.capacity_used_percent} /></td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.volume_count)}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">
                            {fmtNum(c.disk_count)}{c.disk_failed_count > 0 && <span className="text-status-crit ml-1">({c.disk_failed_count} failed)</span>}
                          </td>
                          <td className="py-2 pr-3 text-right tnum">{c.open_alert_count > 0 ? <Badge tone="crit">{c.open_alert_count}</Badge> : <span className="text-ink-faint">0</span>}</td>
                          <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">
                            {timeAgo(c.last_polled)}{c.poll_error && <Badge tone="crit" className="ml-1.5">poll error</Badge>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <TablePager ctl={filerCtl} />
            </Section>
          )}

          {section === 'nodes' && (
            <Section icon={Cpu} title="Nodes">
              <FilterBar filters={filters} setFilter={setFilter} clearFilter={clearFilter} clearAll={clearAll}
                options={options} matchedCount={filteredNodes.length} totalCount={nodes.length} />
              <div className="flex justify-end mb-2">
                <CsvExportButton filename="netapp-governance-nodes" rows={nodeCtl.rows} columns={[
                  { label: 'Cluster', get: 'array_name' }, { label: 'Node', get: 'name' }, { label: 'Model', get: 'model' },
                  { label: 'Serial', get: 'serial_number' }, { label: 'Version', get: 'release' }, { label: 'State', get: 'state' },
                ]} />
              </div>
              {nodeCtl.rows.length === 0 ? (
                <div className="text-sm text-ink-muted py-8 text-center">No nodes match your filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <SortTh k="array_name" label="Cluster" ctl={nodeCtl} />
                      <SortTh k="name" label="Node" ctl={nodeCtl} />
                      <SortTh k="model" label="Model" ctl={nodeCtl} />
                      <SortTh k="serial_number" label="Serial" ctl={nodeCtl} />
                      <SortTh k="release" label="Version" ctl={nodeCtl} />
                      <SortTh k="state" label="State" ctl={nodeCtl} />
                    </tr></thead>
                    <tbody>
                      {nodeCtl.pageRows.map((n) => (
                        <tr key={`${n.array_id}-${n.name}`} className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-3 text-ink-muted">{n.array_name}</td>
                          <td className="py-2 pr-3 text-ink">{n.name}</td>
                          <td className="py-2 pr-3 text-ink-muted">{n.model || '-'}</td>
                          <td className="py-2 pr-3 text-ink-faint tnum">{n.serial_number || '-'}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[11px]" title={n.version || ''}>{n.release || '-'}{n.behind && <Badge tone="info" className="ml-1.5">behind</Badge>}</td>
                          <td className="py-2 pr-3"><Badge tone={statusTone(n.state)}>{n.state || 'unknown'}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <TablePager ctl={nodeCtl} />
            </Section>
          )}

          {section === 'versions' && (
            <Section icon={GitCommitVertical} title="Code levels">
              {versions.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">No version data.</p>
              ) : (
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Version</th>
                      <th className="py-2 pr-3 text-right">Clusters</th>
                      <th className="py-2 pr-3 text-right">Nodes</th>
                      <th className="py-2 pr-3">Cluster names</th>
                    </tr></thead>
                    <tbody>
                      {versions.map((v) => (
                        <tr key={v.version} onClick={() => jumpToVersion(v.version)}
                          className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                          <td className="py-2 pr-3 text-ink tnum font-medium">
                            {v.version}
                            {v.version === newestVersion && <Badge tone="ok" className="ml-1.5">newest</Badge>}
                            {v.version === majorityVersion && <Badge tone="brand" className="ml-1.5">majority</Badge>}
                          </td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.cluster_count}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.node_count}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[320px]" title={(v.clusters || []).join(', ')}>{(v.clusters || []).join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {clusters.some((c) => c.mixed_versions) && (
                <div className="pt-3 border-t border-cohesity-border">
                  <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">Clusters with mixed node versions</p>
                  <div className="flex flex-wrap gap-1.5">
                    {clusters.filter((c) => c.mixed_versions).map((c) => <Badge key={c.id} tone="warn">{c.name}</Badge>)}
                  </div>
                </div>
              )}
            </Section>
          )}

          {section === 'models' && (
            <Section icon={Layers} title="Models">
              {models.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">No model data.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Model</th>
                      <th className="py-2 pr-3 text-right">Nodes</th>
                      <th className="py-2 pr-3 text-right">Clusters</th>
                      <th className="py-2 pr-3">Cluster names</th>
                    </tr></thead>
                    <tbody>
                      {models.map((m) => (
                        <tr key={m.model} onClick={() => jumpToModel(m.model)}
                          className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                          <td className="py-2 pr-3 text-ink font-medium">{m.model}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{m.node_count}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{m.cluster_count}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[320px]" title={(m.clusters || []).join(', ')}>{(m.clusters || []).join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}
        </div>
      </div>

      {detailCluster && (
        <ClusterDetailModal cluster={detailCluster} nodes={nodesByArray.get(detailCluster.id) || []} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}
