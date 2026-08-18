// Cohesity plugin — Hardware (Infrastructure) page. Ported from
// frontend/src/pages/HardwarePage.jsx.
import { apiFetch, useToast, PageHeader, Spinner, Pagination } from '../ui.jsx';
import { HardDrive } from '../icons.jsx';

function shortVersion(v) { return (!v || v === '—') ? '—' : v.split('_')[0]; }

function formatDisks(node) {
  const tiers = node.diskCountByTier;
  if (Array.isArray(tiers) && tiers.length > 0) {
    return tiers.map((t) => {
      const label = t.storageTier === 'PCIeSSD' ? 'SSD' : t.storageTier === 'SATA-HDD' ? 'HDD' : t.storageTier === 'SATA-SSD' ? 'SATA SSD' : t.storageTier;
      return `${t.diskCount} ${label}`;
    }).join(' / ');
  }
  return node.diskCount != null ? String(node.diskCount) : '—';
}

function deriveNodeState(node) {
  if (node.upgradeInProgress) return 'Upgrading';
  if (node.isMarkedForRemoval || (node.removalState && node.removalState !== 'kDontRemove')) return 'Removing';
  return 'Normal';
}

const STATE_COLOR = { Normal: 'var(--co-brand)', Upgrading: '#fbbf24', Removing: '#f87171' };

function SortTh({ label, field, sortField, sortDir, onSort }) {
  const active = sortField === field;
  return (
    <th onClick={() => onSort(field)} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--co-ink-muted)', textTransform: 'uppercase', letterSpacing: '.03em', cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {label}<span style={{ marginLeft: 4, opacity: 0.5 }}>{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
    </th>
  );
}

export default function HardwarePage() {
  const { toast } = useToast();
  const [nodeRows, setNodeRows] = React.useState([]);
  const [clusterCount, setClusterCount] = React.useState(0);
  const [loadedCount, setLoadedCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [clusterFilter, setClusterFilter] = React.useState('all');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [modelFilter, setModelFilter] = React.useState('all');
  const [sortField, setSortField] = React.useState('clusterName');
  const [sortDir, setSortDir] = React.useState('asc');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(25);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const clusters = await apiFetch('/cohesity/clusters');
      if (cancelled) return;
      setClusterCount(clusters.length);
      setNodeRows([]);
      setLoadedCount(0);
      await Promise.allSettled(clusters.map((cluster) =>
        apiFetch(`/cohesity/hardware/${cluster.id}`)
          .then((data) => {
            if (cancelled) return;
            const nodeList = Array.isArray(data) ? data : (data.nodes || []);
            const rows = nodeList.map((node) => ({
              clusterId: cluster.id,
              clusterName: cluster.name,
              ip: node.ip || node.ipAddress || '—',
              model: node.productModel || node._v2Model || node.hardwareModel || '—',
              serial: node.cohesityNodeSerial || node._v2Serial || node.serialNumber || '—',
              state: deriveNodeState(node),
              swVersion: shortVersion(node.nodeSoftwareVersion || node.softwareVersion || node.cohesityNodeInfo?.softwareVersion || ''),
              slotNumber: node.slotNumber ?? null,
              diskBreakdown: formatDisks(node),
              chassisSerial: node.chassisInfo?.chassisSerial || null,
            }));
            setNodeRows((prev) => [...prev, ...rows]);
          })
          .catch(() => {})
          .finally(() => { if (!cancelled) setLoadedCount((p) => p + 1); })
      ));
      if (!cancelled) setLoading(false);
    };
    load().catch((err) => { if (!cancelled) { setLoading(false); toast({ type: 'error', title: 'Hardware data load failed', message: err?.message }); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSort = (field) => {
    setSortField((prev) => { if (prev === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else setSortDir('asc'); return field; });
    setPage(0);
  };

  const clusterNames = React.useMemo(() => [...new Set(nodeRows.map((r) => r.clusterName))].sort(), [nodeRows]);
  const modelNames = React.useMemo(() => [...new Set(nodeRows.map((r) => r.model).filter((m) => m !== '—'))].sort(), [nodeRows]);

  const stateCounts = React.useMemo(() => {
    let normal = 0, upgrading = 0, removing = 0;
    for (const r of nodeRows) { if (r.state === 'Upgrading') upgrading++; else if (r.state === 'Removing') removing++; else normal++; }
    return { normal, upgrading, removing };
  }, [nodeRows]);

  const filtered = React.useMemo(() => {
    const q = search.toLowerCase();
    return nodeRows.filter((r) => {
      if (clusterFilter !== 'all' && r.clusterName !== clusterFilter) return false;
      if (modelFilter !== 'all' && r.model !== modelFilter) return false;
      if (statusFilter !== 'all' && r.state !== statusFilter) return false;
      if (q) { const hay = `${r.clusterName} ${r.ip} ${r.model} ${r.serial} ${r.chassisSerial || ''}`.toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
  }, [nodeRows, search, clusterFilter, modelFilter, statusFilter]);

  const sorted = React.useMemo(() => [...filtered].sort((a, b) => {
    const av = String(a[sortField] ?? '').toLowerCase();
    const bv = String(b[sortField] ?? '').toLowerCase();
    return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  }), [filtered, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const hasFilters = search || clusterFilter !== 'all' || statusFilter !== 'all' || modelFilter !== 'all';

  const th = { padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--co-ink-muted)', textTransform: 'uppercase', letterSpacing: '.03em' };
  const td = { padding: '10px 12px', fontSize: 12 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={HardDrive} title="Infrastructure" description={loading ? undefined : `${nodeRows.length} nodes across ${clusterCount} cluster${clusterCount !== 1 ? 's' : ''}`}>
        {loading && <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--co-ink-muted)' }} role="status"><Spinner size={13} /> Loading {loadedCount} / {clusterCount} clusters&hellip;</span>}
        {nodeRows.length > 0 && (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--co-ink-muted)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLOR.Normal }} />{stateCounts.normal} Normal</span>
            {stateCounts.upgrading > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLOR.Upgrading }} />{stateCounts.upgrading} Upgrading</span>}
            {stateCounts.removing > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLOR.Removing }} />{stateCounts.removing} Removing</span>}
          </div>
        )}
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input type="text" placeholder="Search IP, serial, model, chassis..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} className="co-input" style={{ width: 240 }} />
        <select value={clusterFilter} onChange={(e) => { setClusterFilter(e.target.value); setPage(0); }} className="co-input" style={{ width: 'auto' }}>
          <option value="all">All Clusters</option>
          {clusterNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {modelNames.length > 1 && (
          <select value={modelFilter} onChange={(e) => { setModelFilter(e.target.value); setPage(0); }} className="co-input" style={{ width: 'auto' }}>
            <option value="all">All Models</option>
            {modelNames.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }} className="co-input" style={{ width: 'auto' }}>
          <option value="all">All States</option><option value="Normal">Normal</option><option value="Upgrading">Upgrading</option><option value="Removing">Removing</option>
        </select>
        {hasFilters && <button onClick={() => { setSearch(''); setClusterFilter('all'); setStatusFilter('all'); setModelFilter('all'); setPage(0); }} className="co-btn-ghost">Clear</button>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--co-ink-faint)' }}>{filtered.length} node{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="panel" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--co-surface-base)', borderBottom: '1px solid var(--co-border)' }}>
              <tr>
                <SortTh label="Cluster" field="clusterName" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Node IP Address" field="ip" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Model" field="model" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Serial Number" field="serial" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Chassis S/N" field="chassisSerial" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <th style={th}>Status</th>
                <SortTh label="Slot" field="slotNumber" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="SW Version" field="swVersion" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <th style={th}>Disks</th>
              </tr>
            </thead>
            <tbody>
              {loading && nodeRows.length === 0 ? (
                [...Array(8)].map((_, i) => (
                  <tr key={i}>{[...Array(9)].map((_, j) => <td key={j} style={td}><div className="skeleton" style={{ height: 12, width: `${40 + (j * 17 + i * 11) % 45}%` }} /></td>)}</tr>
                ))
              ) : pageItems.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: 'var(--co-ink-faint)' }}>{hasFilters ? 'No nodes match the current filters.' : 'No node data available.'}</td></tr>
              ) : (
                pageItems.map((row, i) => (
                  <tr key={`${row.clusterId}-${row.ip}-${i}`} style={{ borderTop: '1px solid rgba(31,43,55,.5)' }}>
                    <td className="truncate" style={{ ...td, color: 'var(--co-ink)', fontWeight: 500, maxWidth: 160 }}>{row.clusterName}</td>
                    <td style={{ ...td, color: 'var(--co-ink)', fontFamily: 'monospace' }}>{row.ip}</td>
                    <td style={{ ...td, color: 'var(--co-ink-muted)' }}>{row.model}</td>
                    <td style={{ ...td, color: 'var(--co-ink-muted)', fontFamily: 'monospace' }}>{row.serial}</td>
                    <td style={{ ...td, color: 'var(--co-ink-faint)', fontFamily: 'monospace' }}>{row.chassisSerial || '—'}</td>
                    <td style={td}><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: STATE_COLOR[row.state], flexShrink: 0 }} /><span style={{ color: STATE_COLOR[row.state] }}>{row.state}</span></span></td>
                    <td style={{ ...td, color: 'var(--co-ink-faint)', textAlign: 'center' }}>{row.slotNumber ?? '—'}</td>
                    <td style={{ ...td, color: 'var(--co-ink-muted)', fontFamily: 'monospace' }}>{row.swVersion}</td>
                    <td style={{ ...td, color: 'var(--co-ink-faint)', whiteSpace: 'nowrap' }}>{row.diskBreakdown}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination page={safePage} totalPages={totalPages} pageSize={pageSize} totalItems={sorted.length} onPage={(p) => setPage(p)} onPageSize={(s) => { setPageSize(s); setPage(0); }} />
    </div>
  );
}
