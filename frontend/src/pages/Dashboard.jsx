import { useEffect, useState, useCallback, useRef } from 'react';
import client from '../api/client';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  Title, Tooltip as ChartTooltip, Legend, Filler, ArcElement
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';
import ZoomPlugin from 'chartjs-plugin-zoom';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, ChartTooltip, Legend, Filler, ArcElement, ZoomPlugin);
import { useSearch } from '../App';
import ClusterCard from '../components/ClusterCard';
import SkeletonCard from '../components/SkeletonCard';
import EmptyState, { ClusterEmptyIcon } from '../components/EmptyState';
import Pagination from '../components/Pagination';

function toTB(bytes) {
  if (!bytes) return 0;
  return parseFloat((bytes / 1e12).toFixed(2));
}

function getAlertTimestamp(alert) {
  return alert.first_seen || alert.last_updated || alert.triggered_at || alert.created_at;
}

// --- Sub-components ---

function GlobalStorageCard({ latestMetrics, clusters }) {
  const entries = clusters.map(c => latestMetrics[c.id]).filter(Boolean);
  const totalUsed = entries.reduce((s, m) => s + (m.used_bytes || 0), 0);
  const totalCap = entries.reduce((s, m) => s + (m.total_capacity_bytes || 0), 0);
  const drValues = entries.map(m => m.data_reduction_ratio).filter(v => v != null && v > 0);
  const avgDR = drValues.length > 0 ? drValues.reduce((s, v) => s + v, 0) / drValues.length : 0;

  const pct = totalCap > 0 ? (totalUsed / totalCap) * 100 : 0;
  const pctStr = pct.toFixed(1);
  const fmtBytes = (b) => {
    if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
    if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
    if (b >= 1e9)  return (b / 1e9).toFixed(2) + ' GB';
    return (b / 1e6).toFixed(1) + ' MB';
  };
  const usedStr = fmtBytes(totalUsed);
  const totalStr = fmtBytes(totalCap);

  const donutData = {
    datasets: [{
      data: [totalUsed, Math.max(0, totalCap - totalUsed)],
      backgroundColor: ['#6CB33F', '#3D3D3D'],
      borderWidth: 0,
    }]
  };

  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <p className="text-xs font-semibold text-cohesity-text mb-3">Total Storage Used (Global)</p>
      <div className="flex items-center gap-4">
        <div className="relative flex-shrink-0" style={{ width: 100, height: 100 }}>
          <Doughnut
            data={donutData}
            options={{
              cutout: '70%',
              maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: { enabled: false } }
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sm font-bold text-cohesity-text">{pctStr}%</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs text-cohesity-text font-medium">{usedStr} Used / {totalStr} Total</p>
          <p className="text-[10px] text-gray-400">Data Reduction: {avgDR.toFixed(1)}x</p>
          <p className="text-[10px] text-gray-500">{entries.length} cluster(s) reporting</p>
        </div>
      </div>
    </div>
  );
}

function TopClustersBar({ chartData }) {
  const top10 = chartData.slice(0, 10);
  const barData = {
    labels: top10.map(d => d.name),
    datasets: [{
      label: '% Used',
      data: top10.map(d => d.pct),
      backgroundColor: top10.map(d => d.pct >= 86 ? '#ef4444' : d.pct >= 70 ? '#f59e0b' : '#6CB33F'),
    }]
  };
  const options = {
    indexAxis: 'y',
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#2C2C2C', borderColor: '#3D3D3D', borderWidth: 1,
        titleColor: '#E5E5E5', bodyColor: '#9ca3af',
        callbacks: { label: (item) => item.parsed.x.toFixed(1) + '% Used' }
      }
    },
    scales: {
      x: {
        max: 100,
        ticks: { color: '#6b7280', font: { size: 9 }, callback: v => v + '%' },
        grid: { color: '#3D3D3D' },
      },
      y: {
        ticks: { color: '#6b7280', font: { size: 9 } },
        grid: { color: '#3D3D3D' },
      }
    }
  };
  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <p className="text-xs font-semibold text-cohesity-text mb-3">Top Clusters by Capacity Used</p>
      <div style={{ height: 220 }}>
        {top10.length > 0 ? (
          <Bar data={barData} options={options} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-xs">No data</div>
        )}
      </div>
    </div>
  );
}

function StorageDistributionTable({ sortedFiltered, latestMetrics }) {
  const rows = [...sortedFiltered]
    .filter(c => latestMetrics[c.id]?.used_bytes > 0)
    .sort((a, b) => {
      const mA = latestMetrics[a.id]; const mB = latestMetrics[b.id];
      const pA = mA?.total_capacity_bytes > 0 ? mA.used_bytes / mA.total_capacity_bytes : 0;
      const pB = mB?.total_capacity_bytes > 0 ? mB.used_bytes / mB.total_capacity_bytes : 0;
      return pB - pA;
    })
    .slice(0, 10);

  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <p className="text-xs font-semibold text-cohesity-text mb-3">Storage Distribution</p>
      <div className="overflow-y-auto" style={{ maxHeight: 256 }}>
        <table className="w-full text-[10px] text-gray-400">
          <thead className="sticky top-0 bg-cohesity-gray">
            <tr>
              <th className="text-left px-1 py-1 font-medium">Cluster</th>
              <th className="text-right px-1 py-1 font-medium">Used TB</th>
              <th className="text-right px-1 py-1 font-medium">Total TB</th>
              <th className="text-right px-1 py-1 font-medium">% Used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const m = latestMetrics[c.id];
              const used = toTB(m?.used_bytes);
              const total = toTB(m?.total_capacity_bytes);
              const pct = total > 0 ? (used / total) * 100 : 0;
              const pctColor = pct >= 86 ? 'text-red-400' : pct >= 70 ? 'text-amber-400' : 'text-green-400';
              return (
                <tr key={c.id} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                  <td className="px-1 py-1 truncate max-w-[100px]">{c.name}</td>
                  <td className="text-right px-1 py-1">{used.toFixed(2)}</td>
                  <td className="text-right px-1 py-1">{total.toFixed(2)}</td>
                  <td className={`text-right px-1 py-1 font-medium ${pctColor}`}>{pct.toFixed(1)}%</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="text-center py-4 text-gray-500">No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AlertDetailModal({ alert, onClose }) {
  if (!alert) return null;
  const fmtTime = (ts) => {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  };
  const severity = alert.severity || 'info';
  const sevColor = severity === 'critical' ? 'text-red-400' : severity === 'warning' ? 'text-amber-400' : 'text-blue-400';
  const msg = alert.message || alert.description || '';
  // Scale modal width: short < 120 chars → 480px, medium < 300 → 680px, long → 860px, capped at 90vw
  const modalMaxW = msg.length > 300 ? 'min(860px,90vw)' : msg.length > 120 ? 'min(680px,90vw)' : 'min(520px,90vw)';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-cohesity-gray border border-cohesity-border rounded-lg p-6 shadow-2xl"
        style={{ width: modalMaxW }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-sm font-semibold text-cohesity-text">{alert.alert_type || 'Alert'}</p>
            <p className={`text-xs font-medium uppercase mt-0.5 ${sevColor}`}>{severity}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-cohesity-text text-lg leading-none ml-4 flex-shrink-0">✕</button>
        </div>
        <div className="flex flex-col gap-2.5 text-xs">
          <div className="flex gap-3"><span className="text-gray-500 w-20 flex-shrink-0">Cluster</span><span className="text-cohesity-text">{alert.cluster_name || alert.cluster_id || '—'}</span></div>
          <div className="flex gap-3"><span className="text-gray-500 w-20 flex-shrink-0">Triggered</span><span className="text-cohesity-text">{fmtTime(getAlertTimestamp(alert))}</span></div>
          {alert.resolved_at && <div className="flex gap-3"><span className="text-gray-500 w-20 flex-shrink-0">Resolved</span><span className="text-cohesity-text">{fmtTime(alert.resolved_at)}</span></div>}
          {msg && (
            <div className="flex gap-3">
              <span className="text-gray-500 w-20 flex-shrink-0">Message</span>
              <span className="text-cohesity-text leading-relaxed">{msg}</span>
            </div>
          )}
          {alert.property_list && alert.property_list.length > 0 && (
            <div className="mt-2 border-t border-cohesity-border pt-2">
              <p className="text-gray-500 mb-1.5">Details</p>
              {alert.property_list.map((p, i) => (
                <div key={i} className="flex gap-3 mb-1"><span className="text-gray-500 w-20 flex-shrink-0 truncate">{p.key}</span><span className="text-cohesity-text leading-relaxed">{p.value}</span></div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RecentAlertsPanel() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    client.get('/alerts?dismissed=0&resolved=0&severity=critical')
      .then(r => {
        const sorted = [...r.data].sort((a, b) => new Date(getAlertTimestamp(b) || 0) - new Date(getAlertTimestamp(a) || 0));
        setAlerts(sorted.slice(0, 10));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fmtTime = (ts) => {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    } catch { return ts; }
  };

  return (
    <>
      {selected && <AlertDetailModal alert={selected} onClose={() => setSelected(null)} />}
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
        <p className="text-xs font-semibold text-cohesity-text mb-3">Recent Critical Alerts</p>
        <div className="overflow-y-auto" style={{ maxHeight: 256 }}>
          {loading ? (
            <div className="text-center py-4 text-gray-500 text-xs">Loading...</div>
          ) : alerts.length === 0 ? (
            <div className="text-center py-4 text-green-400 text-xs">No active alerts</div>
          ) : (
            <table className="w-full text-[10px] text-gray-400">
              <thead className="sticky top-0 bg-cohesity-gray">
                <tr>
                  <th className="text-left px-1 py-1 font-medium">Time</th>
                  <th className="text-left px-1 py-1 font-medium">Cluster</th>
                  <th className="text-left px-1 py-1 font-medium">Issue</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => (
                  <tr
                    key={a.id || i}
                    onClick={() => setSelected(a)}
                    className={`cursor-pointer hover:bg-cohesity-green/10 transition-colors ${i % 2 === 0 ? 'bg-cohesity-black/40' : ''}`}
                  >
                    <td className="px-1 py-1 whitespace-nowrap">{fmtTime(getAlertTimestamp(a))}</td>
                    <td className="px-1 py-1 truncate max-w-[80px]">{a.cluster_name || a.cluster_id || '—'}</td>
                    <td className="px-1 py-1 truncate max-w-[100px] text-amber-400">{a.alert_type || a.message || a.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// --- Main Dashboard ---

export default function Dashboard() {
  const [clusters, setClusters] = useState([]);
  const [latestMetrics, setLatestMetrics] = useState({});
  const [loading, setLoading] = useState(true);
  const [connectionFilter, setConnectionFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [criticalIds, setCriticalIds] = useState(new Set());
  const [polling, setPolling] = useState(false);
  const [selectedClusterIds, setSelectedClusterIds] = useState(new Set());
  const [trendDays, setTrendDays] = useState(1);
  const [trendHistory, setTrendHistory] = useState({});
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendChartHeight, setTrendChartHeight] = useState(220);
  const [growthTableHeight, setGrowthTableHeight] = useState(128);
  const [clusterPage, setClusterPage] = useState(0);
  const [clusterHistory, setClusterHistory] = useState({});

  const trendChartRef = useRef(null);
  const trendResizeRef = useRef(null);

  const { search, setSearch } = useSearch();

  const loadClusters = useCallback(async () => {
    try {
      const { data } = await client.get('/clusters');
      setClusters(data);
      const metricResults = await Promise.allSettled(
        data.map(c =>
          client.get('/metrics/' + c.id + '/history?days=7').then(r => ({
            id: c.id,
            rows: r.data,
          }))
        )
      );
      const metricsMap = {};
      const historyMap = {};
      for (const r of metricResults) {
        if (r.status === 'fulfilled' && r.value.rows.length > 0) {
          const rows = r.value.rows;
          metricsMap[r.value.id] = rows[rows.length - 1];
          historyMap[r.value.id] = rows;
        }
      }
      setLatestMetrics(metricsMap);
      setClusterHistory(historyMap);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadClusters(); }, [loadClusters]);

  useEffect(() => {
    if (!criticalOnly || clusters.length === 0) return;
    Promise.allSettled(
      clusters.map(c =>
        client.get('/alerts?clusterId=' + c.id + '&severity=critical&resolved=0')
          .then(r => ({ id: c.id, hasCritical: r.data.length > 0 }))
      )
    ).then(results => {
      setCriticalIds(new Set(
        results.filter(r => r.status === 'fulfilled' && r.value.hasCritical).map(r => r.value.id)
      ));
    });
  }, [criticalOnly, clusters]);

  const toggleSelect = (id) => {
    setSelectedClusterIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allTags = [...new Set(
    clusters.flatMap(c => (c.tags || '').split(',').map(t => t.trim()).filter(Boolean))
  )].sort();

  const filtered = clusters.filter(c => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (connectionFilter !== 'all' && c.connection_type !== connectionFilter) return false;
    if (tagFilter !== 'all' && !(c.tags || '').split(',').map(t => t.trim()).includes(tagFilter)) return false;
    if (criticalOnly && !criticalIds.has(c.id)) return false;
    return true;
  });

  const CLUSTER_PAGE_SIZE = 6;

  const sortedFiltered = [...filtered].sort((a, b) => {
    const mA = latestMetrics[a.id];
    const mB = latestMetrics[b.id];
    const pA = mA?.total_capacity_bytes > 0 ? (mA.used_bytes / mA.total_capacity_bytes) : 0;
    const pB = mB?.total_capacity_bytes > 0 ? (mB.used_bytes / mB.total_capacity_bytes) : 0;
    return pB - pA;
  });

  const activeSet = selectedClusterIds.size > 0
    ? sortedFiltered.filter(c => selectedClusterIds.has(c.id))
    : sortedFiltered;

  const clusterTotalPages = Math.max(1, Math.ceil(sortedFiltered.length / CLUSTER_PAGE_SIZE));
  const clusterSafePage = Math.min(clusterPage, clusterTotalPages - 1);
  const clusterPageItems = sortedFiltered.slice(
    clusterSafePage * CLUSTER_PAGE_SIZE,
    (clusterSafePage + 1) * CLUSTER_PAGE_SIZE
  );

  const chartData = activeSet
    .map(c => {
      const m = latestMetrics[c.id];
      if (!m) return null;
      const used = toTB(m.used_bytes);
      const total = toTB(m.total_capacity_bytes);
      const available = Math.max(0, total - used);
      const pct = total > 0 ? parseFloat(((used / total) * 100).toFixed(1)) : 0;
      return { name: c.name.length > 16 ? c.name.slice(0, 14) + '...' : c.name, fullName: c.name, used, available, pct };
    })
    .filter(Boolean)
    .sort((a, b) => b.pct - a.pct);

  useEffect(() => {
    trendChartRef.current?.resetZoom();
  }, [trendDays]);

  useEffect(() => {
    requestAnimationFrame(() => trendChartRef.current?.resize());
  }, [trendChartHeight]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ids = activeSet.map(c => c.id);
    if (ids.length === 0) { setTrendHistory({}); return; }
    setTrendLoading(true);
    Promise.allSettled(
      ids.map(id =>
        client.get(`/metrics/${id}/history?days=${trendDays}`)
          .then(r => ({ id, rows: r.data }))
      )
    ).then(results => {
      const map = {};
      for (const r of results) {
        if (r.status === 'fulfilled') map[r.value.id] = r.value.rows;
      }
      setTrendHistory(map);
      setTimeout(() => trendChartRef.current?.resetZoom(), 0);
    }).finally(() => setTrendLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSet.map(c => c.id).join(','), trendDays]);

  const handleTriggerAll = async () => {
    setPolling(true);
    await Promise.allSettled(clusters.map(c => client.post('/poller/trigger/' + c.id)));
    setTimeout(() => { setPolling(false); loadClusters(); }, 3000);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Row 1: filter bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search clusters..."
          className="bg-cohesity-gray border border-cohesity-border text-xs text-cohesity-text rounded px-3 py-1.5 w-40 focus:outline-none focus:border-cohesity-green placeholder-gray-500"
        />
        <select
          value={connectionFilter}
          onChange={e => setConnectionFilter(e.target.value)}
          className="bg-cohesity-gray border border-cohesity-border text-xs text-cohesity-text rounded px-2 py-1.5 focus:outline-none focus:border-cohesity-green"
        >
          <option value="all">All Types</option>
          <option value="helios">Helios</option>
          <option value="direct">Direct</option>
        </select>
        <select
          value={tagFilter}
          onChange={e => setTagFilter(e.target.value)}
          className="bg-cohesity-gray border border-cohesity-border text-xs text-cohesity-text rounded px-2 py-1.5 focus:outline-none focus:border-cohesity-green"
        >
          <option value="all">All Tags</option>
          {allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" checked={criticalOnly} onChange={e => setCriticalOnly(e.target.checked)} className="accent-red-500" />
          Critical only
        </label>
        <div className="ml-auto flex items-center gap-2">
          {(search || tagFilter !== 'all' || connectionFilter !== 'all') && (
            <button onClick={() => { setSearch(''); setTagFilter('all'); setConnectionFilter('all'); setCriticalOnly(false); }} className="text-xs text-gray-500 hover:text-cohesity-green transition-colors">
              ✕ Clear filters
            </button>
          )}
          {selectedClusterIds.size > 0 && (
            <button onClick={() => setSelectedClusterIds(new Set())} className="text-xs text-cohesity-green hover:underline">
              ✕ Clear selection ({selectedClusterIds.size})
            </button>
          )}
          <span className="text-xs text-gray-500">{sortedFiltered.length} cluster(s)</span>
          <button
            onClick={handleTriggerAll}
            disabled={polling || clusters.length === 0}
            className="text-xs px-3 py-1.5 bg-cohesity-gray border border-cohesity-border rounded hover:border-cohesity-green hover:text-cohesity-green transition-colors disabled:opacity-50"
          >
            {polling ? 'Polling...' : '↻ Poll All'}
          </button>
        </div>
      </div>

      {/* Row 2: two-column main content */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        {/* LEFT COLUMN */}
        <div className="xl:col-span-2 flex flex-col gap-4">
          <GlobalStorageCard latestMetrics={latestMetrics} clusters={clusters} />

          {/* Trend chart card */}
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
            <p className="text-xs font-semibold text-cohesity-text mb-1">Capacity Growth Trend</p>
            {(() => {
              const TREND_COLORS = [
                '#6CB33F', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4',
                '#f97316', '#ec4899', '#10b981', '#6366f1', '#84cc16',
                '#14b8a6', '#f43f5e', '#8b5cf6', '#fbbf24', '#34d399'
              ];

              const allTimestamps = [...new Set(
                Object.values(trendHistory).flatMap(rows =>
                  rows.map(r => r.captured_at).filter(Boolean)
                )
              )].sort();

              const trendClusters = activeSet.filter(c => trendHistory[c.id]?.length > 0);

              const fmtBytes = (bytes) => {
                if (bytes == null) return '—';
                if (bytes >= 1e15) return (bytes / 1e15).toFixed(2) + ' PB';
                if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
                if (bytes >= 1e9)  return (bytes / 1e9).toFixed(2) + ' GB';
                return (bytes / 1e6).toFixed(1) + ' MB';
              };

              const allUsedBytes = Object.values(trendHistory).flatMap(rows => rows.map(r => r.used_bytes || 0));
              const maxBytes = Math.max(...allUsedBytes, 1);
              const yUnit = maxBytes >= 1e15 ? { label: 'PB', div: 1e15 } :
                            maxBytes >= 1e12 ? { label: 'TB', div: 1e12 } :
                            maxBytes >= 1e9  ? { label: 'GB', div: 1e9  } :
                                               { label: 'MB', div: 1e6  };

              const linReg = (pts) => {
                const n = pts.length;
                if (n < 2) return null;
                const sumX = pts.reduce((s, p) => s + p.x, 0);
                const sumY = pts.reduce((s, p) => s + p.y, 0);
                const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
                const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);
                const denom = n * sumX2 - sumX * sumX;
                if (denom === 0) return null;
                const slope = (n * sumXY - sumX * sumY) / denom;
                const intercept = (sumY - slope * sumX) / n;
                return { slope, intercept };
              };

              const trendDatasets = trendClusters.map((c, i) => {
                const rows = trendHistory[c.id] || [];
                const byTs = {};
                for (const r of rows) {
                  if (r.captured_at && r.used_bytes != null) {
                    byTs[r.captured_at] = parseFloat((r.used_bytes / yUnit.div).toFixed(3));
                  }
                }
                const color = TREND_COLORS[i % TREND_COLORS.length];
                return {
                  label: c.name,
                  data: allTimestamps.map(ts => byTs[ts] ?? null),
                  borderColor: color,
                  backgroundColor: color + '22',
                  fill: false,
                  tension: 0.3,
                  pointRadius: allTimestamps.length > 200 ? 0 : allTimestamps.length > 50 ? 2 : 4,
                  pointHoverRadius: 6,
                  pointHitRadius: 10,
                  borderWidth: 2,
                  spanGaps: true,
                };
              });

              const forecastLabels = [];
              const lastTsMs = allTimestamps.length > 0
                ? new Date(allTimestamps[allTimestamps.length - 1].replace(' ', 'T')).getTime()
                : Date.now();
              const futureStepCount = 24;
              const stepMs = (trendDays * 24 * 60 * 60 * 1000) / futureStepCount;
              for (let fi = 1; fi <= futureStepCount; fi++) {
                const futureMs = lastTsMs + fi * stepMs;
                const fd = new Date(futureMs);
                const mm = String(fd.getMonth() + 1).padStart(2, '0');
                const dd = String(fd.getDate()).padStart(2, '0');
                const hh = String(fd.getHours()).padStart(2, '0');
                const mn = String(fd.getMinutes()).padStart(2, '0');
                forecastLabels.push(`${mm}-${dd} ${hh}:${mn}`);
              }

              const extraDatasets = [];
              const growthSummaries = [];

              trendClusters.forEach((c, i) => {
                const rows = trendHistory[c.id] || [];
                const color = TREND_COLORS[i % TREND_COLORS.length];
                const pts = rows
                  .filter(r => r.captured_at && r.used_bytes != null)
                  .map(r => ({
                    x: new Date(r.captured_at.replace(' ', 'T')).getTime(),
                    y: r.used_bytes
                  }));
                const reg = linReg(pts);
                const lastRow = rows[rows.length - 1];
                const totalCap = lastRow?.total_capacity_bytes ?? 0;
                const currentUsed = pts.length > 0 ? pts[pts.length - 1].y : 0;
                const growthBytesPerDay = reg ? reg.slope * 86400000 : 0;

                let daysUntilFull = null;
                let daysUntil85 = null;
                if (reg && reg.slope > 0 && totalCap > 0) {
                  const dFull = (totalCap * 0.90 - currentUsed) / growthBytesPerDay;
                  const d85 = (totalCap * 0.85 - currentUsed) / growthBytesPerDay;
                  daysUntilFull = dFull > 0 && dFull <= 999 ? dFull : null;
                  daysUntil85 = d85 > 0 && d85 <= 999 ? d85 : null;
                }

                growthSummaries.push({ name: c.name, growthBytesPerDay, daysUntilFull, daysUntil85 });

                if (reg && reg.slope > 0) {
                  const projectedValues = [];
                  for (let j = 1; j <= futureStepCount; j++) {
                    const futureMs = lastTsMs + j * stepMs;
                    const projectedBytes = reg.intercept + reg.slope * futureMs;
                    projectedValues.push(projectedBytes > 0 ? parseFloat((projectedBytes / yUnit.div).toFixed(3)) : null);
                  }
                  extraDatasets.push({
                    label: `${c.name} (proj.)`,
                    data: [...allTimestamps.map(() => null), ...projectedValues],
                    borderColor: color,
                    borderDash: [4, 4],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false,
                    tension: 0.3,
                    spanGaps: false,
                  });
                }

                if (totalCap > 0 && trendClusters.length <= 6) {
                  const capValue = parseFloat((totalCap / yUnit.div).toFixed(3));
                  extraDatasets.push({
                    label: `${c.name} cap.`,
                    data: [...allTimestamps.map(() => capValue), ...forecastLabels.map(() => capValue)],
                    borderColor: color + '44',
                    borderDash: [2, 4],
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                  });

                  const thresh85Value = parseFloat((totalCap * 0.85 / yUnit.div).toFixed(3));
                  extraDatasets.push({
                    label: `${c.name} 85%`,
                    data: [...allTimestamps.map(() => thresh85Value), ...forecastLabels.map(() => thresh85Value)],
                    borderColor: '#f59e0b44',
                    borderDash: [2, 4],
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                  });
                }
              });

              trendDatasets.forEach(ds => {
                for (let j = 0; j < futureStepCount; j++) ds.data.push(null);
              });

              // Compute y-axis bounds from meaningful data only (exclude reference cap/85% lines)
              const meaningfulDatasets = [
                ...trendDatasets,
                ...extraDatasets.filter(ds => ds.label.endsWith('(proj.)'))
              ];
              const meaningfulValues = meaningfulDatasets
                .flatMap(ds => ds.data)
                .filter(v => v != null && !isNaN(v) && isFinite(v));

              let yMin = 0;
              let yMax = undefined;
              if (meaningfulValues.length > 0) {
                const minVal = Math.min(...meaningfulValues);
                const maxVal = Math.max(...meaningfulValues);
                const range = maxVal - minVal;
                const padding = Math.max(range * 0.12, 1); // 12% padding, min 1 unit
                yMin = Math.max(0, minVal - padding);
                yMax = maxVal + padding;
              }

              const formatLabel = (ts) => {
                if (!ts) return '';
                const s = ts.replace('T', ' ');
                return s.slice(5, 16);
              };

              const displayLabels = allTimestamps.map(formatLabel);
              const trendChartData = { labels: [...displayLabels, ...forecastLabels], datasets: [...trendDatasets, ...extraDatasets] };

              const trendOptions = {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                  legend: {
                    display: trendClusters.length <= 12,
                    labels: { color: '#9ca3af', font: { size: 9 }, boxWidth: 12 }
                  },
                  tooltip: {
                    backgroundColor: '#2C2C2C',
                    borderColor: '#3D3D3D',
                    borderWidth: 1,
                    titleColor: '#E5E5E5',
                    bodyColor: '#9ca3af',
                    callbacks: {
                      label: (item) => {
                        const raw = item.parsed.y;
                        if (raw == null) return `${item.dataset.label}: —`;
                        return `${item.dataset.label}: ${raw.toFixed(2)} ${yUnit.label} used`;
                      }
                    }
                  },
                  zoom: {
                    pan: { enabled: true, mode: 'x' },
                    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
                  },
                },
                scales: {
                  x: {
                    ticks: { color: '#6b7280', font: { size: 9 }, maxTicksLimit: 12, maxRotation: 0 },
                    grid: { color: '#3D3D3D' },
                  },
                  y: {
                    min: yMin,
                    max: yMax,
                    ticks: { color: '#6b7280', font: { size: 9 }, callback: v => v + ' ' + yUnit.label },
                    title: { display: true, text: `Used (${yUnit.label})`, color: '#6b7280', font: { size: 9 } },
                    grid: { color: '#3D3D3D' },
                  }
                }
              };

              const handleCsvExport = () => {
                const rows = ['Timestamp,ClusterName,UsedBytes,TotalCapacityBytes'];
                for (const c of trendClusters) {
                  for (const r of (trendHistory[c.id] || [])) {
                    rows.push(`${r.captured_at},${JSON.stringify(c.name)},${r.used_bytes ?? ''},${r.total_capacity_bytes ?? ''}`);
                  }
                }
                const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `storage-trend-${trendDays}d.csv`;
                a.click();
                URL.revokeObjectURL(url);
              };

              const hasData = allTimestamps.length > 0 && trendDatasets.length > 0;

              return (
                <>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] text-gray-500">
                      {selectedClusterIds.size > 0 ? `${trendClusters.length} selected cluster(s)` : `${trendClusters.length} cluster(s)`}
                      {hasData && <span className="ml-2 text-gray-600">&middot; scroll to zoom &middot; drag to pan</span>}
                    </p>
                    <div className="flex items-center gap-1">
                      {hasData && (
                        <button onClick={handleCsvExport} className="text-xs px-2 py-1 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green hover:text-cohesity-green transition-colors" title="Export CSV">
                          ↓ CSV
                        </button>
                      )}
                      {hasData && (
                        <button onClick={() => trendChartRef.current?.resetZoom()} className="text-xs px-2 py-1 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green hover:text-cohesity-green transition-colors" title="Reset zoom">
                          &#x21BA; Reset
                        </button>
                      )}
                      {[1, 7, 14, 30].map(d => (
                        <button key={d} onClick={() => setTrendDays(d)}
                          className={`text-xs px-2 py-1 rounded border transition-colors ${trendDays === d ? 'bg-cohesity-green text-cohesity-black border-cohesity-green' : 'border-cohesity-border text-gray-400 hover:border-cohesity-green'}`}>
                          {d}d
                        </button>
                      ))}
                    </div>
                  </div>
                  {trendLoading ? (
                    <div className="flex items-center justify-center text-gray-400 text-xs" style={{ height: 200 }}>Loading trend data...</div>
                  ) : !hasData ? (
                    <div className="flex items-center justify-center text-gray-500 text-xs" style={{ height: 200 }}>No trend data available. Select clusters or wait for polling to collect history.</div>
                  ) : (
                    <div style={{ height: trendChartHeight }}>
                      <Line ref={trendChartRef} data={trendChartData} options={trendOptions} />
                    </div>
                  )}
                  <div
                    ref={trendResizeRef}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const startY = e.clientY;
                      const startH = trendChartHeight;
                      const onMove = (ev) => {
                        const newH = Math.max(120, Math.min(900, startH + ev.clientY - startY));
                        setTrendChartHeight(newH);
                      };
                      const onUp = () => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                      };
                      window.addEventListener('mousemove', onMove);
                      window.addEventListener('mouseup', onUp);
                    }}
                    className="flex items-center justify-center mt-1 h-3 cursor-ns-resize group"
                    title="Drag to resize"
                  >
                    <div className="w-10 h-1 rounded-full bg-cohesity-border group-hover:bg-cohesity-green transition-colors" />
                  </div>
                  {hasData && growthSummaries.some(s => s.growthBytesPerDay > 0) && (
                    <div className="mt-2 border border-cohesity-border rounded overflow-hidden">
                      <div className="overflow-y-auto" style={{ height: growthTableHeight }}>
                        <table className="w-full text-[10px] text-gray-400">
                          <thead className="bg-cohesity-black sticky top-0">
                            <tr>
                              <th className="text-left px-2 py-1 font-medium">Cluster</th>
                              <th className="text-right px-2 py-1 font-medium">Growth Rate</th>
                              <th className="text-right px-2 py-1 font-medium">~Days to 85%</th>
                              <th className="text-right px-2 py-1 font-medium">Date to 85%</th>
                              <th className="text-right px-2 py-1 font-medium">~Days to 90%</th>
                              <th className="text-right px-2 py-1 font-medium">Date to 90%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {growthSummaries.filter(s => s.growthBytesPerDay > 0).map((s, i) => {
                              const rateStr = s.growthBytesPerDay < 100e9
                                ? `+${(s.growthBytesPerDay / 1e9).toFixed(1)} GB/day`
                                : `+${(s.growthBytesPerDay * 7 / 1e12).toFixed(1)} TB/week`;
                              const toDateStr = (days) => {
                                if (days == null) return '—';
                                const d = new Date();
                                d.setDate(d.getDate() + Math.round(days));
                                return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
                              };
                              return (
                                <tr key={s.name} className={i % 2 === 0 ? 'bg-cohesity-gray' : 'bg-cohesity-black'}>
                                  <td className="px-2 py-1 truncate max-w-[120px]">{s.name}</td>
                                  <td className="text-right px-2 py-1 text-cohesity-green">{rateStr}</td>
                                  <td className="text-right px-2 py-1">{s.daysUntil85 != null ? Math.round(s.daysUntil85) : '—'}</td>
                                  <td className="text-right px-2 py-1 text-amber-400">{toDateStr(s.daysUntil85)}</td>
                                  <td className="text-right px-2 py-1">{s.daysUntilFull != null ? Math.round(s.daysUntilFull) : '—'}</td>
                                  <td className="text-right px-2 py-1 text-amber-400">{toDateStr(s.daysUntilFull)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div
                        onMouseDown={(e) => {
                          e.preventDefault();
                          const startY = e.clientY;
                          const startH = growthTableHeight;
                          const onMove = (ev) => {
                            const newH = Math.max(60, Math.min(600, startH + ev.clientY - startY));
                            setGrowthTableHeight(newH);
                          };
                          const onUp = () => {
                            window.removeEventListener('mousemove', onMove);
                            window.removeEventListener('mouseup', onUp);
                          };
                          window.addEventListener('mousemove', onMove);
                          window.addEventListener('mouseup', onUp);
                        }}
                        className="flex items-center justify-center h-3 cursor-ns-resize group bg-cohesity-black"
                        title="Drag to resize"
                      >
                        <div className="w-10 h-1 rounded-full bg-cohesity-border group-hover:bg-cohesity-green transition-colors" />
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="xl:col-span-3">
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4 h-full flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-cohesity-text">Cluster Health &amp; Alerts</p>
              <span className="text-[10px] text-gray-500">{sortedFiltered.length} clusters</span>
            </div>
            {loading ? (
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3 gap-2">
                {[...Array(CLUSTER_PAGE_SIZE)].map((_, i) => <SkeletonCard key={i} />)}
              </div>
            ) : sortedFiltered.length === 0 ? (
              <EmptyState
                icon={<ClusterEmptyIcon />}
                title="No clusters found"
                message={clusters.length === 0 ? 'No clusters configured.' : 'No clusters match the current filters.'}
              />
            ) : (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3 gap-2">
                  {clusterPageItems.map(c => (
                    <ClusterCard
                      key={c.id}
                      cluster={c}
                      historyRows={clusterHistory[c.id]}
                      selected={selectedClusterIds.has(c.id)}
                      onSelect={toggleSelect}
                      onTagClick={setTagFilter}
                    />
                  ))}
                </div>
                {clusterTotalPages > 1 && (
                  <Pagination
                    page={clusterSafePage}
                    totalPages={clusterTotalPages}
                    totalItems={sortedFiltered.length}
                    pageSize={CLUSTER_PAGE_SIZE}
                    onPage={setClusterPage}
                    compact
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Row 3: bottom 3 panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <TopClustersBar chartData={chartData} />
        <StorageDistributionTable sortedFiltered={sortedFiltered} latestMetrics={latestMetrics} />
        <RecentAlertsPanel />
      </div>
    </div>
  );
}
