// Cohesity plugin — Analytics page. Ported from frontend/src/pages/AnalyticsPage.jsx.
// Backup job analytics (job trend / top errors / per-cluster failures) and
// replication data flow (mesh diagrams + flows table). react-chartjs-2 <Bar>
// usages become the kit's BarChart; the two ReplicationMesh SVGs are pure
// inline SVG in the source (no chartjs-plugin-zoom involved), so they port
// as-is with no interaction dropped.
import { apiFetch, useToast, PageHeader, StatCard, Spinner, LastUpdated, RefreshButton, fmtBytes } from '../ui.jsx';
import { BarChart } from '../charts.jsx';
import { TrendingUp } from '../icons.jsx';

function formatLag(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function successColor(rate) {
  if (rate >= 90) return 'var(--co-ok)';
  if (rate >= 70) return 'var(--co-warn)';
  return 'var(--co-crit)';
}

function SectionHeading({ children }) {
  return (
    <h2 className="uppercase tracking-wider" style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '4px 0 12px' }}>
      {children}
    </h2>
  );
}

function ReplicationMesh({ flows, title }) {
  const [hoveredFlow, setHoveredFlow] = React.useState(null);
  const [filterSource, setFilterSource] = React.useState('');
  const [filterTarget, setFilterTarget] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState('all');

  const allSources = React.useMemo(() => [...new Set(flows.map((f) => f.sourceClusterName))].sort(), [flows]);
  const allTargets = React.useMemo(() => [...new Set(flows.map((f) => f.targetClusterName))].sort(), [flows]);

  const filteredFlows = React.useMemo(() => flows.filter((f) => {
    if (filterSource && f.sourceClusterName !== filterSource) return false;
    if (filterTarget && f.targetClusterName !== filterTarget) return false;
    if (filterStatus === 'healthy' && f.failureCount > 0) return false;
    if (filterStatus === 'degraded' && (f.failureCount === 0 || f.failureCount / f.runCount >= 0.2)) return false;
    if (filterStatus === 'failed' && f.failureCount / f.runCount < 0.2) return false;
    return true;
  }), [flows, filterSource, filterTarget, filterStatus]);

  const { nodes, nodePos, maxBytes, animDurations } = React.useMemo(() => {
    const nameSet = new Set();
    filteredFlows.forEach((f) => { nameSet.add(f.sourceClusterName); nameSet.add(f.targetClusterName); });
    const nodes = [...nameSet];
    const nodePos = {};
    nodes.forEach((name, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      const x = 250 + 215 * Math.cos(angle);
      const y = 255 + 220 * Math.sin(angle);
      nodePos[name] = { x, y };
    });
    const maxBytes = Math.max(...filteredFlows.map((f) => f.totalBytesTransferred || 0), 1);
    const animDurations = filteredFlows.map(() => 2 + Math.random() * 2);
    return { nodes, nodePos, maxBytes, animDurations };
  }, [filteredFlows]);

  const hasFilters = filterSource || filterTarget || filterStatus !== 'all';
  const selectCls = 'co-input';
  const selectStyle = { width: 'auto', fontSize: 11, padding: '4px 8px' };

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: 0 }}>{title}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select className={selectCls} style={selectStyle} value={filterSource} onChange={(e) => setFilterSource(e.target.value)}>
            <option value="">All Sources</option>
            {allSources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className={selectCls} style={selectStyle} value={filterTarget} onChange={(e) => setFilterTarget(e.target.value)}>
            <option value="">All Targets</option>
            {allTargets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className={selectCls} style={selectStyle} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="all">All Status</option>
            <option value="healthy">Healthy only</option>
            <option value="degraded">Degraded (&lt;20% fail)</option>
            <option value="failed">Failed (&ge;20% fail)</option>
          </select>
          {hasFilters && (
            <button className="co-btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => { setFilterSource(''); setFilterTarget(''); setFilterStatus('all'); }}>
              &times; Clear
            </button>
          )}
        </div>
      </div>

      {filteredFlows.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 520, fontSize: 12, color: 'var(--co-ink-faint)' }}>
          No flows match the current filters
        </div>
      ) : (
        <svg width="100%" height="520" viewBox="0 0 500 520">
          {filteredFlows.map((flow, i) => {
            const src = nodePos[flow.sourceClusterName];
            const tgt = nodePos[flow.targetClusterName];
            if (!src || !tgt) return null;
            const isLongRunning = flow.longRunningCount > 0;
            const failPct = flow.runCount > 0 ? flow.failureCount / flow.runCount : 0;
            const color = isLongRunning ? '#f59e0b' : (flow.failureCount === 0 ? '#6CB33F' : failPct < 0.2 ? '#f59e0b' : '#ef4444');
            const strokeWidth = Math.max(1, Math.min(5, (flow.totalBytesTransferred || 0) / maxBytes * 5));
            const midX = (src.x + tgt.x) / 2;
            const midY = (src.y + tgt.y) / 2;
            return (
              <g key={i}>
                <line x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={color} strokeWidth={strokeWidth} strokeDasharray={isLongRunning ? '6 4' : undefined} opacity={0.5} />
                <line
                  x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={color} strokeWidth={Math.max(20, strokeWidth + 14)}
                  strokeOpacity={0.01} strokeLinecap="round" pointerEvents="stroke" style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredFlow({ flow })} onMouseLeave={() => setHoveredFlow(null)} onMouseMove={() => setHoveredFlow({ flow })}
                />
                <text x={midX} y={midY - 8} fontSize={8} fill="#E8EDF2" textAnchor="middle" opacity={0.9} style={{ pointerEvents: 'none', fontWeight: 500 }}>
                  {flow.sourceClusterName}&harr;{flow.targetClusterName}
                </text>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion dur={`${animDurations[i]}s`} repeatCount="indefinite" path={`M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`} />
                </circle>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion dur={`${animDurations[i]}s`} repeatCount="indefinite" begin={`${animDurations[i] / 2}s`} path={`M ${tgt.x} ${tgt.y} L ${src.x} ${src.y}`} />
                </circle>
              </g>
            );
          })}
          {nodes.map((name) => {
            const pos = nodePos[name];
            const isSource = filteredFlows.some((f) => f.sourceClusterName === name);
            return (
              <g key={name} style={{ cursor: 'pointer' }} onClick={() => setFilterSource(filterSource === name ? '' : name)}>
                <circle cx={pos.x} cy={pos.y} r={18} fill="#131B23" stroke={filterSource === name ? '#E8EDF2' : isSource ? '#6CB33F' : '#3b82f6'} strokeWidth={filterSource === name ? 2.5 : 1.5} />
                <text x={pos.x} y={pos.y + 4} fontSize={9} fill="#E8EDF2" textAnchor="middle" dominantBaseline="middle">{isSource ? '▶' : '●'}</text>
                <text x={pos.x} y={pos.y + 28} fontSize={9} fill="#94A3B3" textAnchor="middle">{name.length > 12 ? name.slice(0, 12) : name}</text>
              </g>
            );
          })}
          {hoveredFlow && (
            <g>
              <rect x={150} y={120} width={200} height={85} rx={6} fill="#0B1015" stroke="#2A3845" />
              <text x={160} y={138} fontSize={10} fill="#E8EDF2">{hoveredFlow.flow.sourceClusterName} {'→'} {hoveredFlow.flow.targetClusterName}</text>
              <text x={160} y={152} fontSize={10} fill="#94A3B3">Runs: {hoveredFlow.flow.runCount} | Bytes: {fmtBytes(hoveredFlow.flow.totalBytesTransferred)}</text>
              <text x={160} y={166} fontSize={10} fill="#94A3B3">Avg Lag: {formatLag(hoveredFlow.flow.avgLagSeconds)}</text>
              {hoveredFlow.flow.longRunningCount > 0 && (
                <>
                  <text x={160} y={180} fontSize={10} fill="#f59e0b">Long-running: {hoveredFlow.flow.longRunningCount}</text>
                  {hoveredFlow.flow.oldestLongRunningSeconds != null && (
                    <text x={160} y={194} fontSize={10} fill="#f59e0b">Oldest: {formatDuration(hoveredFlow.flow.oldestLongRunningSeconds)}</text>
                  )}
                </>
              )}
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

function SiteReplicationMesh({ flows }) {
  const [hoveredSiteFlow, setHoveredSiteFlow] = React.useState(null);
  const [filterSourceSite, setFilterSourceSite] = React.useState('');
  const [filterTargetSite, setFilterTargetSite] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState('all');

  const getSiteCode = (clusterName) => {
    if (!clusterName || clusterName.trim().length < 4) return 'unkn';
    return clusterName.trim().toLowerCase().slice(0, 4);
  };
  const getSiteDisplay = (code) => code.toUpperCase();

  const siteAggregates = React.useMemo(() => {
    const agg = {};
    flows.forEach((flow) => {
      const srcSite = getSiteCode(flow.sourceClusterName);
      const tgtSite = getSiteCode(flow.targetClusterName);
      const key = `${srcSite}|${tgtSite}`;
      if (!agg[key]) {
        agg[key] = { sourceSite: srcSite, targetSite: tgtSite, runCount: 0, successCount: 0, failureCount: 0, totalBytesTransferred: 0, longRunningCount: 0, oldestLongRunningSeconds: null, lagSum: 0, lagCount: 0 };
      }
      agg[key].runCount += flow.runCount || 0;
      agg[key].successCount += flow.successCount || 0;
      agg[key].failureCount += flow.failureCount || 0;
      agg[key].totalBytesTransferred += flow.totalBytesTransferred || 0;
      agg[key].longRunningCount += flow.longRunningCount || 0;
      if (flow.oldestLongRunningSeconds != null) {
        agg[key].oldestLongRunningSeconds = agg[key].oldestLongRunningSeconds == null ? flow.oldestLongRunningSeconds : Math.max(agg[key].oldestLongRunningSeconds, flow.oldestLongRunningSeconds);
      }
      if (flow.avgLagSeconds != null) {
        agg[key].lagSum += (flow.avgLagSeconds * (flow.runCount || 1));
        agg[key].lagCount += (flow.runCount || 1);
      }
    });
    Object.values(agg).forEach((item) => { item.avgLagSeconds = item.lagCount > 0 ? item.lagSum / item.lagCount : 0; });
    return Object.values(agg);
  }, [flows]);

  const allSourceSites = React.useMemo(() => [...new Set(siteAggregates.map((s) => s.sourceSite))].sort(), [siteAggregates]);
  const allTargetSites = React.useMemo(() => [...new Set(siteAggregates.map((s) => s.targetSite))].sort(), [siteAggregates]);

  const filteredSiteFlows = React.useMemo(() => siteAggregates.filter((sf) => {
    if (filterSourceSite && sf.sourceSite !== filterSourceSite) return false;
    if (filterTargetSite && sf.targetSite !== filterTargetSite) return false;
    if (filterStatus === 'healthy' && sf.failureCount > 0) return false;
    if (filterStatus === 'degraded' && (sf.failureCount === 0 || sf.failureCount / sf.runCount >= 0.2)) return false;
    if (filterStatus === 'failed' && sf.failureCount / sf.runCount < 0.2) return false;
    return true;
  }), [siteAggregates, filterSourceSite, filterTargetSite, filterStatus]);

  const { siteNodes, siteNodePos, maxSiteBytes, siteAnimDurations } = React.useMemo(() => {
    const siteSet = new Set();
    filteredSiteFlows.forEach((sf) => { siteSet.add(sf.sourceSite); siteSet.add(sf.targetSite); });
    const siteNodes = [...siteSet];
    const siteNodePos = {};
    siteNodes.forEach((site, i) => {
      const angle = (2 * Math.PI * i) / siteNodes.length - Math.PI / 2;
      const x = 250 + 215 * Math.cos(angle);
      const y = 255 + 220 * Math.sin(angle);
      siteNodePos[site] = { x, y };
    });
    const maxSiteBytes = Math.max(...filteredSiteFlows.map((s) => s.totalBytesTransferred || 0), 1);
    const siteAnimDurations = filteredSiteFlows.map(() => 2 + Math.random() * 2);
    return { siteNodes, siteNodePos, maxSiteBytes, siteAnimDurations };
  }, [filteredSiteFlows]);

  const hasFilters = filterSourceSite || filterTargetSite || filterStatus !== 'all';
  const selectCls = 'co-input';
  const selectStyle = { width: 'auto', fontSize: 11, padding: '4px 8px' };

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 4px' }}>Site-Level Replication Mesh</p>
        <p style={{ fontSize: 10, color: 'var(--co-ink-faint)', margin: 0 }}>Site derived from first 4 characters of cluster names</p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select className={selectCls} style={selectStyle} value={filterSourceSite} onChange={(e) => setFilterSourceSite(e.target.value)}>
          <option value="">All Sources</option>
          {allSourceSites.map((s) => <option key={s} value={s}>{getSiteDisplay(s)}</option>)}
        </select>
        <select className={selectCls} style={selectStyle} value={filterTargetSite} onChange={(e) => setFilterTargetSite(e.target.value)}>
          <option value="">All Targets</option>
          {allTargetSites.map((t) => <option key={t} value={t}>{getSiteDisplay(t)}</option>)}
        </select>
        <select className={selectCls} style={selectStyle} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All Status</option>
          <option value="healthy">Healthy only</option>
          <option value="degraded">Degraded (&lt;20% fail)</option>
          <option value="failed">Failed (&ge;20% fail)</option>
        </select>
        {hasFilters && (
          <button className="co-btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => { setFilterSourceSite(''); setFilterTargetSite(''); setFilterStatus('all'); }}>
            &times; Clear
          </button>
        )}
      </div>

      {filteredSiteFlows.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 520, fontSize: 12, color: 'var(--co-ink-faint)' }}>
          No site flows match the current filters
        </div>
      ) : (
        <svg width="100%" height="520" viewBox="0 0 500 520">
          {filteredSiteFlows.map((siteFlow, i) => {
            const src = siteNodePos[siteFlow.sourceSite];
            const tgt = siteNodePos[siteFlow.targetSite];
            if (!src || !tgt) return null;
            const isLongRunning = siteFlow.longRunningCount > 0;
            const failPct = siteFlow.runCount > 0 ? siteFlow.failureCount / siteFlow.runCount : 0;
            const color = isLongRunning ? '#f59e0b' : (siteFlow.failureCount === 0 ? '#6CB33F' : failPct < 0.2 ? '#f59e0b' : '#ef4444');
            const strokeWidth = Math.max(1, Math.min(5, (siteFlow.totalBytesTransferred || 0) / maxSiteBytes * 5));
            const midX = (src.x + tgt.x) / 2;
            const midY = (src.y + tgt.y) / 2;
            const sourceDisplay = getSiteDisplay(siteFlow.sourceSite);
            const targetDisplay = getSiteDisplay(siteFlow.targetSite);
            return (
              <g key={i}>
                <line x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={color} strokeWidth={strokeWidth} strokeDasharray={isLongRunning ? '6 4' : undefined} opacity={0.5} />
                <line
                  x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={color} strokeWidth={Math.max(20, strokeWidth + 14)}
                  strokeOpacity={0.01} strokeLinecap="round" pointerEvents="stroke" style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredSiteFlow({ siteFlow })} onMouseLeave={() => setHoveredSiteFlow(null)} onMouseMove={() => setHoveredSiteFlow({ siteFlow })}
                />
                <text x={midX} y={midY - 8} fontSize={8} fill="#E8EDF2" textAnchor="middle" opacity={0.9} style={{ pointerEvents: 'none', fontWeight: 500 }}>
                  {sourceDisplay}&harr;{targetDisplay}
                </text>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion dur={`${siteAnimDurations[i]}s`} repeatCount="indefinite" path={`M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`} />
                </circle>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion dur={`${siteAnimDurations[i]}s`} repeatCount="indefinite" begin={`${siteAnimDurations[i] / 2}s`} path={`M ${tgt.x} ${tgt.y} L ${src.x} ${src.y}`} />
                </circle>
              </g>
            );
          })}
          {siteNodes.map((site) => {
            const pos = siteNodePos[site];
            const isSource = filteredSiteFlows.some((sf) => sf.sourceSite === site);
            return (
              <g key={site} style={{ cursor: 'pointer' }} onClick={() => setFilterSourceSite(filterSourceSite === site ? '' : site)}>
                <circle cx={pos.x} cy={pos.y} r={18} fill="#131B23" stroke={filterSourceSite === site ? '#E8EDF2' : isSource ? '#6CB33F' : '#3b82f6'} strokeWidth={filterSourceSite === site ? 2.5 : 1.5} />
                <text x={pos.x} y={pos.y + 4} fontSize={9} fill="#E8EDF2" textAnchor="middle" dominantBaseline="middle">{isSource ? '▶' : '●'}</text>
                <text x={pos.x} y={pos.y + 28} fontSize={9} fill="#94A3B3" textAnchor="middle">{getSiteDisplay(site)}</text>
              </g>
            );
          })}
          {hoveredSiteFlow && (
            <g>
              <rect x={150} y={120} width={200} height={100} rx={6} fill="#0B1015" stroke="#2A3845" />
              <text x={160} y={138} fontSize={10} fill="#E8EDF2">{getSiteDisplay(hoveredSiteFlow.siteFlow.sourceSite)} {'→'} {getSiteDisplay(hoveredSiteFlow.siteFlow.targetSite)}</text>
              <text x={160} y={152} fontSize={10} fill="#94A3B3">Runs: {hoveredSiteFlow.siteFlow.runCount} | Bytes: {fmtBytes(hoveredSiteFlow.siteFlow.totalBytesTransferred)}</text>
              <text x={160} y={166} fontSize={10} fill="#94A3B3">Avg Lag: {formatLag(hoveredSiteFlow.siteFlow.avgLagSeconds)}</text>
              {hoveredSiteFlow.siteFlow.longRunningCount > 0 && (
                <>
                  <text x={160} y={180} fontSize={10} fill="#f59e0b">Long-running: {hoveredSiteFlow.siteFlow.longRunningCount}</text>
                  {hoveredSiteFlow.siteFlow.oldestLongRunningSeconds != null && (
                    <text x={160} y={194} fontSize={10} fill="#f59e0b">Oldest: {formatDuration(hoveredSiteFlow.siteFlow.oldestLongRunningSeconds)}</text>
                  )}
                </>
              )}
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

const thCls = 'py-2 px-2 font-medium';
function SortableTh({ col, sortKey, sortDir, onSort }) {
  const active = sortKey === col.key;
  return (
    <th
      className={thCls}
      style={{ textAlign: col.align === 'left' ? 'left' : 'right', cursor: 'pointer', color: active ? 'var(--co-brand)' : 'var(--co-ink-muted)', fontSize: 11, textTransform: 'uppercase' }}
      onClick={() => onSort(col.key)}
    >
      {col.label}{' '}
      {active ? (sortDir === 'desc' ? '▼' : '▲') : <span style={{ color: 'var(--co-ink-faint)' }}>&#8645;</span>}
    </th>
  );
}

const CLUSTER_COLS = [
  { key: 'name', label: 'Cluster Name', align: 'left' },
  { key: 'total', label: 'Total Runs', align: 'right' },
  { key: 'failure', label: 'Failed', align: 'right' },
  { key: 'successRate', label: 'Success Rate', align: 'right' },
];

const REPL_COLS = [
  { key: 'source', label: 'Source', align: 'left' },
  { key: 'target', label: 'Target', align: 'left' },
  { key: 'runCount', label: 'Runs', align: 'right' },
  { key: 'successCount', label: 'Success', align: 'right' },
  { key: 'failureCount', label: 'Failures', align: 'right' },
  { key: 'successRate', label: 'Success Rate', align: 'right' },
  { key: 'totalBytesTransferred', label: 'Bytes', align: 'right' },
  { key: 'avgLagSeconds', label: 'Avg Lag', align: 'right' },
];

export default function AnalyticsPage() {
  const { toast } = useToast();
  const [days, setDays] = React.useState(1);
  const [clusterId, setClusterId] = React.useState('');
  const [clusters, setClusters] = React.useState([]);
  const [backup, setBackup] = React.useState(null);
  const [replication, setReplication] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [clusterSort, setClusterSort] = React.useState('total');
  const [clusterSortDir, setClusterSortDir] = React.useState('desc');
  const [replSort, setReplSort] = React.useState('totalBytesTransferred');
  const [replSortDir, setReplSortDir] = React.useState('desc');

  const fetchAll = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (clusterId) params.set('clusterId', clusterId);
      const [bRes, rRes] = await Promise.all([
        apiFetch(`/cohesity/analytics/protection-runs?${params}`),
        apiFetch(`/cohesity/analytics/replication?${params}`),
      ]);
      setBackup(bRes);
      setReplication(rRes);
      setLastRefreshed(new Date());
    } catch (err) {
      toast({ type: 'error', title: 'Analytics fetch failed', message: err.payload?.error || err.message });
    } finally {
      setLoading(false);
    }
  }, [days, clusterId, toast]);

  React.useEffect(() => {
    apiFetch('/cohesity/analytics/clusters').then((d) => setClusters(d || [])).catch(() => {});
  }, []);

  React.useEffect(() => { fetchAll(); }, [fetchAll]);

  // --- Backup chart data ---
  const byDay = backup?.byDay || [];
  const jobTrendData = {
    labels: byDay.map((d) => { const dt = new Date(d.date); return `${dt.getMonth() + 1}/${dt.getDate()}`; }),
    datasets: [
      { label: 'Success', data: byDay.map((d) => d.success), backgroundColor: '#6CB33F', stack: 'a' },
      { label: 'Failure', data: byDay.map((d) => d.failure), backgroundColor: '#ef4444', stack: 'a' },
      { label: 'Warning', data: byDay.map((d) => d.warning), backgroundColor: '#f59e0b', stack: 'a' },
    ],
  };
  const jobTrendOptions = { scales: { x: { stacked: true }, y: { stacked: true } } };

  const topErrors = (backup?.topErrors || []).slice(0, 10);
  const topErrorData = {
    labels: topErrors.map((e) => (e.errorMessage || e.errorCode || '').slice(0, 40)),
    datasets: [{ label: 'Count', data: topErrors.map((e) => e.count), backgroundColor: '#ef4444' }],
  };
  const topErrorOptions = { indexAxis: 'y', plugins: { legend: { display: false } } };

  const flows = replication?.flows || [];

  const sortedFlows = React.useMemo(() => [...flows].sort((a, b) => {
    const dir = replSortDir === 'desc' ? -1 : 1;
    if (replSort === 'source') return dir * a.sourceClusterName.localeCompare(b.sourceClusterName);
    if (replSort === 'target') return dir * a.targetClusterName.localeCompare(b.targetClusterName);
    if (replSort === 'runCount') return dir * (a.runCount - b.runCount);
    if (replSort === 'successCount') return dir * (a.successCount - b.successCount);
    if (replSort === 'failureCount') return dir * (a.failureCount - b.failureCount);
    if (replSort === 'successRate') return dir * ((a.runCount > 0 ? a.successCount / a.runCount : 0) - (b.runCount > 0 ? b.successCount / b.runCount : 0));
    if (replSort === 'avgLagSeconds') return dir * ((a.avgLagSeconds || 0) - (b.avgLagSeconds || 0));
    return dir * ((a.totalBytesTransferred || 0) - (b.totalBytesTransferred || 0));
  }), [flows, replSort, replSortDir]);

  const sortedByCluster = React.useMemo(() => [...(backup?.byCluster || [])].sort((a, b) => {
    const dir = clusterSortDir === 'desc' ? -1 : 1;
    if (clusterSort === 'name') return dir * a.clusterName.localeCompare(b.clusterName);
    if (clusterSort === 'failure') return dir * (a.failure - b.failure);
    if (clusterSort === 'successRate') return dir * (a.successRate - b.successRate);
    return dir * (a.total - b.total);
  }), [backup, clusterSort, clusterSortDir]);

  const onClusterSort = (key) => { if (clusterSort === key) setClusterSortDir((d) => (d === 'desc' ? 'asc' : 'desc')); else { setClusterSort(key); setClusterSortDir('desc'); } };
  const onReplSort = (key) => { if (replSort === key) setReplSortDir((d) => (d === 'desc' ? 'asc' : 'desc')); else { setReplSort(key); setReplSortDir('desc'); } };

  const backupSummary = backup?.summary || {};
  const replSummary = replication?.summary || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader icon={TrendingUp} title="Analytics" description="Backup job performance, SLA compliance, anomalies, and replication trends" />

      {/* Filter Bar */}
      <div className="co-scroll" style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--co-black)', padding: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', borderBottom: '1px solid var(--co-border)' }}>
        <select className="co-input" style={{ width: 'auto' }} value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
          <option value="">All Clusters</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 7, 14, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={days !== d ? 'co-btn-ghost' : undefined}
              style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, fontWeight: 500, cursor: 'pointer', border: days === d ? 'none' : undefined, background: days === d ? 'var(--co-brand)' : undefined, color: days === d ? '#0B1015' : undefined }}
            >
              {d === 1 ? '24h' : `${d}d`}
            </button>
          ))}
        </div>

        <RefreshButton onClick={fetchAll} refreshing={loading} label="Refresh" />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
        {loading && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--co-ink-muted)', marginLeft: 8 }} role="status">
            <Spinner size={13} /> Loading analytics&hellip;
          </span>
        )}
      </div>

      {/* Backup Job Analytics */}
      <div>
        <SectionHeading>Backup Job Analytics</SectionHeading>

        <div className="grid grid-cols-2 xl:grid-cols-4" style={{ gap: 12, marginBottom: 16 }}>
          <StatCard label="Total Runs" value={backupSummary.total ?? '—'} />
          <StatCard
            label="Success Rate"
            value={backupSummary.successRate != null ? `${backupSummary.successRate}%` : '—'}
            tone={backupSummary.successRate == null ? 'default' : backupSummary.successRate >= 90 ? 'ok' : backupSummary.successRate >= 70 ? 'warn' : 'crit'}
          />
          <StatCard label="Failed Runs" value={backupSummary.failure ?? '—'} tone={(backupSummary.failure ?? 0) > 0 ? 'crit' : 'ok'} />
          <StatCard label="Warning Runs" value={backupSummary.warning ?? '—'} tone={(backupSummary.warning ?? 0) > 0 ? 'warn' : 'default'} />
        </div>

        {backupSummary.total === 0 ? (
          <div className="panel" style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--co-ink-muted)' }}>
            No backup run data available. Data will appear after the next poll cycle.
          </div>
        ) : (
          <>
            <div className="grid xl:grid-cols-2" style={{ gap: 12, marginBottom: 16 }}>
              <div className="panel" style={{ padding: 16 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Job Performance Trend</p>
                {byDay.length > 0 ? <BarChart data={jobTrendData} options={jobTrendOptions} height={220} /> : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 220, fontSize: 12, color: 'var(--co-ink-faint)' }}>No data</div>
                )}
              </div>
              <div className="panel" style={{ padding: 16 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Top Failure Reasons</p>
                {topErrors.length > 0 ? <BarChart data={topErrorData} options={topErrorOptions} height={220} /> : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 220, fontSize: 12, color: 'var(--co-ink-faint)' }}>No errors recorded</div>
                )}
              </div>
            </div>

            <div className="panel" style={{ padding: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Protection Run Failures by Cluster</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--co-border)' }}>
                      {CLUSTER_COLS.map((col) => <SortableTh key={col.key} col={col} sortKey={clusterSort} sortDir={clusterSortDir} onSort={onClusterSort} />)}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedByCluster.map((row, i) => (
                      <tr key={row.clusterId || i} style={{ background: i % 2 === 0 ? 'rgba(0,0,0,0.2)' : undefined }}>
                        <td className="truncate" style={{ padding: '6px 8px', maxWidth: 180, color: 'var(--co-ink-muted)' }}>{row.clusterName || row.clusterId}</td>
                        <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-ink-muted)' }}>{row.total}</td>
                        <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-crit)' }}>{row.failure}</td>
                        <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600, color: successColor(row.successRate) }}>
                          {row.successRate != null ? `${row.successRate}%` : '—'}
                        </td>
                      </tr>
                    ))}
                    {sortedByCluster.length === 0 && (
                      <tr><td colSpan={4} style={{ textAlign: 'center', padding: 16, color: 'var(--co-ink-faint)' }}>No data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Replication Data Flow */}
      <div>
        <SectionHeading>Replication Data Flow</SectionHeading>

        <div className="grid grid-cols-1 sm:grid-cols-3" style={{ gap: 12, marginBottom: 16 }}>
          <StatCard label="Replication Runs" value={replSummary.total ?? '—'} />
          <StatCard
            label="Success Rate"
            value={replSummary.successRate != null ? `${replSummary.successRate}%` : '—'}
            tone={replSummary.successRate == null ? 'default' : replSummary.successRate >= 90 ? 'ok' : replSummary.successRate >= 70 ? 'warn' : 'crit'}
          />
          <StatCard label="Data Transferred" value={fmtBytes(replSummary.totalBytesTransferred)} tone="brand" />
        </div>

        {replSummary.total === 0 ? (
          <div className="panel" style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--co-ink-muted)' }}>
            No replication data available for this period.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-2" style={{ gap: 16, marginBottom: 16 }}>
              <ReplicationMesh flows={flows} title="Replication Mesh" />
              <SiteReplicationMesh flows={flows} />
            </div>

            <div className="panel" style={{ padding: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Replication Flows Detail</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--co-border)' }}>
                      {REPL_COLS.map((col) => <SortableTh key={col.key} col={col} sortKey={replSort} sortDir={replSortDir} onSort={onReplSort} />)}
                      <th className={thCls} style={{ textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--co-ink-muted)' }}>Last Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedFlows.map((flow, i) => {
                      const rate = flow.runCount > 0 ? Math.round((flow.successCount / flow.runCount) * 100) : 0;
                      const lastSeen = flow.lastSeen ? new Date(flow.lastSeen).toLocaleDateString() : '—';
                      return (
                        <tr key={i} style={{ background: i % 2 === 0 ? 'rgba(0,0,0,0.2)' : undefined }}>
                          <td className="truncate" style={{ padding: '6px 8px', maxWidth: 120, color: 'var(--co-ink-muted)' }}>{flow.sourceClusterName}</td>
                          <td className="truncate" style={{ padding: '6px 8px', maxWidth: 120, color: 'var(--co-ink-muted)' }}>{flow.targetClusterName}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-ink-muted)' }}>{flow.runCount}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-ok)' }}>{flow.successCount}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-crit)' }}>{flow.failureCount}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600, color: successColor(rate) }}>{rate}%</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-ink-muted)' }}>{fmtBytes(flow.totalBytesTransferred)}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-ink-muted)' }}>{formatLag(flow.avgLagSeconds)}</td>
                          <td className="tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--co-ink-muted)' }}>{lastSeen}</td>
                        </tr>
                      );
                    })}
                    {sortedFlows.length === 0 && (
                      <tr><td colSpan={9} style={{ textAlign: 'center', padding: 16, color: 'var(--co-ink-faint)' }}>No data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
