// Proxmox VE Overview — ports host frontend/src/pages/proxmox/PxOverviewPage.jsx
// onto the px- kit. Chart.js/react-chartjs-2 replaced with charts.jsx's
// hand-rolled inline-SVG LineChart (no host chart.js import available).
import {
  injectStyles, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated,
  ServerIcon, MonitorIcon, DbIcon, BoxesIcon, AlertTriangleIcon, LayersIcon, fmtBytes as kitFmtBytes,
} from '../ui.jsx';
import { LineChart } from '../charts.jsx';

injectStyles();

const BRAND = '#E57000';
const PX_COLORS = ['#E57000', '#0091DA', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#4ED4B8', '#D46CB3'];
const RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month'];

function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}
function fmtWhen(iso) {
  if (!iso) return '—';
  const raw = typeof iso === 'string' && !iso.includes('T') ? `${iso}Z`.replace(' ', 'T') : iso;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}
function severityTone(sev) {
  return sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
}

function apiGet(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api/proxmox${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

export default function PxOverviewPage() {
  const navigate = ReactRouterDOM.useNavigate();
  const [data, setData] = React.useState(null);
  const [issues, setIssues] = React.useState(null);
  const [trend, setTrend] = React.useState(null);
  const [nodes, setNodes] = React.useState(null);
  const [selectedNodeId, setSelectedNodeId] = React.useState(null);
  const [rrdTimeframe, setRrdTimeframe] = React.useState('day');
  const [rrd, setRrd] = React.useState(null);
  const [rrdFailed, setRrdFailed] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    return Promise.all([
      apiGet('/overview').then((d) => setData(d)),
      apiGet('/issues').then((d) => setIssues(Array.isArray(d) ? d : d?.issues || [])).catch(() => setIssues([])),
      apiGet('/metrics-history', { hours: 24 }).then((d) => setTrend(d)).catch(() => setTrend([])),
      apiGet('/nodes').then((d) => {
        setNodes(d);
        setSelectedNodeId((prev) => prev ?? (d[0]?.id ?? null));
      }).catch(() => setNodes([])),
    ]).then(() => setLastRefreshed(new Date()))
      .catch(() => setData({ servers: [], totals: {} }))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    if (selectedNodeId == null) return;
    setRrd(null);
    setRrdFailed(false);
    apiGet(`/nodes/${selectedNodeId}/rrd`, { timeframe: rrdTimeframe })
      .then((d) => setRrd(Array.isArray(d) ? d : []))
      .catch(() => { setRrd(null); setRrdFailed(true); });
  }, [selectedNodeId, rrdTimeframe]);

  const rrdCharts = React.useMemo(() => {
    if (!rrd || rrd.length === 0) return null;
    const xFor = (r, i) => i;
    const labelAt = (r) => {
      const d = new Date(Number(r.time) * 1000);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    return {
      cpu: {
        series: [
          { label: 'Used cores', color: '#E57000', points: rrd.map((r, i) => ({ x: xFor(r, i), y: r.cpu == null || !r.maxcpu ? null : r.cpu * r.maxcpu })) },
          { label: 'Total cores', color: '#8A8A8A', dashed: true, points: rrd.map((r, i) => ({ x: xFor(r, i), y: r.maxcpu == null ? null : r.maxcpu })) },
        ],
      },
      mem: {
        series: [
          { label: 'Used', color: '#0091DA', points: rrd.map((r, i) => ({ x: xFor(r, i), y: r.memused == null ? null : r.memused })) },
          { label: 'Total', color: '#8A8A8A', dashed: true, points: rrd.map((r, i) => ({ x: xFor(r, i), y: r.memtotal == null ? null : r.memtotal })) },
        ],
      },
      iowait: {
        series: [{ label: 'IO Wait %', color: '#D4A24E', points: rrd.map((r, i) => ({ x: xFor(r, i), y: r.iowait == null ? null : r.iowait * 100 })) }],
      },
      labels: rrd.map(labelAt),
    };
  }, [rrd]);

  const useRrd = rrdCharts != null && !rrdFailed;

  const servers = data?.servers || [];
  const totals = data?.totals || {};
  const issueList = issues || [];
  const critCount = issueList.filter((i) => i.severity === 'critical').length;

  const cpuTrend = React.useMemo(() => {
    if (!trend || trend.length === 0) return null;
    const byTime = new Map();
    for (const t of trend) {
      if (!byTime.has(t.capturedAt)) byTime.set(t.capturedAt, new Map());
      byTime.get(t.capturedAt).set(t.node, t.cpuUsage);
    }
    const times = [...byTime.keys()].sort();
    const nodeNames = [...new Set(trend.map((t) => t.node))].sort();
    return {
      series: nodeNames.map((name, i) => ({
        label: name,
        color: PX_COLORS[i % PX_COLORS.length],
        points: times.map((t, idx) => {
          const v = byTime.get(t).get(name);
          return { x: idx, y: v == null ? null : v * 100 };
        }),
      })),
    };
  }, [trend]);

  const storagePct = totals.storageTotalBytes > 0 ? (totals.storageUsedBytes / totals.storageTotalBytes) * 100 : null;

  return (
    <div className="px-root px-fade-in">
      <PageHeader icon={ServerIcon} title="Proxmox VE Overview" description="Nodes, guests, storage and cluster health across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      {servers.length === 0 && data && (
        <div className="px-panel" style={{ padding: 16, marginBottom: 16, border: '1px solid rgba(251,191,36,0.4)' }}>
          <p style={{ fontSize: 13, color: 'var(--px-ink)', margin: 0 }}>
            No Proxmox servers registered yet. Add one under{' '}
            <a onClick={(e) => { e.preventDefault(); navigate('/proxmox/settings'); }} href="/proxmox/settings" style={{ color: 'var(--px-brand)', textDecoration: 'underline', cursor: 'pointer' }}>
              Proxmox VE → Settings
            </a> to start polling.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }} className="px-stat-grid">
        <style>{`@media (min-width: 900px) { .px-stat-grid { grid-template-columns: repeat(5,1fr) !important; } }`}</style>
        <StatCard icon={ServerIcon} label="Nodes" value={totals.nodes != null ? `${fmtNum(totals.nodesOnline)} / ${fmtNum(totals.nodes)}` : '—'}
          sub="online" tone={totals.nodes && totals.nodesOnline < totals.nodes ? 'crit' : 'ok'} loading={loading}
          onClick={() => navigate('/proxmox/nodes')} />
        <StatCard icon={MonitorIcon} label="Guests" value={totals.guests != null ? `${fmtNum(totals.guestsRunning)} / ${fmtNum(totals.guests)}` : '—'}
          sub="running / total" loading={loading} onClick={() => navigate('/proxmox/guests')} />
        <StatCard icon={BoxesIcon} label="VMs vs LXC" value={totals.vms != null ? `${fmtNum(totals.vms)} / ${fmtNum(totals.containers)}` : '—'}
          sub="qemu / lxc" loading={loading} onClick={() => navigate('/proxmox/guests')} />
        <StatCard icon={DbIcon} label="Storage Used" value={storagePct != null ? `${storagePct.toFixed(1)}%` : '—'}
          sub={totals.storageTotalBytes ? `${kitFmtBytes(totals.storageUsedBytes)} of ${kitFmtBytes(totals.storageTotalBytes)}` : undefined}
          tone={storagePct > 95 ? 'crit' : storagePct > 85 ? 'warn' : 'default'} loading={loading}
          onClick={() => navigate('/proxmox/storage')} />
        <StatCard icon={AlertTriangleIcon} label="Issues" value={fmtNum(totals.openIssues ?? issueList.length)}
          sub={(totals.criticalIssues ?? critCount) ? `${totals.criticalIssues ?? critCount} critical` : 'all clear'}
          tone={(totals.criticalIssues ?? critCount) ? 'crit' : (totals.openIssues ?? issueList.length) ? 'warn' : 'ok'} loading={loading}
          onClick={() => navigate('/proxmox/alerts')} />
      </div>

      <div className="px-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', margin: 0, marginRight: 'auto' }}>
            {useRrd ? 'Node Trends' : 'CPU Usage per Node (last 24h)'}
          </p>
          {nodes && nodes.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {nodes.map((n) => (
                <button key={n.id} onClick={() => setSelectedNodeId(n.id)} className={`px-pill${selectedNodeId === n.id ? ' px-pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }}>
                  {n.name}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 4 }}>
            {RRD_TIMEFRAMES.map((tf) => (
              <button key={tf} onClick={() => setRrdTimeframe(tf)} className={`px-pill${rrdTimeframe === tf ? ' px-pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }}>
                {tf}
              </button>
            ))}
          </div>
        </div>
        {useRrd ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="px-trend-grid">
            <style>{`@media (min-width: 1024px) { .px-trend-grid { grid-template-columns: 1fr 1fr !important; } }`}</style>
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--px-ink-muted)', marginBottom: 6 }}>CPU — used vs total cores</p>
              <LineChart series={rrdCharts.cpu.series} height={200} />
            </div>
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--px-ink-muted)', marginBottom: 6 }}>Memory — used vs total</p>
              <LineChart series={rrdCharts.mem.series} height={200} yFmt={(v) => kitFmtBytes(v)} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--px-ink-muted)', marginBottom: 6 }}>IO Wait</p>
              <LineChart series={rrdCharts.iowait.series} height={160} yFmt={(v) => `${v}%`} />
            </div>
          </div>
        ) : rrd == null && !rrdFailed ? (
          <LoadingPanel label="Loading trend…" height={200} />
        ) : trend == null ? (
          <LoadingPanel label="Loading trend…" height={200} />
        ) : !cpuTrend || cpuTrend.series.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No trend data yet — snapshots accumulate as servers poll.</div>
        ) : (
          <LineChart series={cpuTrend.series} height={240} yFmt={(v) => `${Math.round(v)}%`} />
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="px-lower-grid">
        <style>{`@media (min-width: 1024px) { .px-lower-grid { grid-template-columns: 1fr 1fr !important; } }`}</style>
        <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <LayersIcon size={15} style={{ color: 'var(--px-brand)' }} /> Servers
          </p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : servers.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>None registered.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {servers.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--px-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--px-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</p>
                    <p style={{ fontSize: 11, color: 'var(--px-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.host}{s.pveVersion ? ` · PVE ${s.pveVersion}` : ''}</p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                    <Badge tone={s.status === 'error' ? 'crit' : s.status === 'success' ? 'ok' : 'neutral'}>
                      {s.status === 'error' ? 'Unreachable' : s.status === 'success' ? 'Up' : 'Pending'}
                    </Badge>
                    {s.lastPollAt && (
                      <span title={fmtWhen(s.lastPollAt)} style={{ fontSize: 10, color: 'var(--px-ink-faint)', whiteSpace: 'nowrap' }}>polled {fmtWhen(s.lastPollAt)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangleIcon size={15} style={{ color: 'var(--px-brand)' }} /> Issues
          </p>
          <p style={{ fontSize: 11, color: 'var(--px-ink-faint)', marginBottom: 12 }}>
            Offline nodes, storage over threshold, failed/stale backups, cert expiry, quorum loss and task failures.
          </p>
          {issues == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issueList.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--px-ok)', padding: '24px 0', textAlign: 'center' }}>No issues detected.</div>
          ) : (
            <div className="px-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '45vh', overflowY: 'auto', paddingRight: 4 }}>
              {issueList.map((i, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--px-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 12, color: 'var(--px-ink)', margin: 0, lineHeight: 1.5 }}>{i.message}</p>
                    <p style={{ fontSize: 10, color: 'var(--px-ink-faint)', margin: 0 }}>{i.source}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
