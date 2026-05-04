import { useEffect, useState, useCallback, useMemo } from 'react';
import client from '../api/client';
import { Bar } from 'react-chartjs-2';

// Helper functions
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

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
  if (rate >= 90) return 'text-green-400';
  if (rate >= 70) return 'text-yellow-400';
  return 'text-red-400';
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: {
      labels: { color: '#E5E5E5', font: { size: 11 } }
    },
    tooltip: {
      backgroundColor: '#2C2C2C',
      borderColor: '#3D3D3D',
      borderWidth: 1,
      titleColor: '#E5E5E5',
      bodyColor: '#9ca3af',
    }
  },
  scales: {
    x: {
      ticks: { color: '#E5E5E5', font: { size: 10 } },
      grid: { color: 'rgba(255,255,255,0.1)' }
    },
    y: {
      ticks: { color: '#E5E5E5', font: { size: 10 } },
      grid: { color: 'rgba(255,255,255,0.1)' }
    }
  }
};

function StatCard({ label, value, valueClass = 'text-cohesity-text' }) {
  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <h2 className="text-sm font-semibold text-cohesity-text uppercase tracking-wider mb-3 mt-1">
      {children}
    </h2>
  );
}

function ReplicationMesh({ flows }) {
  const [hoveredFlow, setHoveredFlow] = useState(null);
  const [filterSource, setFilterSource] = useState('');
  const [filterTarget, setFilterTarget] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  const allSources = useMemo(() => [...new Set(flows.map(f => f.sourceClusterName))].sort(), [flows]);
  const allTargets = useMemo(() => [...new Set(flows.map(f => f.targetClusterName))].sort(), [flows]);

  const filteredFlows = useMemo(() => flows.filter(f => {
    if (filterSource && f.sourceClusterName !== filterSource) return false;
    if (filterTarget && f.targetClusterName !== filterTarget) return false;
    if (filterStatus === 'healthy' && f.failureCount > 0) return false;
    if (filterStatus === 'degraded' && (f.failureCount === 0 || f.failureCount / f.runCount >= 0.2)) return false;
    if (filterStatus === 'failed' && f.failureCount / f.runCount < 0.2) return false;
    return true;
  }), [flows, filterSource, filterTarget, filterStatus]);

  const { nodes, nodePos, maxBytes, animDurations } = useMemo(() => {
    const nameSet = new Set();
    filteredFlows.forEach(f => { nameSet.add(f.sourceClusterName); nameSet.add(f.targetClusterName); });
    const nodes = [...nameSet];
    const nodePos = {};
    nodes.forEach((name, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      const x = 250 + 215 * Math.cos(angle);
      const y = 255 + 220 * Math.sin(angle);
      nodePos[name] = { x, y };
    });
    const maxBytes = Math.max(...filteredFlows.map(f => f.totalBytesTransferred || 0), 1);
    const animDurations = filteredFlows.map(() => 2 + Math.random() * 2);
    return { nodes, nodePos, maxBytes, animDurations };
  }, [filteredFlows]);

  const hasFilters = filterSource || filterTarget || filterStatus !== 'all';

  const selectCls = 'bg-cohesity-black border border-cohesity-border text-cohesity-text text-[11px] rounded px-2 py-1 focus:outline-none focus:border-cohesity-green';

  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-xs font-semibold text-cohesity-text">Replication Mesh</p>
        <div className="flex flex-wrap gap-2 items-center">
          <select className={selectCls} value={filterSource} onChange={e => setFilterSource(e.target.value)}>
            <option value="">All Sources</option>
            {allSources.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className={selectCls} value={filterTarget} onChange={e => setFilterTarget(e.target.value)}>
            <option value="">All Targets</option>
            {allTargets.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className={selectCls} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="all">All Status</option>
            <option value="healthy">Healthy only</option>
            <option value="degraded">Degraded (&lt;20% fail)</option>
            <option value="failed">Failed (≥20% fail)</option>
          </select>
          {hasFilters && (
            <button
              className="text-[11px] px-2 py-1 rounded bg-cohesity-border text-gray-400 hover:text-cohesity-text transition-colors"
              onClick={() => { setFilterSource(''); setFilterTarget(''); setFilterStatus('all'); }}
            >
              ✕ Clear
            </button>
          )}
        </div>
      </div>

      {filteredFlows.length === 0 ? (
        <div className="flex items-center justify-center text-xs text-gray-500" style={{ height: 520 }}>
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
                <line
                  x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={isLongRunning ? '6 4' : undefined}
                  opacity={0.5}
                />
                <line
                  x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                  stroke={color}
                  strokeWidth={Math.max(20, strokeWidth + 14)}
                  strokeOpacity={0.01}
                  strokeLinecap="round"
                  pointerEvents="stroke"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredFlow({ flow })}
                  onMouseLeave={() => setHoveredFlow(null)}
                  onMouseMove={() => setHoveredFlow({ flow })}
                />
                <text
                  x={midX}
                  y={midY - 8}
                  fontSize={8}
                  fill="#E5E5E5"
                  textAnchor="middle"
                  opacity={0.9}
                  style={{ pointerEvents: 'none', fontWeight: 500, textShadow: '0 0 2px #000' }}
                >
                  {flow.sourceClusterName}↔{flow.targetClusterName}
                </text>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion
                    dur={`${animDurations[i]}s`}
                    repeatCount="indefinite"
                    path={`M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`}
                  />
                </circle>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion
                    dur={`${animDurations[i]}s`}
                    repeatCount="indefinite"
                    begin={`${animDurations[i] / 2}s`}
                    path={`M ${tgt.x} ${tgt.y} L ${src.x} ${src.y}`}
                  />
                </circle>
              </g>
            );
          })}
          {nodes.map(name => {
            const pos = nodePos[name];
            const isSource = filteredFlows.some(f => f.sourceClusterName === name);
            return (
              <g key={name} style={{ cursor: 'pointer' }} onClick={() => setFilterSource(filterSource === name ? '' : name)}>
                <circle
                  cx={pos.x} cy={pos.y} r={18}
                  fill="#2C2C2C"
                  stroke={filterSource === name ? '#E5E5E5' : isSource ? '#6CB33F' : '#3b82f6'}
                  strokeWidth={filterSource === name ? 2.5 : 1.5}
                />
                <text x={pos.x} y={pos.y + 4} fontSize={9} fill="#E5E5E5" textAnchor="middle" dominantBaseline="middle">
                  {isSource ? '▶' : '●'}
                </text>
                <text x={pos.x} y={pos.y + 28} fontSize={9} fill="#9ca3af" textAnchor="middle">
                  {name.length > 12 ? name.slice(0, 12) : name}
                </text>
              </g>
            );
          })}
          {hoveredFlow && (
            <g>
              <rect x={150} y={120} width={200} height={85} rx={6} fill="#1A1A1A" stroke="#3D3D3D" />
              <text x={160} y={138} fontSize={10} fill="#E5E5E5">
                {hoveredFlow.flow.sourceClusterName} {'→'} {hoveredFlow.flow.targetClusterName}
              </text>
              <text x={160} y={152} fontSize={10} fill="#9ca3af">
                Runs: {hoveredFlow.flow.runCount} | Bytes: {formatBytes(hoveredFlow.flow.totalBytesTransferred)}
              </text>
              <text x={160} y={166} fontSize={10} fill="#9ca3af">
                Avg Lag: {formatLag(hoveredFlow.flow.avgLagSeconds)}
              </text>
              {hoveredFlow.flow.longRunningCount > 0 && (
                <>
                  <text x={160} y={180} fontSize={10} fill="#f59e0b">
                    Long-running: {hoveredFlow.flow.longRunningCount}
                  </text>
                  {hoveredFlow.flow.oldestLongRunningSeconds != null && (
                    <text x={160} y={194} fontSize={10} fill="#f59e0b">
                      Oldest: {formatDuration(hoveredFlow.flow.oldestLongRunningSeconds)}
                    </text>
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
  const [hoveredSiteFlow, setHoveredSiteFlow] = useState(null);
  const [filterSourceSite, setFilterSourceSite] = useState('');
  const [filterTargetSite, setFilterTargetSite] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  // Extract site code from cluster name: first 4 chars, lowercase for grouping
  const getSiteCode = (clusterName) => {
    if (!clusterName || clusterName.trim().length < 4) return 'unkn';
    return clusterName.trim().toLowerCase().slice(0, 4);
  };

  const getSiteDisplay = (code) => code.toUpperCase();

  // Aggregate flows by site pair
  const siteAggregates = useMemo(() => {
    const agg = {};
    flows.forEach(flow => {
      const srcSite = getSiteCode(flow.sourceClusterName);
      const tgtSite = getSiteCode(flow.targetClusterName);
      const key = `${srcSite}|${tgtSite}`;
      
      if (!agg[key]) {
        agg[key] = {
          sourceSite: srcSite,
          targetSite: tgtSite,
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          totalBytesTransferred: 0,
          longRunningCount: 0,
          oldestLongRunningSeconds: null,
          lagSum: 0,
          lagCount: 0,
        };
      }
      
      agg[key].runCount += flow.runCount || 0;
      agg[key].successCount += flow.successCount || 0;
      agg[key].failureCount += flow.failureCount || 0;
      agg[key].totalBytesTransferred += flow.totalBytesTransferred || 0;
      agg[key].longRunningCount += flow.longRunningCount || 0;
      
      if (flow.oldestLongRunningSeconds != null) {
        if (agg[key].oldestLongRunningSeconds == null) {
          agg[key].oldestLongRunningSeconds = flow.oldestLongRunningSeconds;
        } else {
          agg[key].oldestLongRunningSeconds = Math.max(agg[key].oldestLongRunningSeconds, flow.oldestLongRunningSeconds);
        }
      }
      
      if (flow.avgLagSeconds != null) {
        agg[key].lagSum += (flow.avgLagSeconds * (flow.runCount || 1));
        agg[key].lagCount += (flow.runCount || 1);
      }
    });
    
    // Calculate weighted average lag
    Object.values(agg).forEach(item => {
      item.avgLagSeconds = item.lagCount > 0 ? item.lagSum / item.lagCount : 0;
    });
    
    return Object.values(agg);
  }, [flows]);

  const allSourceSites = useMemo(() => {
    const sites = [...new Set(siteAggregates.map(s => s.sourceSite))].sort();
    return sites;
  }, [siteAggregates]);

  const allTargetSites = useMemo(() => {
    const sites = [...new Set(siteAggregates.map(s => s.targetSite))].sort();
    return sites;
  }, [siteAggregates]);

  const filteredSiteFlows = useMemo(() => siteAggregates.filter(sf => {
    if (filterSourceSite && sf.sourceSite !== filterSourceSite) return false;
    if (filterTargetSite && sf.targetSite !== filterTargetSite) return false;
    if (filterStatus === 'healthy' && sf.failureCount > 0) return false;
    if (filterStatus === 'degraded' && (sf.failureCount === 0 || sf.failureCount / sf.runCount >= 0.2)) return false;
    if (filterStatus === 'failed' && sf.failureCount / sf.runCount < 0.2) return false;
    return true;
  }), [siteAggregates, filterSourceSite, filterTargetSite, filterStatus]);

  const { siteNodes, siteNodePos, maxSiteBytes, siteAnimDurations } = useMemo(() => {
    const siteSet = new Set();
    filteredSiteFlows.forEach(sf => { siteSet.add(sf.sourceSite); siteSet.add(sf.targetSite); });
    const siteNodes = [...siteSet];
    const siteNodePos = {};
    siteNodes.forEach((site, i) => {
      const angle = (2 * Math.PI * i) / siteNodes.length - Math.PI / 2;
      const x = 250 + 215 * Math.cos(angle);
      const y = 255 + 220 * Math.sin(angle);
      siteNodePos[site] = { x, y };
    });
    const maxSiteBytes = Math.max(...filteredSiteFlows.map(s => s.totalBytesTransferred || 0), 1);
    const siteAnimDurations = filteredSiteFlows.map(() => 2 + Math.random() * 2);
    return { siteNodes, siteNodePos, maxSiteBytes, siteAnimDurations };
  }, [filteredSiteFlows]);

  const hasFilters = filterSourceSite || filterTargetSite || filterStatus !== 'all';

  const selectCls = 'bg-cohesity-black border border-cohesity-border text-cohesity-text text-[11px] rounded px-2 py-1 focus:outline-none focus:border-cohesity-green';

  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <div className="mb-3">
        <p className="text-xs font-semibold text-cohesity-text mb-2">Site-Level Replication Mesh</p>
        <p className="text-[10px] text-gray-400 mb-3">Site derived from first 4 characters of cluster names</p>
      </div>
      
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap gap-2 items-center">
          <select className={selectCls} value={filterSourceSite} onChange={e => setFilterSourceSite(e.target.value)}>
            <option value="">All Sources</option>
            {allSourceSites.map(s => <option key={s} value={s}>{getSiteDisplay(s)}</option>)}
          </select>
          <select className={selectCls} value={filterTargetSite} onChange={e => setFilterTargetSite(e.target.value)}>
            <option value="">All Targets</option>
            {allTargetSites.map(t => <option key={t} value={t}>{getSiteDisplay(t)}</option>)}
          </select>
          <select className={selectCls} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="all">All Status</option>
            <option value="healthy">Healthy only</option>
            <option value="degraded">Degraded (&lt;20% fail)</option>
            <option value="failed">Failed (≥20% fail)</option>
          </select>
          {hasFilters && (
            <button
              className="text-[11px] px-2 py-1 rounded bg-cohesity-border text-gray-400 hover:text-cohesity-text transition-colors"
              onClick={() => { setFilterSourceSite(''); setFilterTargetSite(''); setFilterStatus('all'); }}
            >
              ✕ Clear
            </button>
          )}
        </div>
      </div>

      {filteredSiteFlows.length === 0 ? (
        <div className="flex items-center justify-center text-xs text-gray-500" style={{ height: 520 }}>
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
                <line
                  x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={isLongRunning ? '6 4' : undefined}
                  opacity={0.5}
                />
                <line
                  x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                  stroke={color}
                  strokeWidth={Math.max(20, strokeWidth + 14)}
                  strokeOpacity={0.01}
                  strokeLinecap="round"
                  pointerEvents="stroke"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredSiteFlow({ siteFlow })}
                  onMouseLeave={() => setHoveredSiteFlow(null)}
                  onMouseMove={() => setHoveredSiteFlow({ siteFlow })}
                />
                <text
                  x={midX}
                  y={midY - 8}
                  fontSize={8}
                  fill="#E5E5E5"
                  textAnchor="middle"
                  opacity={0.9}
                  style={{ pointerEvents: 'none', fontWeight: 500, textShadow: '0 0 2px #000' }}
                >
                  {sourceDisplay}↔{targetDisplay}
                </text>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion
                    dur={`${siteAnimDurations[i]}s`}
                    repeatCount="indefinite"
                    path={`M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`}
                  />
                </circle>
                <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
                  <animateMotion
                    dur={`${siteAnimDurations[i]}s`}
                    repeatCount="indefinite"
                    begin={`${siteAnimDurations[i] / 2}s`}
                    path={`M ${tgt.x} ${tgt.y} L ${src.x} ${src.y}`}
                  />
                </circle>
              </g>
            );
          })}
          {siteNodes.map(site => {
            const pos = siteNodePos[site];
            const isSource = filteredSiteFlows.some(sf => sf.sourceSite === site);
            return (
              <g key={site} style={{ cursor: 'pointer' }} onClick={() => setFilterSourceSite(filterSourceSite === site ? '' : site)}>
                <circle
                  cx={pos.x} cy={pos.y} r={18}
                  fill="#2C2C2C"
                  stroke={filterSourceSite === site ? '#E5E5E5' : isSource ? '#6CB33F' : '#3b82f6'}
                  strokeWidth={filterSourceSite === site ? 2.5 : 1.5}
                />
                <text x={pos.x} y={pos.y + 4} fontSize={9} fill="#E5E5E5" textAnchor="middle" dominantBaseline="middle">
                  {isSource ? '▶' : '●'}
                </text>
                <text x={pos.x} y={pos.y + 28} fontSize={9} fill="#9ca3af" textAnchor="middle">
                  {getSiteDisplay(site)}
                </text>
              </g>
            );
          })}
          {hoveredSiteFlow && (
            <g>
              <rect x={150} y={120} width={200} height={100} rx={6} fill="#1A1A1A" stroke="#3D3D3D" />
              <text x={160} y={138} fontSize={10} fill="#E5E5E5">
                {getSiteDisplay(hoveredSiteFlow.siteFlow.sourceSite)} {'→'} {getSiteDisplay(hoveredSiteFlow.siteFlow.targetSite)}
              </text>
              <text x={160} y={152} fontSize={10} fill="#9ca3af">
                Runs: {hoveredSiteFlow.siteFlow.runCount} | Bytes: {formatBytes(hoveredSiteFlow.siteFlow.totalBytesTransferred)}
              </text>
              <text x={160} y={166} fontSize={10} fill="#9ca3af">
                Avg Lag: {formatLag(hoveredSiteFlow.siteFlow.avgLagSeconds)}
              </text>
              {hoveredSiteFlow.siteFlow.longRunningCount > 0 && (
                <>
                  <text x={160} y={180} fontSize={10} fill="#f59e0b">
                    Long-running: {hoveredSiteFlow.siteFlow.longRunningCount}
                  </text>
                  {hoveredSiteFlow.siteFlow.oldestLongRunningSeconds != null && (
                    <text x={160} y={194} fontSize={10} fill="#f59e0b">
                      Oldest: {formatDuration(hoveredSiteFlow.siteFlow.oldestLongRunningSeconds)}
                    </text>
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

export default function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const [clusterId, setClusterId] = useState('');
  const [clusters, setClusters] = useState([]);
  const [backup, setBackup] = useState(null);
  const [replication, setReplication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [clusterSort, setClusterSort] = useState('total');
  const [clusterSortDir, setClusterSortDir] = useState('desc');
  const [replSort, setReplSort] = useState('totalBytesTransferred');
  const [replSortDir, setReplSortDir] = useState('desc');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = { days };
      if (clusterId) params.clusterId = clusterId;
      const [bRes, rRes] = await Promise.all([
        client.get('/analytics/protection-runs', { params }),
        client.get('/analytics/replication', { params }),
      ]);
      setBackup(bRes.data);
      setReplication(rRes.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [days, clusterId]);

  useEffect(() => {
    client.get('/analytics/clusters')
      .then(r => setClusters(r.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // --- Backup chart data ---
  const byDay = backup?.byDay || [];
  const jobTrendData = {
    labels: byDay.map(d => {
      const dt = new Date(d.date);
      return `${dt.getMonth() + 1}/${dt.getDate()}`;
    }),
    datasets: [
      { label: 'Success', data: byDay.map(d => d.success), backgroundColor: '#6CB33F', stack: 'a' },
      { label: 'Failure', data: byDay.map(d => d.failure), backgroundColor: '#ef4444', stack: 'a' },
      { label: 'Warning', data: byDay.map(d => d.warning), backgroundColor: '#f59e0b', stack: 'a' },
    ]
  };
  const jobTrendOptions = {
    ...CHART_DEFAULTS,
    scales: {
      ...CHART_DEFAULTS.scales,
      x: { ...CHART_DEFAULTS.scales.x, stacked: true },
      y: { ...CHART_DEFAULTS.scales.y, stacked: true }
    }
  };

  const topErrors = (backup?.topErrors || []).slice(0, 10);
  const topErrorData = {
    labels: topErrors.map(e => (e.errorMessage || e.errorCode || '').slice(0, 40)),
    datasets: [{
      label: 'Count',
      data: topErrors.map(e => e.count),
      backgroundColor: '#ef4444',
    }]
  };
  const topErrorOptions = {
    ...CHART_DEFAULTS,
    indexAxis: 'y',
    plugins: {
      ...CHART_DEFAULTS.plugins,
      legend: { display: false },
    },
    scales: {
      x: { ...CHART_DEFAULTS.scales.x },
      y: { ticks: { color: '#E5E5E5', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.1)' } }
    }
  };

  // --- Replication chart data ---
  const byCluster = replication?.byCluster || [];
  const replByClusterData = {
    labels: byCluster.map(c => c.clusterName),
    datasets: [{
      label: 'Bytes Out',
      data: byCluster.map(c => c.totalBytes),
      backgroundColor: '#3b82f6',
    }]
  };
  const replByClusterOptions = {
    ...CHART_DEFAULTS,
    indexAxis: 'y',
    plugins: {
      ...CHART_DEFAULTS.plugins,
      legend: { display: false },
    },
    scales: {
      x: {
        ticks: {
          color: '#E5E5E5',
          font: { size: 9 },
          callback: v => {
            if (v >= 1e12) return (v / 1e12).toFixed(1) + ' TB';
            if (v >= 1e9) return (v / 1e9).toFixed(1) + ' GB';
            return v;
          }
        },
        grid: { color: 'rgba(255,255,255,0.1)' }
      },
      y: { ticks: { color: '#E5E5E5', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.1)' } }
    }
  };

  const flows = replication?.flows || [];

  const sortedFlows = [...(replication?.flows || [])].sort((a, b) => {
    const dir = replSortDir === 'desc' ? -1 : 1;
    if (replSort === 'source') return dir * a.sourceClusterName.localeCompare(b.sourceClusterName);
    if (replSort === 'target') return dir * a.targetClusterName.localeCompare(b.targetClusterName);
    if (replSort === 'runCount') return dir * (a.runCount - b.runCount);
    if (replSort === 'successCount') return dir * (a.successCount - b.successCount);
    if (replSort === 'failureCount') return dir * (a.failureCount - b.failureCount);
    if (replSort === 'successRate') return dir * ((a.runCount > 0 ? a.successCount / a.runCount : 0) - (b.runCount > 0 ? b.successCount / b.runCount : 0));
    if (replSort === 'avgLagSeconds') return dir * ((a.avgLagSeconds || 0) - (b.avgLagSeconds || 0));
    return dir * ((a.totalBytesTransferred || 0) - (b.totalBytesTransferred || 0));
  });

  const sortedByCluster = [...(backup?.byCluster || [])].sort((a, b) => {
    const dir = clusterSortDir === 'desc' ? -1 : 1;
    if (clusterSort === 'name') return dir * a.clusterName.localeCompare(b.clusterName);
    if (clusterSort === 'failure') return dir * (a.failure - b.failure);
    if (clusterSort === 'successRate') return dir * (a.successRate - b.successRate);
    return dir * (a.total - b.total);
  });

  function flowRowBorder(flow) {
    const failPct = flow.runCount > 0 ? flow.failureCount / flow.runCount : 0;
    if (failPct > 0.5) return 'border-l-4 border-red-500';
    if (flow.failureCount > 0) return 'border-l-4 border-yellow-500';
    return 'border-l-4 border-green-500';
  }

  const backupSummary = backup?.summary || {};
  const replSummary = replication?.summary || {};

  return (
    <div className="p-4 space-y-6">
      {/* Filter Bar */}
      <div className="sticky top-0 z-10 bg-cohesity-black py-2 flex flex-wrap gap-3 items-center border-b border-cohesity-border">
        <select
          className="bg-cohesity-gray border border-cohesity-border text-cohesity-text text-xs rounded px-2 py-1.5 focus:outline-none"
          value={clusterId}
          onChange={e => setClusterId(e.target.value)}
        >
          <option value="">All Clusters</option>
          {clusters.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <div className="flex gap-1">
          {[7, 14, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-3 py-1.5 rounded font-medium transition-colors ${
                days === d
                  ? 'bg-cohesity-green text-white'
                  : 'bg-cohesity-gray text-cohesity-text hover:bg-cohesity-border'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        <button
          onClick={fetchAll}
          className="text-xs px-3 py-1.5 rounded bg-cohesity-green hover:bg-cohesity-green-dark text-white font-medium transition-colors"
        >
          Refresh
        </button>

        {loading && (
          <span className="text-xs text-cohesity-green animate-pulse ml-2">Loading analytics...</span>
        )}
      </div>

      {/* Section 2: Backup Job Analytics */}
      <div>
        <SectionHeading>Backup Job Analytics</SectionHeading>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
          <StatCard label="Total Runs" value={backupSummary.total ?? '—'} />
          <StatCard
            label="Success Rate"
            value={backupSummary.successRate != null ? `${backupSummary.successRate}%` : '—'}
            valueClass={backupSummary.successRate != null ? successColor(backupSummary.successRate) : 'text-cohesity-text'}
          />
          <StatCard label="Failed Runs" value={backupSummary.failure ?? '—'} valueClass="text-red-400" />
          <StatCard label="Warning Runs" value={backupSummary.warning ?? '—'} valueClass="text-yellow-400" />
        </div>

        {backupSummary.total === 0 ? (
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 text-center text-xs text-gray-400">
            No backup run data available. Data will appear after the next poll cycle.
          </div>
        ) : (
          <>
            {/* Charts row */}
            <div className="grid xl:grid-cols-2 gap-3 mb-4">
              <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                <p className="text-xs font-semibold text-cohesity-text mb-3">Job Performance Trend</p>
                <div style={{ height: 220 }}>
                  {byDay.length > 0 ? (
                    <Bar data={jobTrendData} options={jobTrendOptions} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 text-xs">No data</div>
                  )}
                </div>
              </div>
              <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                <p className="text-xs font-semibold text-cohesity-text mb-3">Top Failure Reasons</p>
                <div style={{ height: 220 }}>
                  {topErrors.length > 0 ? (
                    <Bar data={topErrorData} options={topErrorOptions} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 text-xs">No errors recorded</div>
                  )}
                </div>
              </div>
            </div>

            {/* Protection Run Failures by Cluster table */}
            <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
              <p className="text-xs font-semibold text-cohesity-text mb-3">Protection Run Failures by Cluster</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-gray-400">
                  <thead className="sticky top-0 bg-cohesity-gray">
                    <tr className="border-b border-cohesity-border">
                      {[
                        { key: 'name', label: 'Cluster Name', align: 'left' },
                        { key: 'total', label: 'Total Runs', align: 'right' },
                        { key: 'failure', label: 'Failed', align: 'right' },
                        { key: 'successRate', label: 'Success Rate', align: 'right' },
                      ].map(col => (
                        <th
                          key={col.key}
                          className={`${col.align === 'left' ? 'text-left' : 'text-right'} px-2 py-2 font-medium cursor-pointer hover:text-cohesity-text ${clusterSort === col.key ? 'text-cohesity-green' : ''}`}
                          onClick={() => {
                            if (clusterSort === col.key) setClusterSortDir(d => d === 'desc' ? 'asc' : 'desc');
                            else { setClusterSort(col.key); setClusterSortDir('desc'); }
                          }}
                        >
                          {col.label}{' '}
                          {clusterSort === col.key
                            ? (clusterSortDir === 'desc' ? '▼' : '▲')
                            : <span className="text-gray-600">⇅</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedByCluster.map((row, i) => (
                      <tr key={row.clusterId || i} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                        <td className="px-2 py-1.5 truncate max-w-[180px]">{row.clusterName || row.clusterId}</td>
                        <td className="text-right px-2 py-1.5">{row.total}</td>
                        <td className="text-right px-2 py-1.5 text-red-400">{row.failure}</td>
                        <td className={`text-right px-2 py-1.5 font-medium ${successColor(row.successRate)}`}>
                          {row.successRate != null ? `${row.successRate}%` : '—'}
                        </td>
                      </tr>
                    ))}
                    {sortedByCluster.length === 0 && (
                      <tr><td colSpan={4} className="text-center py-4 text-gray-500">No data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Section 3: Replication Data Flow */}
      <div>
        <SectionHeading>Replication Data Flow</SectionHeading>

        {/* Summary stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <StatCard label="Replication Runs" value={replSummary.total ?? '—'} />
          <StatCard
            label="Success Rate"
            value={replSummary.successRate != null ? `${replSummary.successRate}%` : '—'}
            valueClass={replSummary.successRate != null ? successColor(replSummary.successRate) : 'text-cohesity-text'}
          />
          <StatCard label="Data Transferred" value={formatBytes(replSummary.totalBytesTransferred)} />
        </div>

        {replSummary.total === 0 ? (
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 text-center text-xs text-gray-400">
            No replication data available for this period.
          </div>
        ) : (
          <>
            {/* Cluster and Site Replication Meshes - Side by Side */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
              <ReplicationMesh flows={flows} />
              <SiteReplicationMesh flows={flows} />
            </div>

            {/* Replication Flows detail table */}
            <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
              <p className="text-xs font-semibold text-cohesity-text mb-3">Replication Flows Detail</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-gray-400">
                  <thead className="sticky top-0 bg-cohesity-gray">
                    <tr className="border-b border-cohesity-border">
                      {[
                        { key: 'source', label: 'Source', align: 'left' },
                        { key: 'target', label: 'Target', align: 'left' },
                        { key: 'runCount', label: 'Runs', align: 'right' },
                        { key: 'successCount', label: 'Success', align: 'right' },
                        { key: 'failureCount', label: 'Failures', align: 'right' },
                        { key: 'successRate', label: 'Success Rate', align: 'right' },
                        { key: 'totalBytesTransferred', label: 'Bytes', align: 'right' },
                        { key: 'avgLagSeconds', label: 'Avg Lag', align: 'right' },
                      ].map(col => (
                        <th
                          key={col.key}
                          className={`${col.align === 'left' ? 'text-left' : 'text-right'} px-2 py-2 font-medium cursor-pointer hover:text-cohesity-text ${replSort === col.key ? 'text-cohesity-green' : ''}`}
                          onClick={() => {
                            if (replSort === col.key) setReplSortDir(d => d === 'desc' ? 'asc' : 'desc');
                            else { setReplSort(col.key); setReplSortDir('desc'); }
                          }}
                        >
                          {col.label}{' '}
                          {replSort === col.key
                            ? (replSortDir === 'desc' ? '▼' : '▲')
                            : <span className="text-gray-600">⇅</span>}
                        </th>
                      ))}
                      <th className="text-right px-2 py-2 font-medium">Last Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedFlows.map((flow, i) => {
                      const rate = flow.runCount > 0
                        ? Math.round((flow.successCount / flow.runCount) * 100)
                        : 0;
                      const lastSeen = flow.lastSeen
                        ? new Date(flow.lastSeen).toLocaleDateString()
                        : '—';
                      return (
                        <tr key={i} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                          <td className="px-2 py-1.5 truncate max-w-[120px]">{flow.sourceClusterName}</td>
                          <td className="px-2 py-1.5 truncate max-w-[120px]">{flow.targetClusterName}</td>
                          <td className="text-right px-2 py-1.5">{flow.runCount}</td>
                          <td className="text-right px-2 py-1.5 text-green-400">{flow.successCount}</td>
                          <td className="text-right px-2 py-1.5 text-red-400">{flow.failureCount}</td>
                          <td className={`text-right px-2 py-1.5 font-medium ${successColor(rate)}`}>{rate}%</td>
                          <td className="text-right px-2 py-1.5">{formatBytes(flow.totalBytesTransferred)}</td>
                          <td className="text-right px-2 py-1.5">{formatLag(flow.avgLagSeconds)}</td>
                          <td className="text-right px-2 py-1.5">{lastSeen}</td>
                        </tr>
                      );
                    })}
                    {sortedFlows.length === 0 && (
                      <tr><td colSpan={9} className="text-center py-4 text-gray-500">No data</td></tr>
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
