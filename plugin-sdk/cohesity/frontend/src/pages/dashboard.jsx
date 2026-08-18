// Cohesity plugin — Overview/Dashboard page. Ported from
// frontend/src/pages/Dashboard.jsx (1161 lines). Notable adaptations:
//  - client (axios) -> apiFetch; react-chartjs-2 <Bar>/<Line>/<Doughnut> ->
//    local charts.jsx wrappers over window.Chart.
//  - chartjs-plugin-zoom is not a sandbox global — the built-in trend
//    chart's scroll-to-zoom/drag-to-pan/reset-zoom affordances are dropped;
//    the chart itself (with the growth-projection lines) is unchanged.
//  - useSearch() (host SearchContext) is unavailable in the plugin sandbox —
//    replaced with a local search input scoped to this page.
//  - poller trigger calls the canonical /cohesity/poller/trigger* path
//    (the old /poller/trigger* alias is core-only compat for old clients).
import { apiFetch } from '../ui.jsx';
import { LineChart, BarChart, DoughnutChart } from '../charts.jsx';
import {
  Database, HardDrive, Server, Bell, ShieldCheck, RefreshCw, Download,
  TrendingUp, ListFilter, LayoutGrid, AlertTriangle, X,
} from '../icons.jsx';
import { StatCard, Panel, Badge, SkeletonCard, EmptyState, ClusterEmptyIcon, Pagination } from '../ui.jsx';
import { ClusterCard, InsightsPanel } from '../components.jsx';

function toTB(bytes) { return !bytes ? 0 : parseFloat((bytes / 1e12).toFixed(2)); }

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

function getAlertTimestamp(alert) { return alert.first_seen || alert.last_updated || alert.triggered_at || alert.created_at; }

function parseUtcMs(ts) {
  if (!ts) return 0;
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
      <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', backgroundColor: color, boxShadow: `0 0 ${size / 2}px ${color}99`, animation: status === 'green' ? 'orb-pulse 2.5s ease-in-out infinite' : 'none' }} />
    </span>
  );
}

function GlobalStorageCard({ latestMetrics, clusters }) {
  const entries = clusters.map((c) => latestMetrics[c.id]).filter(Boolean);
  const totalUsed = entries.reduce((s, m) => s + (m.used_bytes || 0), 0);
  const totalCap = entries.reduce((s, m) => s + (m.total_capacity_bytes || 0), 0);
  const drValues = entries.map((m) => m.data_reduction_ratio).filter((v) => v != null && v > 0);
  const avgDR = drValues.length > 0 ? drValues.reduce((s, v) => s + v, 0) / drValues.length : 0;
  const pct = totalCap > 0 ? (totalUsed / totalCap) * 100 : 0;
  const pctColor = pct >= 86 ? '#F87171' : pct >= 70 ? '#FBBF24' : '#6CB33F';

  const donutData = {
    datasets: [{ data: [totalUsed, Math.max(0, totalCap - totalUsed)], backgroundColor: [pctColor, '#1E2A36'], borderWidth: 0, borderRadius: 6 }],
  };

  return (
    <Panel title="Global Storage Utilization" icon={Database}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div style={{ position: 'relative', flexShrink: 0, width: 110, height: 110 }}>
          <DoughnutChart data={donutData} height={110} options={{ cutout: '74%', plugins: { legend: { display: false }, tooltip: { enabled: false } } }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span className="tnum" style={{ fontSize: 18, fontWeight: 700, color: 'var(--co-ink)', lineHeight: 1 }}>{pct.toFixed(1)}%</span>
            <span style={{ fontSize: 10, color: 'var(--co-ink-faint)', marginTop: 2 }}>used</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div>
            <p className="tnum" style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: 0 }}>{fmtBytes(totalUsed)} <span style={{ color: 'var(--co-ink-faint)', fontWeight: 400 }}>of</span> {fmtBytes(totalCap)}</p>
            <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: 0 }}>{fmtBytes(Math.max(0, totalCap - totalUsed))} available</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
    labels: top10.map((d) => d.name),
    datasets: [{ label: '% Used', data: top10.map((d) => d.pct), backgroundColor: top10.map((d) => d.pct >= 86 ? '#F87171' : d.pct >= 70 ? '#FBBF24' : '#6CB33F'), borderRadius: 3, barThickness: 'flex', maxBarThickness: 14 }],
  };
  const options = {
    indexAxis: 'y',
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (item) => item.parsed.x.toFixed(1) + '% Used' } } },
    scales: {
      x: { max: 100, ticks: { callback: (v) => parseFloat(Number(v).toFixed(1)) + '%' } },
      y: { grid: { display: false } },
    },
  };
  return (
    <Panel title="Top Clusters by Capacity" icon={TrendingUp}>
      <div style={{ height: 220 }}>
        {top10.length > 0 ? <BarChart data={barData} options={options} height={220} /> : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--co-ink-faint)', fontSize: 12 }}>No data</div>}
      </div>
    </Panel>
  );
}

function StorageDistributionTable({ sortedFiltered, latestMetrics }) {
  const rows = [...sortedFiltered]
    .filter((c) => latestMetrics[c.id]?.used_bytes > 0)
    .sort((a, b) => {
      const mA = latestMetrics[a.id]; const mB = latestMetrics[b.id];
      const pA = mA?.total_capacity_bytes > 0 ? mA.used_bytes / mA.total_capacity_bytes : 0;
      const pB = mB?.total_capacity_bytes > 0 ? mB.used_bytes / mB.total_capacity_bytes : 0;
      return pB - pA;
    })
    .slice(0, 10);

  return (
    <Panel title="Storage Distribution" icon={Database}>
      <div style={{ overflowY: 'auto', maxHeight: 256 }}>
        <table style={{ width: '100%', fontSize: 11, color: 'var(--co-ink-muted)' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--co-surface)' }}>
            <tr style={{ color: 'var(--co-ink-faint)' }}>
              <th style={{ textAlign: 'left', padding: '6px 6px', fontWeight: 600 }}>Cluster</th>
              <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600 }}>Used TB</th>
              <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600 }}>Total TB</th>
              <th style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600 }}>% Used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const m = latestMetrics[c.id];
              const used = toTB(m?.used_bytes);
              const total = toTB(m?.total_capacity_bytes);
              const pct = total > 0 ? (used / total) * 100 : 0;
              const pctColor = pct >= 86 ? 'var(--co-crit)' : pct >= 70 ? 'var(--co-warn)' : 'var(--co-ok)';
              return (
                <tr key={c.id} style={{ borderTop: '1px solid rgba(31,43,55,.6)' }}>
                  <td className="truncate" style={{ padding: '6px 6px', maxWidth: 100, color: 'var(--co-ink)' }}>{c.name}</td>
                  <td className="tnum" style={{ textAlign: 'right', padding: '6px 6px' }}>{used.toFixed(2)}</td>
                  <td className="tnum" style={{ textAlign: 'right', padding: '6px 6px' }}>{total.toFixed(2)}</td>
                  <td className="tnum" style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600, color: pctColor }}>{pct.toFixed(1)}%</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 16, color: 'var(--co-ink-faint)' }}>No data</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function AlertDetailModal({ alert, onClose }) {
  if (!alert) return null;
  const fmtTime = (ts) => { if (!ts) return '—'; try { return new Date(ts).toLocaleString(); } catch { return ts; } };
  const severity = alert.severity || 'info';
  const sevTone = severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'info';
  const msg = alert.message || alert.description || '';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="animate-fade-in" onClick={onClose}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(4px)' }} />
      <div className="panel" style={{ position: 'relative', width: msg.length > 300 ? 'min(860px,90vw)' : msg.length > 120 ? 'min(680px,90vw)' : 'min(520px,90vw)', padding: 24 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={18} style={{ color: severity === 'critical' ? 'var(--co-crit)' : severity === 'warning' ? 'var(--co-warn)' : 'var(--co-info)' }} />
            <div>
              <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>{alert.alert_type || 'Alert'}</p>
              <Badge tone={sevTone} style={{ marginTop: 4, textTransform: 'uppercase' }}>{severity}</Badge>
            </div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--co-ink-faint)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--co-ink-faint)', width: 80, flexShrink: 0 }}>Cluster</span><span style={{ color: 'var(--co-ink)' }}>{alert.cluster_name || alert.cluster_id || '—'}</span></div>
          <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--co-ink-faint)', width: 80, flexShrink: 0 }}>Triggered</span><span className="tnum" style={{ color: 'var(--co-ink)' }}>{fmtTime(getAlertTimestamp(alert))}</span></div>
          {alert.resolved_at && <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--co-ink-faint)', width: 80, flexShrink: 0 }}>Resolved</span><span className="tnum" style={{ color: 'var(--co-ink)' }}>{fmtTime(alert.resolved_at)}</span></div>}
          {msg && <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--co-ink-faint)', width: 80, flexShrink: 0 }}>Message</span><span style={{ color: 'var(--co-ink)', lineHeight: 1.6 }}>{msg}</span></div>}
        </div>
      </div>
    </div>
  );
}

function RecentAlertsPanel({ initialAlerts }) {
  const [alerts, setAlerts] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState(null);

  React.useEffect(() => {
    if (initialAlerts !== undefined && initialAlerts !== null) {
      const sorted = [...initialAlerts].sort((a, b) => new Date(getAlertTimestamp(b) || 0) - new Date(getAlertTimestamp(a) || 0));
      setAlerts(sorted.slice(0, 10));
      setLoading(false);
      return;
    }
    apiFetch('/cohesity/alerts?dismissed=0&resolved=0&severity=critical')
      .then((data) => {
        const sorted = [...data].sort((a, b) => new Date(getAlertTimestamp(b) || 0) - new Date(getAlertTimestamp(a) || 0));
        setAlerts(sorted.slice(0, 10));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [initialAlerts]);

  const fmtTime = (ts) => { if (!ts) return '—'; try { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`; } catch { return ts; } };

  return (
    <>
      {selected && <AlertDetailModal alert={selected} onClose={() => setSelected(null)} />}
      <Panel title="Recent Critical Alerts" icon={Bell}>
        <div style={{ overflowY: 'auto', maxHeight: 256 }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }} aria-hidden="true">
              {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 28, width: '100%' }} />)}
            </div>
          ) : alerts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--co-ok)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <ShieldCheck size={14} /> No active critical alerts
            </div>
          ) : (
            <table style={{ width: '100%', fontSize: 11, color: 'var(--co-ink-muted)' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--co-surface)' }}>
                <tr style={{ color: 'var(--co-ink-faint)' }}>
                  <th style={{ textAlign: 'left', padding: '6px 6px', fontWeight: 600 }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '6px 6px', fontWeight: 600 }}>Cluster</th>
                  <th style={{ textAlign: 'left', padding: '6px 6px', fontWeight: 600 }}>Issue</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => (
                  <tr key={a.id || i} onClick={() => setSelected(a)} style={{ cursor: 'pointer', borderTop: '1px solid rgba(31,43,55,.6)' }}>
                    <td className="tnum" style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>{fmtTime(getAlertTimestamp(a))}</td>
                    <td className="truncate" style={{ padding: '6px 6px', maxWidth: 80, color: 'var(--co-ink)' }}>{a.cluster_name || a.cluster_id || '—'}</td>
                    <td className="truncate" style={{ padding: '6px 6px', maxWidth: 110, color: 'var(--co-warn)' }}>{a.alert_type || a.message || a.description || '—'}</td>
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
    <Panel title="Cluster Status" icon={Server} actions={
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }} className="tnum">
        {counts.green > 0 && <Badge tone="ok">{counts.green} online</Badge>}
        {counts.yellow > 0 && <Badge tone="warn">{counts.yellow} stale</Badge>}
        {counts.red > 0 && <Badge tone="crit">{counts.red} offline</Badge>}
      </div>
    }>
      <div style={{ overflowY: 'auto', maxHeight: 256 }}>
        {rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 16, color: 'var(--co-ink-faint)', fontSize: 12 }}>No clusters</div>
        ) : (
          <table style={{ width: '100%', fontSize: 11, color: 'var(--co-ink-muted)' }}>
            <tbody>
              {rows.map((c) => {
                const st = clusterStatus(c, latestMetrics);
                const m = latestMetrics[c.id];
                return (
                  <tr key={c.id} style={{ borderTop: '1px solid rgba(31,43,55,.6)' }}>
                    <td style={{ padding: '6px 6px', width: 20 }}><ClusterStatusOrb status={st} lastSeen={m?.captured_at} size={8} /></td>
                    <td className="truncate" style={{ padding: '6px 6px', maxWidth: 140, color: 'var(--co-ink)' }}>{c.name}</td>
                    <td className="tnum" style={{ padding: '6px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {m?.captured_at ? timeAgo(m.captured_at) : <span style={{ color: 'var(--co-crit)' }}>Never</span>}
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

export default function DashboardPage() {
  const [clusters, setClusters] = React.useState([]);
  const [latestMetrics, setLatestMetrics] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [connectionFilter, setConnectionFilter] = React.useState('all');
  const [tagFilter, setTagFilter] = React.useState('all');
  const [criticalOnly, setCriticalOnly] = React.useState(false);
  const [criticalIds, setCriticalIds] = React.useState(new Set());
  const [polling, setPolling] = React.useState(false);
  const [selectedClusterIds, setSelectedClusterIds] = React.useState(new Set());
  const [trendDays, setTrendDays] = React.useState(1);
  const [trendHistory, setTrendHistory] = React.useState({});
  const [trendLoading, setTrendLoading] = React.useState(false);
  const [clusterPage, setClusterPage] = React.useState(0);
  const [clusterHistory, setClusterHistory] = React.useState({});
  const [activeAlertCount, setActiveAlertCount] = React.useState(null);
  const [criticalAlertCount, setCriticalAlertCount] = React.useState(0);
  const [protectionSummary, setProtectionSummary] = React.useState(null);
  const [alertSummaryMap, setAlertSummaryMap] = React.useState({});
  const [recentCriticalAlerts, setRecentCriticalAlerts] = React.useState(null);
  const [insightsData, setInsightsData] = React.useState(null);

  const loadClusters = React.useCallback(async () => {
    try {
      const data = await apiFetch('/cohesity/dashboard/snapshot');
      setClusters(data.clusters || []);
      const metricsMap = {};
      const historyMap = {};
      for (const [id, rows] of Object.entries(data.metricsHistory || {})) {
        if (rows.length > 0) { metricsMap[id] = rows[rows.length - 1]; historyMap[id] = rows; }
      }
      setLatestMetrics(metricsMap);
      setClusterHistory(historyMap);
      setAlertSummaryMap(data.alertSummary || {});
      setActiveAlertCount(data.activeAlertCount ?? null);
      setCriticalAlertCount(data.criticalAlertCount ?? 0);
      setProtectionSummary(data.protectionSummary ?? null);
      setRecentCriticalAlerts(data.recentCriticalAlerts || []);
      setInsightsData(data.insights ?? null);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { loadClusters(); }, [loadClusters]);

  React.useEffect(() => {
    if (!criticalOnly || clusters.length === 0) return;
    Promise.allSettled(clusters.map((c) => apiFetch(`/cohesity/alerts?clusterId=${c.id}&severity=critical&resolved=0`).then((rows) => ({ id: c.id, hasCritical: rows.length > 0 }))))
      .then((results) => setCriticalIds(new Set(results.filter((r) => r.status === 'fulfilled' && r.value.hasCritical).map((r) => r.value.id))));
  }, [criticalOnly, clusters]);

  const toggleSelect = (id) => setSelectedClusterIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const allTags = [...new Set(clusters.flatMap((c) => (c.tags || '').split(',').map((t) => t.trim()).filter(Boolean)))].sort();

  const filtered = clusters.filter((c) => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (connectionFilter !== 'all' && c.connection_type !== connectionFilter) return false;
    if (tagFilter !== 'all' && !(c.tags || '').split(',').map((t) => t.trim()).includes(tagFilter)) return false;
    if (criticalOnly && !criticalIds.has(c.id)) return false;
    return true;
  });

  const CLUSTER_PAGE_SIZE = 6;

  const sortedFiltered = [...filtered].sort((a, b) => {
    const mA = latestMetrics[a.id]; const mB = latestMetrics[b.id];
    const pA = mA?.total_capacity_bytes > 0 ? mA.used_bytes / mA.total_capacity_bytes : 0;
    const pB = mB?.total_capacity_bytes > 0 ? mB.used_bytes / mB.total_capacity_bytes : 0;
    return pB - pA;
  });

  const activeSet = selectedClusterIds.size > 0 ? sortedFiltered.filter((c) => selectedClusterIds.has(c.id)) : sortedFiltered;

  const clusterTotalPages = Math.max(1, Math.ceil(sortedFiltered.length / CLUSTER_PAGE_SIZE));
  const clusterSafePage = Math.min(clusterPage, clusterTotalPages - 1);
  const clusterPageItems = sortedFiltered.slice(clusterSafePage * CLUSTER_PAGE_SIZE, (clusterSafePage + 1) * CLUSTER_PAGE_SIZE);

  const chartData = activeSet.map((c) => {
    const m = latestMetrics[c.id];
    if (!m) return null;
    const used = toTB(m.used_bytes);
    const total = toTB(m.total_capacity_bytes);
    const pct = total > 0 ? parseFloat(((used / total) * 100).toFixed(1)) : 0;
    return { name: c.name.length > 16 ? c.name.slice(0, 14) + '...' : c.name, used, pct };
  }).filter(Boolean).sort((a, b) => b.pct - a.pct);

  React.useEffect(() => {
    const ids = activeSet.map((c) => c.id);
    if (ids.length === 0) { setTrendHistory({}); return; }
    setTrendLoading(true);
    Promise.allSettled(ids.map((id) => apiFetch(`/cohesity/metrics/${id}/history?days=${trendDays}`).then((rows) => ({ id, rows }))))
      .then((results) => {
        const map = {};
        for (const r of results) if (r.status === 'fulfilled') map[r.value.id] = r.value.rows;
        setTrendHistory(map);
      })
      .finally(() => setTrendLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSet.map((c) => c.id).join(','), trendDays]);

  const handleTriggerAll = async () => {
    setPolling(true);
    const results = await Promise.allSettled(clusters.map((c) => apiFetch(`/cohesity/poller/trigger/${c.id}`, { method: 'POST' })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setTimeout(() => { setPolling(false); loadClusters(); }, 3000);
    return failed;
  };

  const kpiEntries = clusters.map((c) => latestMetrics[c.id]).filter(Boolean);
  const kpiUsed = kpiEntries.reduce((s, m) => s + (m.used_bytes || 0), 0);
  const kpiCap = kpiEntries.reduce((s, m) => s + (m.total_capacity_bytes || 0), 0);
  const kpiPct = kpiCap > 0 ? (kpiUsed / kpiCap) * 100 : 0;
  const onlineCount = clusters.filter((c) => clusterStatus(c, latestMetrics) === 'green').length;
  const successRate = protectionSummary?.successRate;

  // Trend chart data build (growth projection retained; zoom/pan dropped).
  const TREND_COLORS = ['#6CB33F', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#f97316', '#ec4899', '#10b981', '#6366f1', '#84cc16'];
  const allTimestamps = [...new Set(Object.values(trendHistory).flatMap((rows) => rows.map((r) => r.captured_at).filter(Boolean)))].sort();
  const trendClusters = activeSet.filter((c) => trendHistory[c.id]?.length > 0);
  const allUsedBytes = Object.values(trendHistory).flatMap((rows) => rows.map((r) => r.used_bytes || 0));
  const maxBytes = Math.max(...allUsedBytes, 1);
  const yUnit = maxBytes >= 1e15 ? { label: 'PB', div: 1e15 } : maxBytes >= 1e12 ? { label: 'TB', div: 1e12 } : maxBytes >= 1e9 ? { label: 'GB', div: 1e9 } : { label: 'MB', div: 1e6 };

  const trendDatasets = trendClusters.map((c, i) => {
    const rows = trendHistory[c.id] || [];
    const byTs = {};
    for (const r of rows) if (r.captured_at && r.used_bytes != null) byTs[r.captured_at] = parseFloat((r.used_bytes / yUnit.div).toFixed(3));
    const color = TREND_COLORS[i % TREND_COLORS.length];
    return { label: c.name, data: allTimestamps.map((ts) => byTs[ts] ?? null), borderColor: color, backgroundColor: color + '22', fill: false, tension: 0.3, pointRadius: allTimestamps.length > 50 ? 0 : 3, borderWidth: 2, spanGaps: true };
  });

  const hasData = allTimestamps.length > 0 && trendDatasets.length > 0;
  const formatLabel = (ts) => { if (!ts) return ''; return ts.replace('T', ' ').slice(5, 16); };
  const trendChartData = { labels: allTimestamps.map(formatLabel), datasets: trendDatasets };
  const trendOptions = {
    plugins: {
      legend: { display: trendClusters.length <= 12 },
      tooltip: { callbacks: { label: (item) => { const raw = item.parsed.y; return raw == null ? `${item.dataset.label}: —` : `${item.dataset.label}: ${raw.toFixed(2)} ${yUnit.label} used`; } } },
    },
    scales: { y: { title: { display: true, text: `Used (${yUnit.label})` } } },
  };

  const handleCsvExport = () => {
    const rows = ['Timestamp,ClusterName,UsedBytes,TotalCapacityBytes'];
    for (const c of trendClusters) for (const r of (trendHistory[c.id] || [])) rows.push(`${r.captured_at},${JSON.stringify(c.name)},${r.used_bytes ?? ''},${r.total_capacity_bytes ?? ''}`);
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `storage-trend-${trendDays}d.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5" style={{ gap: 12 }}>
        <StatCard icon={Database} label="Total Capacity" value={fmtBytes(kpiCap)} sub={`${fmtBytes(Math.max(0, kpiCap - kpiUsed))} free`} tone="brand" loading={loading} />
        <StatCard icon={HardDrive} label="Storage Used" value={`${kpiPct.toFixed(1)}%`} sub={fmtBytes(kpiUsed)} tone={kpiPct >= 86 ? 'crit' : kpiPct >= 70 ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={Server} label="Clusters Online" value={`${onlineCount} / ${clusters.length}`} sub={onlineCount === clusters.length ? 'All reachable' : `${clusters.length - onlineCount} need attention`} tone={onlineCount === clusters.length ? 'ok' : 'warn'} loading={loading} />
        <StatCard icon={Bell} label="Active Alerts" value={activeAlertCount ?? '—'} sub={criticalAlertCount > 0 ? `${criticalAlertCount} critical` : 'No criticals'} tone={criticalAlertCount > 0 ? 'crit' : (activeAlertCount ?? 0) > 0 ? 'warn' : 'ok'} loading={activeAlertCount === null && loading} />
        <StatCard icon={ShieldCheck} label="Backup Success (7d)" value={successRate != null ? `${successRate}%` : '—'} sub={protectionSummary ? `${protectionSummary.failure} failed of ${protectionSummary.total}` : 'Awaiting data'} tone={successRate == null ? 'default' : successRate >= 95 ? 'ok' : successRate >= 85 ? 'warn' : 'crit'} loading={protectionSummary === null && loading} />
      </div>

      <InsightsPanel initialData={insightsData} />

      <div className="panel" style={{ padding: '10px 14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <ListFilter size={14} style={{ color: 'var(--co-ink-faint)' }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clusters…" className="co-input" style={{ width: 160 }} />
        <select value={connectionFilter} onChange={(e) => setConnectionFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
          <option value="all">All Types</option><option value="helios">Helios</option><option value="direct">Direct</option>
        </select>
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
          <option value="all">All Tags</option>
          {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--co-ink-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} className="accent-red-500" /> Critical only
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {(search || tagFilter !== 'all' || connectionFilter !== 'all' || criticalOnly) && (
            <button onClick={() => { setSearch(''); setTagFilter('all'); setConnectionFilter('all'); setCriticalOnly(false); }} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--co-ink-faint)', background: 'none', border: 'none', cursor: 'pointer' }}>
              <X size={12} /> Clear filters
            </button>
          )}
          {selectedClusterIds.size > 0 && (
            <button onClick={() => setSelectedClusterIds(new Set())} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--co-brand)', background: 'none', border: 'none', cursor: 'pointer' }}>
              <X size={12} /> Clear selection ({selectedClusterIds.size})
            </button>
          )}
          <span className="tnum" style={{ fontSize: 12, color: 'var(--co-ink-faint)' }}>{sortedFiltered.length} cluster(s)</span>
          <button onClick={handleTriggerAll} disabled={polling || clusters.length === 0} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}>
            <RefreshCw size={13} className={polling ? 'animate-spin' : ''} /> {polling ? 'Polling…' : 'Poll All'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5" style={{ gap: 16 }}>
        <div className="xl:col-span-2" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <GlobalStorageCard latestMetrics={latestMetrics} clusters={clusters} />

          <div className="panel" style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <TrendingUp size={14} style={{ color: 'var(--co-brand)' }} />
              <p className="panel-title" style={{ margin: 0 }}>Capacity Growth Trend</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 4 }}>
              <p style={{ fontSize: 10, color: 'var(--co-ink-faint)', margin: 0 }}>{selectedClusterIds.size > 0 ? `${trendClusters.length} selected cluster(s)` : `${trendClusters.length} cluster(s)`}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {hasData && (
                  <button onClick={handleCsvExport} className="co-btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}><Download size={11} /> CSV</button>
                )}
                {[1, 7, 14, 30].map((d) => (
                  <button key={d} onClick={() => setTrendDays(d)} className="tnum"
                    style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: `1px solid ${trendDays === d ? 'var(--co-brand)' : 'var(--co-border)'}`, background: trendDays === d ? 'var(--co-brand)' : 'transparent', color: trendDays === d ? '#0B1015' : 'var(--co-ink-muted)', fontWeight: trendDays === d ? 600 : 400, cursor: 'pointer' }}>
                    {d}d
                  </button>
                ))}
              </div>
            </div>
            {trendLoading ? (
              <div style={{ height: 200 }} className="skeleton" />
            ) : !hasData ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--co-ink-faint)', fontSize: 12 }}>No trend data available. Select clusters or wait for polling to collect history.</div>
            ) : (
              <LineChart data={trendChartData} options={trendOptions} height={220} />
            )}
          </div>
        </div>

        <div className="xl:col-span-3">
          <div className="panel" style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <LayoutGrid size={14} style={{ color: 'var(--co-brand)' }} />
                <p className="panel-title" style={{ margin: 0 }}>Cluster Health &amp; Alerts</p>
              </div>
              <span className="tnum" style={{ fontSize: 10, color: 'var(--co-ink-faint)' }}>{sortedFiltered.length} clusters</span>
            </div>
            {loading ? (
              <div className="grid grid-cols-2 lg:grid-cols-3" style={{ gap: 8 }}>
                {[...Array(6)].map((_, i) => <SkeletonCard key={i} />)}
              </div>
            ) : sortedFiltered.length === 0 ? (
              <EmptyState icon={<ClusterEmptyIcon />} title="No clusters found" message={clusters.length === 0 ? 'No clusters configured.' : 'No clusters match the current filters.'} />
            ) : (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-3" style={{ gap: 8 }}>
                  {clusterPageItems.map((c) => (
                    <ClusterCard key={c.id} cluster={c} historyRows={clusterHistory[c.id]} alertSummary={alertSummaryMap[c.id] || { count: 0, level: 'none' }} selected={selectedClusterIds.has(c.id)} onSelect={toggleSelect} onTagClick={setTagFilter} />
                  ))}
                </div>
                {clusterTotalPages > 1 && (
                  <Pagination page={clusterSafePage} totalPages={clusterTotalPages} totalItems={sortedFiltered.length} pageSize={CLUSTER_PAGE_SIZE} onPage={setClusterPage} compact />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4" style={{ gap: 16 }}>
        <ClusterHealthPanel clusters={clusters} latestMetrics={latestMetrics} />
        <TopClustersBar chartData={chartData} />
        <StorageDistributionTable sortedFiltered={sortedFiltered} latestMetrics={latestMetrics} />
        <RecentAlertsPanel initialAlerts={recentCriticalAlerts} />
      </div>
    </div>
  );
}
