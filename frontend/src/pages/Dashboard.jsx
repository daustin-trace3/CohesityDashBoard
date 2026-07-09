import { useEffect, useState, useCallback, useRef } from 'react';
import client from '../api/client';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  Title, Tooltip as ChartTooltip, Legend, Filler, ArcElement
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';
import ZoomPlugin from 'chartjs-plugin-zoom';
import {
  Database, HardDrive, Server, Bell, ShieldCheck, RefreshCw, Download,
  RotateCcw, X, Globe, TrendingUp, ListFilter, LayoutGrid, AlertTriangle,
} from 'lucide-react';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, ChartTooltip, Legend, Filler, ArcElement, ZoomPlugin);
import { useSearch } from '../App';
import ClusterCard from '../components/ClusterCard';
import SkeletonCard from '../components/SkeletonCard';
import EmptyState, { ClusterEmptyIcon } from '../components/EmptyState';
import Pagination from '../components/Pagination';
import InsightsPanel from '../components/InsightsPanel';
import { StatCard, Panel, Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

const CHART = {
  grid: '#1F2B37',
  tick: '#64748B',
  tooltipBg: '#1E2A36',
  tooltipBorder: '#2A3845',
  titleColor: '#E8EDF2',
  bodyColor: '#94A3B3',
};

function toTB(bytes) {
  if (!bytes) return 0;
  return parseFloat((bytes / 1e12).toFixed(2));
}

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

function getAlertTimestamp(alert) {
  return alert.first_seen || alert.last_updated || alert.triggered_at || alert.created_at;
}

function parseUtcMs(ts) {
  if (!ts) return 0;
  // Handle both "YYYY-MM-DD HH:MM:SS" (SQLite) and "YYYY-MM-DDTHH:MM:SSZ" (ISO)
  const s = ts.replace(' ', 'T').replace(/Z*$/, 'Z');
  return new Date(s).getTime();
}

function timeAgo(ts) {
  if (!ts) return 'Never';
  const mins = Math.round((Date.now() - parseUtcMs(ts)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function clusterStatus(cluster, latestMetricsMap) {
  const m = latestMetricsMap[cluster.id];
  if (!m || !m.captured_at) return 'red';
  const intervalMs = (cluster.polling_interval_minutes || 15) * 2 * 60 * 1000;
  const age = Date.now() - parseUtcMs(m.captured_at);
  return age <= intervalMs ? 'green' : 'yellow';
}

function ClusterStatusOrb({ status, lastSeen, size = 8 }) {
  const colors = { green: '#34D399', yellow: '#FBBF24', red: '#F87171', gray: '#5F7081' };
  const color = colors[status] || colors.gray;
  const label = status === 'green' ? 'Online' : status === 'yellow' ? 'Stale' : 'Offline';
  return (
    <span title={`${label} · Last seen: ${lastSeen ? timeAgo(lastSeen) : 'Never'}`} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      <span
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: color,
          boxShadow: `0 0 ${size / 2}px ${color}99`,
          animation: status === 'green' ? 'orb-pulse 2.5s ease-in-out infinite' : 'none',
        }}
      />
    </span>
  );
}

// --- Sub-components ---

function GlobalStorageCard({ latestMetrics, clusters }) {
  const entries = clusters.map(c => latestMetrics[c.id]).filter(Boolean);
  const totalUsed = entries.reduce((s, m) => s + (m.used_bytes || 0), 0);
  const totalCap = entries.reduce((s, m) => s + (m.total_capacity_bytes || 0), 0);
  const drValues = entries.map(m => m.data_reduction_ratio).filter(v => v != null && v > 0);
  const avgDR = drValues.length > 0 ? drValues.reduce((s, v) => s + v, 0) / drValues.length : 0;

  const pct = totalCap > 0 ? (totalUsed / totalCap) * 100 : 0;
  const pctColor = pct >= 86 ? '#F87171' : pct >= 70 ? '#FBBF24' : '#6CB33F';

  const donutData = {
    datasets: [{
      data: [totalUsed, Math.max(0, totalCap - totalUsed)],
      backgroundColor: [pctColor, '#1E2A36'],
      borderWidth: 0,
      borderRadius: 6,
    }]
  };

  return (
    <Panel title="Global Storage Utilization" icon={Globe}>
      <div className="flex items-center gap-5">
        <div className="relative flex-shrink-0" style={{ width: 110, height: 110 }}>
          <Doughnut
            data={donutData}
            options={{
              cutout: '74%',
              maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: { enabled: false } }
            }}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-lg font-bold text-ink tnum leading-none">{pct.toFixed(1)}%</span>
            <span className="text-[10px] text-ink-faint mt-0.5">used</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          <div>
            <p className="text-sm font-semibold text-ink tnum">{fmtBytes(totalUsed)} <span className="text-ink-faint font-normal">of</span> {fmtBytes(totalCap)}</p>
            <p className="text-[11px] text-ink-muted">{fmtBytes(Math.max(0, totalCap - totalUsed))} available</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="brand" className="tnum">{avgDR.toFixed(1)}x data reduction</Badge>
            <Badge tone="neutral" className="tnum">{entries.length} reporting</Badge>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function TopClustersBar({ chartData }) {
  const top10 = chartData.slice(0, 10);
  const barData = {
    labels: top10.map(d => d.name),
    datasets: [{
      label: '% Used',
      data: top10.map(d => d.pct),
      backgroundColor: top10.map(d => d.pct >= 86 ? '#F87171' : d.pct >= 70 ? '#FBBF24' : '#6CB33F'),
      borderRadius: 3,
      barThickness: 'flex',
      maxBarThickness: 14,
    }]
  };
  const options = {
    indexAxis: 'y',
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: CHART.tooltipBg, borderColor: CHART.tooltipBorder, borderWidth: 1,
        titleColor: CHART.titleColor, bodyColor: CHART.bodyColor,
        callbacks: { label: (item) => item.parsed.x.toFixed(1) + '% Used' }
      }
    },
    scales: {
      x: {
        max: 100,
        ticks: { color: CHART.tick, font: { size: 10 }, callback: v => v + '%' },
        grid: { color: CHART.grid },
      },
      y: {
        ticks: { color: CHART.tick, font: { size: 10 } },
        grid: { display: false },
      }
    }
  };
  return (
    <Panel title="Top Clusters by Capacity" icon={TrendingUp}>
      <div style={{ height: 220 }}>
        {top10.length > 0 ? (
          <Bar data={barData} options={options} />
        ) : (
          <div className="flex items-center justify-center h-full text-ink-faint text-xs">No data</div>
        )}
      </div>
    </Panel>
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
    <Panel title="Storage Distribution" icon={Database}>
      <div className="overflow-y-auto" style={{ maxHeight: 256 }}>
        <table className="w-full text-[11px] text-ink-muted">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-ink-faint">
              <th className="text-left px-1.5 py-1.5 font-semibold">Cluster</th>
              <th className="text-right px-1.5 py-1.5 font-semibold">Used TB</th>
              <th className="text-right px-1.5 py-1.5 font-semibold">Total TB</th>
              <th className="text-right px-1.5 py-1.5 font-semibold">% Used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const m = latestMetrics[c.id];
              const used = toTB(m?.used_bytes);
              const total = toTB(m?.total_capacity_bytes);
              const pct = total > 0 ? (used / total) * 100 : 0;
              const pctColor = pct >= 86 ? 'text-status-crit' : pct >= 70 ? 'text-status-warn' : 'text-status-ok';
              return (
                <tr key={c.id} className="border-t border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors">
                  <td className="px-1.5 py-1.5 truncate max-w-[100px] text-ink">{c.name}</td>
                  <td className="text-right px-1.5 py-1.5 tnum">{used.toFixed(2)}</td>
                  <td className="text-right px-1.5 py-1.5 tnum">{total.toFixed(2)}</td>
                  <td className={`text-right px-1.5 py-1.5 font-semibold tnum ${pctColor}`}>{pct.toFixed(1)}%</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="text-center py-4 text-ink-faint">No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function AlertDetailModal({ alert, onClose }) {
  if (!alert) return null;
  const fmtTime = (ts) => {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  };
  const severity = alert.severity || 'info';
  const sevTone = severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'info';
  const msg = alert.message || alert.description || '';
  // Scale modal width: short < 120 chars → 520px, medium < 300 → 680px, long → 860px, capped at 90vw
  const modalMaxW = msg.length > 300 ? 'min(860px,90vw)' : msg.length > 120 ? 'min(680px,90vw)' : 'min(520px,90vw)';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative panel bg-surface-raised p-6 shadow-modal"
        style={{ width: modalMaxW }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Alert details"
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <AlertTriangle size={18} className={severity === 'critical' ? 'text-status-crit' : severity === 'warning' ? 'text-status-warn' : 'text-status-info'} />
            <div>
              <p className="text-sm font-bold text-ink">{alert.alert_type || 'Alert'}</p>
              <Badge tone={sevTone} className="mt-1 uppercase">{severity}</Badge>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink transition-colors cursor-pointer flex-shrink-0">
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-2.5 text-xs">
          <div className="flex gap-3"><span className="text-ink-faint w-20 flex-shrink-0">Cluster</span><span className="text-ink">{alert.cluster_name || alert.cluster_id || '—'}</span></div>
          <div className="flex gap-3"><span className="text-ink-faint w-20 flex-shrink-0">Triggered</span><span className="text-ink tnum">{fmtTime(getAlertTimestamp(alert))}</span></div>
          {alert.resolved_at && <div className="flex gap-3"><span className="text-ink-faint w-20 flex-shrink-0">Resolved</span><span className="text-ink tnum">{fmtTime(alert.resolved_at)}</span></div>}
          {msg && (
            <div className="flex gap-3">
              <span className="text-ink-faint w-20 flex-shrink-0">Message</span>
              <span className="text-ink leading-relaxed">{msg}</span>
            </div>
          )}
          {alert.property_list && alert.property_list.length > 0 && (
            <div className="mt-2 border-t border-cohesity-border pt-2">
              <p className="text-ink-faint mb-1.5">Details</p>
              {alert.property_list.map((p, i) => (
                <div key={i} className="flex gap-3 mb-1"><span className="text-ink-faint w-20 flex-shrink-0 truncate">{p.key}</span><span className="text-ink leading-relaxed">{p.value}</span></div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RecentAlertsPanel({ initialAlerts }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    // Prefer the cached snapshot alerts; only fetch if none were provided.
    if (initialAlerts !== undefined && initialAlerts !== null) {
      const sorted = [...initialAlerts].sort((a, b) => new Date(getAlertTimestamp(b) || 0) - new Date(getAlertTimestamp(a) || 0));
      setAlerts(sorted.slice(0, 10));
      setLoading(false);
      return;
    }
    client.get('/cohesity/alerts?dismissed=0&resolved=0&severity=critical')
      .then(r => {
        const sorted = [...r.data].sort((a, b) => new Date(getAlertTimestamp(b) || 0) - new Date(getAlertTimestamp(a) || 0));
        setAlerts(sorted.slice(0, 10));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [initialAlerts]);

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
      <Panel title="Recent Critical Alerts" icon={Bell}>
        <div className="overflow-y-auto" style={{ maxHeight: 256 }}>
          {loading ? (
            <div className="flex flex-col gap-2 py-1" aria-hidden="true">
              {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-7 w-full" />)}
            </div>
          ) : alerts.length === 0 ? (
            <div className="text-center py-6 text-status-ok text-xs flex items-center justify-center gap-1.5">
              <ShieldCheck size={14} /> No active critical alerts
            </div>
          ) : (
            <table className="w-full text-[11px] text-ink-muted">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-ink-faint">
                  <th className="text-left px-1.5 py-1.5 font-semibold">Time</th>
                  <th className="text-left px-1.5 py-1.5 font-semibold">Cluster</th>
                  <th className="text-left px-1.5 py-1.5 font-semibold">Issue</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => (
                  <tr
                    key={a.id || i}
                    onClick={() => setSelected(a)}
                    className="cursor-pointer border-t border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors"
                  >
                    <td className="px-1.5 py-1.5 whitespace-nowrap tnum">{fmtTime(getAlertTimestamp(a))}</td>
                    <td className="px-1.5 py-1.5 truncate max-w-[80px] text-ink">{a.cluster_name || a.cluster_id || '—'}</td>
                    <td className="px-1.5 py-1.5 truncate max-w-[110px] text-status-warn">{a.alert_type || a.message || a.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </>
  );
}

function ClusterHealthPanel({ clusters, latestMetrics }) {
  const rows = [...clusters].sort((a, b) => {
    const order = { red: 0, yellow: 1, green: 2 };
    return (order[clusterStatus(a, latestMetrics)] ?? 3) - (order[clusterStatus(b, latestMetrics)] ?? 3);
  });
  const counts = { green: 0, yellow: 0, red: 0 };
  for (const c of clusters) counts[clusterStatus(c, latestMetrics)] = (counts[clusterStatus(c, latestMetrics)] || 0) + 1;

  return (
    <Panel
      title="Cluster Status"
      icon={Server}
      actions={
        <div className="flex items-center gap-1.5 text-[10px] tnum">
          {counts.green > 0 && <Badge tone="ok">{counts.green} online</Badge>}
          {counts.yellow > 0 && <Badge tone="warn">{counts.yellow} stale</Badge>}
          {counts.red > 0 && <Badge tone="crit">{counts.red} offline</Badge>}
        </div>
      }
    >
      <div className="overflow-y-auto" style={{ maxHeight: 256 }}>
        {rows.length === 0 ? (
          <div className="text-center py-4 text-ink-faint text-xs">No clusters</div>
        ) : (
          <table className="w-full text-[11px] text-ink-muted">
            <tbody>
              {rows.map((c) => {
                const st = clusterStatus(c, latestMetrics);
                const m = latestMetrics[c.id];
                return (
                  <tr key={c.id} className="border-t border-cohesity-border/60 first:border-t-0 hover:bg-surface-overlay/50 transition-colors">
                    <td className="px-1.5 py-1.5 w-5">
                      <ClusterStatusOrb status={st} lastSeen={m?.captured_at} size={8} />
                    </td>
                    <td className="px-1.5 py-1.5 truncate max-w-[140px] text-ink">{c.name}</td>
                    <td className="px-1.5 py-1.5 text-right whitespace-nowrap tnum">
                      {m?.captured_at ? timeAgo(m.captured_at) : <span className="text-status-crit">Never</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
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
  const [activeAlertCount, setActiveAlertCount] = useState(null);
  const [criticalAlertCount, setCriticalAlertCount] = useState(0);
  const [protectionSummary, setProtectionSummary] = useState(null);
  const [alertSummaryMap, setAlertSummaryMap] = useState({});
  const [recentCriticalAlerts, setRecentCriticalAlerts] = useState(null);
  const [insightsData, setInsightsData] = useState(null);

  const trendChartRef = useRef(null);
  const trendResizeRef = useRef(null);

  const { search, setSearch } = useSearch();
  const { toast } = useToast();

  // Single cached snapshot, pre-computed by the poller, replaces the previous
  // per-cluster request fan-out so the dashboard renders the last pull instantly.
  const loadClusters = useCallback(async () => {
    try {
      const { data } = await client.get('/cohesity/dashboard/snapshot');
      setClusters(data.clusters || []);

      const metricsMap = {};
      const historyMap = {};
      for (const [id, rows] of Object.entries(data.metricsHistory || {})) {
        if (rows.length > 0) {
          metricsMap[id] = rows[rows.length - 1];
          historyMap[id] = rows;
        }
      }
      setLatestMetrics(metricsMap);
      setClusterHistory(historyMap);
      setAlertSummaryMap(data.alertSummary || {});
      setActiveAlertCount(data.activeAlertCount ?? null);
      setCriticalAlertCount(data.criticalAlertCount ?? 0);
      setProtectionSummary(data.protectionSummary ?? null);
      setRecentCriticalAlerts(data.recentCriticalAlerts || []);
      setInsightsData(data.insights ?? null);
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
        client.get('/cohesity/alerts?clusterId=' + c.id + '&severity=critical&resolved=0')
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
        client.get(`/cohesity/metrics/${id}/history?days=${trendDays}`)
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
    const toastId = toast({ type: 'loading', title: 'Polling all clusters', message: `Requesting fresh metrics from ${clusters.length} cluster(s)…` });
    const results = await Promise.allSettled(clusters.map(c => client.post('/poller/trigger/' + c.id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    setTimeout(() => {
      setPolling(false);
      loadClusters();
      toast({
        id: toastId,
        type: failed === 0 ? 'success' : 'warning',
        title: failed === 0 ? 'Poll complete' : 'Poll finished with errors',
        message: failed === 0
          ? `All ${clusters.length} cluster(s) refreshed successfully.`
          : `${clusters.length - failed} succeeded, ${failed} failed. Check cluster connectivity.`,
      });
    }, 3000);
  };

  // KPI aggregates
  const kpiEntries = clusters.map(c => latestMetrics[c.id]).filter(Boolean);
  const kpiUsed = kpiEntries.reduce((s, m) => s + (m.used_bytes || 0), 0);
  const kpiCap = kpiEntries.reduce((s, m) => s + (m.total_capacity_bytes || 0), 0);
  const kpiPct = kpiCap > 0 ? (kpiUsed / kpiCap) * 100 : 0;
  const onlineCount = clusters.filter(c => clusterStatus(c, latestMetrics) === 'green').length;
  const successRate = protectionSummary?.successRate;

  return (
    <div className="flex flex-col gap-4">
      {/* Row 0: KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <StatCard
          icon={Database}
          label="Total Capacity"
          value={fmtBytes(kpiCap)}
          sub={`${fmtBytes(Math.max(0, kpiCap - kpiUsed))} free`}
          tone="brand"
          loading={loading}
        />
        <StatCard
          icon={HardDrive}
          label="Storage Used"
          value={`${kpiPct.toFixed(1)}%`}
          sub={fmtBytes(kpiUsed)}
          tone={kpiPct >= 86 ? 'crit' : kpiPct >= 70 ? 'warn' : 'ok'}
          loading={loading}
        />
        <StatCard
          icon={Server}
          label="Clusters Online"
          value={`${onlineCount} / ${clusters.length}`}
          sub={onlineCount === clusters.length ? 'All reachable' : `${clusters.length - onlineCount} need attention`}
          tone={onlineCount === clusters.length ? 'ok' : 'warn'}
          loading={loading}
        />
        <StatCard
          icon={Bell}
          label="Active Alerts"
          value={activeAlertCount ?? '—'}
          sub={criticalAlertCount > 0 ? `${criticalAlertCount} critical` : 'No criticals'}
          tone={criticalAlertCount > 0 ? 'crit' : (activeAlertCount ?? 0) > 0 ? 'warn' : 'ok'}
          loading={activeAlertCount === null && loading}
        />
        <StatCard
          icon={ShieldCheck}
          label="Backup Success (7d)"
          value={successRate != null ? `${successRate}%` : '—'}
          sub={protectionSummary ? `${protectionSummary.failure} failed of ${protectionSummary.total}` : 'Awaiting data'}
          tone={successRate == null ? 'default' : successRate >= 95 ? 'ok' : successRate >= 85 ? 'warn' : 'crit'}
          loading={protectionSummary === null && loading}
        />
      </div>

      {/* Row 1: Intelligent insights */}
      <InsightsPanel initialData={insightsData} />

      {/* Row 2: filter bar */}
      <div className="panel px-3.5 py-2.5 flex flex-wrap items-center gap-2 text-xs">
        <ListFilter size={14} className="text-ink-faint" />
        <select
          value={connectionFilter}
          onChange={e => setConnectionFilter(e.target.value)}
          aria-label="Filter by connection type"
          className="bg-surface-overlay border border-cohesity-border text-xs text-ink rounded-lg px-2.5 py-1.5 focus:border-brand/60 cursor-pointer"
        >
          <option value="all">All Types</option>
          <option value="helios">Helios</option>
          <option value="direct">Direct</option>
        </select>
        <select
          value={tagFilter}
          onChange={e => setTagFilter(e.target.value)}
          aria-label="Filter by tag"
          className="bg-surface-overlay border border-cohesity-border text-xs text-ink rounded-lg px-2.5 py-1.5 focus:border-brand/60 cursor-pointer"
        >
          <option value="all">All Tags</option>
          {allTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
          <input type="checkbox" checked={criticalOnly} onChange={e => setCriticalOnly(e.target.checked)} className="accent-red-500 cursor-pointer" />
          Critical only
        </label>
        <div className="ml-auto flex items-center gap-2">
          {(search || tagFilter !== 'all' || connectionFilter !== 'all' || criticalOnly) && (
            <button onClick={() => { setSearch(''); setTagFilter('all'); setConnectionFilter('all'); setCriticalOnly(false); }} className="flex items-center gap-1 text-xs text-ink-faint hover:text-brand transition-colors cursor-pointer">
              <X size={12} /> Clear filters
            </button>
          )}
          {selectedClusterIds.size > 0 && (
            <button onClick={() => setSelectedClusterIds(new Set())} className="flex items-center gap-1 text-xs text-brand hover:underline cursor-pointer">
              <X size={12} /> Clear selection ({selectedClusterIds.size})
            </button>
          )}
          <span className="text-xs text-ink-faint tnum">{sortedFiltered.length} cluster(s)</span>
          <button
            onClick={handleTriggerAll}
            disabled={polling || clusters.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={13} className={polling ? 'animate-spin' : ''} />
            {polling ? 'Polling…' : 'Poll All'}
          </button>
        </div>
      </div>

      {/* Row 3: two-column main content */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        {/* LEFT COLUMN */}
        <div className="xl:col-span-2 flex flex-col gap-4">
          <GlobalStorageCard latestMetrics={latestMetrics} clusters={clusters} />

          {/* Trend chart card */}
          <div className="panel p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp size={14} className="text-brand" />
              <p className="panel-title">Capacity Growth Trend</p>
            </div>
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
                    labels: { color: CHART.bodyColor, font: { size: 10 }, boxWidth: 12 }
                  },
                  tooltip: {
                    backgroundColor: CHART.tooltipBg,
                    borderColor: CHART.tooltipBorder,
                    borderWidth: 1,
                    titleColor: CHART.titleColor,
                    bodyColor: CHART.bodyColor,
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
                    ticks: { color: CHART.tick, font: { size: 10 }, maxTicksLimit: 12, maxRotation: 0 },
                    grid: { color: CHART.grid },
                  },
                  y: {
                    min: yMin,
                    max: yMax,
                    ticks: { color: CHART.tick, font: { size: 10 }, callback: v => v + ' ' + yUnit.label },
                    title: { display: true, text: `Used (${yUnit.label})`, color: CHART.tick, font: { size: 10 } },
                    grid: { color: CHART.grid },
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
                  <div className="flex items-center justify-between mb-1.5 flex-wrap gap-1">
                    <p className="text-[10px] text-ink-faint">
                      {selectedClusterIds.size > 0 ? `${trendClusters.length} selected cluster(s)` : `${trendClusters.length} cluster(s)`}
                      {hasData && <span className="ml-2">&middot; scroll to zoom &middot; drag to pan</span>}
                    </p>
                    <div className="flex items-center gap-1">
                      {hasData && (
                        <button onClick={handleCsvExport} className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand transition-colors cursor-pointer" title="Export CSV">
                          <Download size={11} /> CSV
                        </button>
                      )}
                      {hasData && (
                        <button onClick={() => trendChartRef.current?.resetZoom()} className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand transition-colors cursor-pointer" title="Reset zoom">
                          <RotateCcw size={11} /> Reset
                        </button>
                      )}
                      {[1, 7, 14, 30].map(d => (
                        <button key={d} onClick={() => setTrendDays(d)}
                          className={`text-[11px] px-2 py-1 rounded-md border transition-colors cursor-pointer tnum ${trendDays === d ? 'bg-brand text-cohesity-black border-brand font-semibold' : 'border-cohesity-border text-ink-muted hover:border-brand/50'}`}>
                          {d}d
                        </button>
                      ))}
                    </div>
                  </div>
                  {trendLoading ? (
                    <div className="flex flex-col gap-2 justify-center" style={{ height: 200 }} role="status" aria-label="Loading trend data">
                      <div className="skeleton h-3 w-1/3" />
                      <div className="skeleton w-full" style={{ height: 140 }} />
                      <div className="skeleton h-3 w-1/2" />
                    </div>
                  ) : !hasData ? (
                    <div className="flex items-center justify-center text-ink-faint text-xs" style={{ height: 200 }}>No trend data available. Select clusters or wait for polling to collect history.</div>
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
                    <div className="w-10 h-1 rounded-full bg-cohesity-border group-hover:bg-brand transition-colors" />
                  </div>
                  {hasData && growthSummaries.some(s => s.growthBytesPerDay > 0) && (
                    <div className="mt-2 border border-cohesity-border rounded-lg overflow-hidden">
                      <div className="overflow-y-auto" style={{ height: growthTableHeight }}>
                        <table className="w-full text-[11px] text-ink-muted">
                          <thead className="bg-surface-base sticky top-0">
                            <tr className="text-ink-faint">
                              <th className="text-left px-2 py-1.5 font-semibold">Cluster</th>
                              <th className="text-right px-2 py-1.5 font-semibold">Growth Rate</th>
                              <th className="text-right px-2 py-1.5 font-semibold">~Days to 85%</th>
                              <th className="text-right px-2 py-1.5 font-semibold">Date to 85%</th>
                              <th className="text-right px-2 py-1.5 font-semibold">~Days to 90%</th>
                              <th className="text-right px-2 py-1.5 font-semibold">Date to 90%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {growthSummaries.filter(s => s.growthBytesPerDay > 0).map((s) => {
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
                                <tr key={s.name} className="border-t border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors">
                                  <td className="px-2 py-1.5 truncate max-w-[120px] text-ink">{s.name}</td>
                                  <td className="text-right px-2 py-1.5 text-brand tnum">{rateStr}</td>
                                  <td className="text-right px-2 py-1.5 tnum">{s.daysUntil85 != null ? Math.round(s.daysUntil85) : '—'}</td>
                                  <td className="text-right px-2 py-1.5 text-status-warn tnum">{toDateStr(s.daysUntil85)}</td>
                                  <td className="text-right px-2 py-1.5 tnum">{s.daysUntilFull != null ? Math.round(s.daysUntilFull) : '—'}</td>
                                  <td className="text-right px-2 py-1.5 text-status-warn tnum">{toDateStr(s.daysUntilFull)}</td>
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
                        className="flex items-center justify-center h-3 cursor-ns-resize group bg-surface-base"
                        title="Drag to resize"
                      >
                        <div className="w-10 h-1 rounded-full bg-cohesity-border group-hover:bg-brand transition-colors" />
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
          <div className="panel p-4 h-full flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <LayoutGrid size={14} className="text-brand" />
                <p className="panel-title">Cluster Health &amp; Alerts</p>
              </div>
              <span className="text-[10px] text-ink-faint tnum">{sortedFiltered.length} clusters</span>
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
                      alertSummary={alertSummaryMap[c.id] || { count: 0, level: 'none' }}
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

      {/* Row 4: bottom panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        <ClusterHealthPanel clusters={clusters} latestMetrics={latestMetrics} />
        <TopClustersBar chartData={chartData} />
        <StorageDistributionTable sortedFiltered={sortedFiltered} latestMetrics={latestMetrics} />
        <RecentAlertsPanel initialAlerts={recentCriticalAlerts} />
      </div>
    </div>
  );
}
