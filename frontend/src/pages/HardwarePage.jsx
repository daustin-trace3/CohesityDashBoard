import { useEffect, useState, useMemo } from 'react';
import client from '../api/client';
import Pagination from '../components/Pagination';

function shortVersion(v) {
  if (!v || v === '—') return '—';
  return v.split('_')[0];
}

function formatDisks(node) {
  const tiers = node.diskCountByTier;
  if (Array.isArray(tiers) && tiers.length > 0) {
    return tiers.map(t => {
      const label = t.storageTier === 'PCIeSSD' ? 'SSD'
        : t.storageTier === 'SATA-HDD' ? 'HDD'
        : t.storageTier === 'SATA-SSD' ? 'SATA SSD'
        : t.storageTier;
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

const STATE_DOT  = { Normal: 'bg-cohesity-green', Upgrading: 'bg-amber-400', Removing: 'bg-red-500' };
const STATE_TEXT = { Normal: 'text-cohesity-green', Upgrading: 'text-amber-400', Removing: 'text-red-400' };

function SortTh({ label, field, sortField, sortDir, onSort }) {
  const active = sortField === field;
  return (
    <th
      className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide cursor-pointer select-none hover:text-cohesity-text whitespace-nowrap"
      onClick={() => onSort(field)}
    >
      {label}
      <span className="ml-1 opacity-50">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
    </th>
  );
}

export default function HardwarePage() {
  const [nodeRows, setNodeRows] = useState([]);
  const [clusterCount, setClusterCount] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [clusterFilter, setClusterFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [modelFilter, setModelFilter] = useState('all');

  const [sortField, setSortField] = useState('clusterName');
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data: clusters } = await client.get('/clusters');
      if (cancelled) return;
      setClusterCount(clusters.length);
      setNodeRows([]);
      setLoadedCount(0);

      await Promise.allSettled(
        clusters.map(cluster =>
          client.get(`/hardware/${cluster.id}`)
            .then(({ data }) => {
              if (cancelled) return;
              const nodeList = Array.isArray(data) ? data : (data.nodes || []);
              const rows = nodeList.map(node => ({
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
              setNodeRows(prev => [...prev, ...rows]);
            })
            .catch(() => {})
            .finally(() => { if (!cancelled) setLoadedCount(p => p + 1); })
        )
      );
      if (!cancelled) setLoading(false);
    };
    load().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const toggleSort = (field) => {
    setSortField(prev => {
      if (prev === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
      else { setSortDir('asc'); }
      return field;
    });
    setPage(0);
  };

  const clusterNames = useMemo(() => [...new Set(nodeRows.map(r => r.clusterName))].sort(), [nodeRows]);
  const modelNames = useMemo(() => [...new Set(nodeRows.map(r => r.model).filter(m => m !== '—'))].sort(), [nodeRows]);

  const stateCounts = useMemo(() => {
    let normal = 0, upgrading = 0, removing = 0;
    for (const r of nodeRows) {
      if (r.state === 'Upgrading') upgrading++;
      else if (r.state === 'Removing') removing++;
      else normal++;
    }
    return { normal, upgrading, removing };
  }, [nodeRows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return nodeRows.filter(r => {
      if (clusterFilter !== 'all' && r.clusterName !== clusterFilter) return false;
      if (modelFilter !== 'all' && r.model !== modelFilter) return false;
      if (statusFilter !== 'all' && r.state !== statusFilter) return false;
      if (q) {
        const haystack = `${r.clusterName} ${r.ip} ${r.model} ${r.serial} ${r.chassisSerial || ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [nodeRows, search, clusterFilter, modelFilter, statusFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = String(a[sortField] ?? '').toLowerCase();
      const bv = String(b[sortField] ?? '').toLowerCase();
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [filtered, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const hasFilters = search || clusterFilter !== 'all' || statusFilter !== 'all' || modelFilter !== 'all';

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-cohesity-text">Infrastructure</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {loading
              ? `Loading — ${loadedCount} / ${clusterCount} clusters`
              : `${nodeRows.length} nodes across ${clusterCount} cluster${clusterCount !== 1 ? 's' : ''}`}
          </p>
        </div>
        {nodeRows.length > 0 && (
          <div className="flex gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cohesity-green" />
              {stateCounts.normal} Normal
            </span>
            {stateCounts.upgrading > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                {stateCounts.upgrading} Upgrading
              </span>
            )}
            {stateCounts.removing > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                {stateCounts.removing} Removing
              </span>
            )}
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Search IP, serial, model, chassis..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0); }}
          className="bg-cohesity-gray border border-cohesity-border rounded px-3 py-1.5 text-xs text-cohesity-text placeholder-gray-500 focus:outline-none focus:border-cohesity-green w-60"
        />
        <select
          value={clusterFilter}
          onChange={e => { setClusterFilter(e.target.value); setPage(0); }}
          className="bg-cohesity-gray border border-cohesity-border rounded px-3 py-1.5 text-xs text-cohesity-text focus:outline-none focus:border-cohesity-green"
        >
          <option value="all">All Clusters</option>
          {clusterNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {modelNames.length > 1 && (
          <select
            value={modelFilter}
            onChange={e => { setModelFilter(e.target.value); setPage(0); }}
            className="bg-cohesity-gray border border-cohesity-border rounded px-3 py-1.5 text-xs text-cohesity-text focus:outline-none focus:border-cohesity-green"
          >
            <option value="all">All Models</option>
            {modelNames.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(0); }}
          className="bg-cohesity-gray border border-cohesity-border rounded px-3 py-1.5 text-xs text-cohesity-text focus:outline-none focus:border-cohesity-green"
        >
          <option value="all">All States</option>
          <option value="Normal">Normal</option>
          <option value="Upgrading">Upgrading</option>
          <option value="Removing">Removing</option>
        </select>
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setClusterFilter('all'); setStatusFilter('all'); setModelFilter('all'); setPage(0); }}
            className="text-xs text-gray-400 hover:text-cohesity-text transition-colors px-2 py-1.5 border border-cohesity-border rounded"
          >
            Clear
          </button>
        )}
        <span className="ml-auto text-xs text-gray-500">
          {filtered.length} node{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cohesity-black border-b border-cohesity-border">
              <tr>
                <SortTh label="Cluster" field="clusterName" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="IP Address" field="ip" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Model" field="model" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Serial Number" field="serial" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="Chassis S/N" field="chassisSerial" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Status</th>
                <SortTh label="Slot" field="slotNumber" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <SortTh label="SW Version" field="swVersion" sortField={sortField} sortDir={sortDir} onSort={toggleSort} />
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">Disks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cohesity-border">
              {loading && nodeRows.length === 0 ? (
                [...Array(8)].map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    {[...Array(9)].map((_, j) => (
                      <td key={j} className="px-3 py-3">
                        <div className="h-3 rounded bg-cohesity-border" style={{ width: `${40 + (j * 17 + i * 11) % 45}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : pageItems.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-gray-500">
                    {hasFilters ? 'No nodes match the current filters.' : 'No node data available.'}
                  </td>
                </tr>
              ) : (
                pageItems.map((row, i) => (
                    <tr key={`${row.clusterId}-${row.ip}-${i}`} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-3 py-2.5 text-cohesity-text font-medium max-w-[160px] truncate">{row.clusterName}</td>
                      <td className="px-3 py-2.5 text-cohesity-text font-mono">{row.ip}</td>
                      <td className="px-3 py-2.5 text-gray-300">{row.model}</td>
                      <td className="px-3 py-2.5 text-gray-300 font-mono">{row.serial}</td>
                      <td className="px-3 py-2.5 text-gray-400 font-mono">{row.chassisSerial || '—'}</td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATE_DOT[row.state]}`} />
                          <span className={STATE_TEXT[row.state]}>{row.state}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-gray-400 text-center">{row.slotNumber ?? '—'}</td>
                      <td className="px-3 py-2.5 text-gray-300 font-mono">{row.swVersion}</td>
                      <td className="px-3 py-2.5 text-gray-400 whitespace-nowrap">{row.diskBreakdown}</td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination
        page={safePage}
        totalPages={totalPages}
        pageSize={pageSize}
        totalItems={sorted.length}
        onPage={p => setPage(p)}
        onPageSize={s => { setPageSize(s); setPage(0); }}
      />
    </div>
  );
}
