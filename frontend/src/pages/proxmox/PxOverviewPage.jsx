import { useEffect, useState, useMemo, useCallback } from 'react';
import { Gauge, Server, MonitorSmartphone, Database, ShieldAlert, Boxes, Layers } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, severityTone, fmtWhen } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const PX_COLORS = ['#E57000', '#0091DA', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#4ED4B8', '#D46CB3'];

const RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month'];

export default function PxOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState(null);
  const [trend, setTrend] = useState(null);
  const [nodes, setNodes] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [rrdTimeframe, setRrdTimeframe] = useState('day');
  const [rrd, setRrd] = useState(null);
  const [rrdFailed, setRrdFailed] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/proxmox/overview').then(({ data }) => setData(data)),
    client.get('/proxmox/issues').then(({ data }) => setIssues(Array.isArray(data) ? data : data?.issues || [])).catch(() => setIssues([])),
    client.get('/proxmox/metrics-history', { params: { hours: 24 } }).then(({ data }) => setTrend(data)).catch(() => setTrend([])),
    client.get('/proxmox/nodes').then(({ data }) => {
      setNodes(data);
      setSelectedNodeId(prev => prev ?? (data[0]?.id ?? null));
    }).catch(() => setNodes([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setData({ servers: [], totals: {} }); toast({ type: 'error', title: 'Failed to load Proxmox overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (selectedNodeId == null) return;
    setRrd(null);
    setRrdFailed(false);
    client.get(`/proxmox/nodes/${selectedNodeId}/rrd`, { params: { timeframe: rrdTimeframe } })
      .then(({ data }) => setRrd(Array.isArray(data) ? data : []))
      .catch(() => { setRrd(null); setRrdFailed(true); });
  }, [selectedNodeId, rrdTimeframe]);

  const rrdCharts = useMemo(() => {
    if (!rrd || rrd.length === 0) return null;
    const labels = rrd.map(r => {
      const d = new Date(Number(r.time) * 1000);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    const pr = rrd.length > 60 ? 0 : 2;
    const line = (label, data, color, extra = {}) => ({
      label, data, borderColor: color, backgroundColor: color, pointRadius: pr, borderWidth: 2, tension: 0.25, spanGaps: true, ...extra,
    });
    return {
      cpu: {
        labels,
        datasets: [
          line('Used cores', rrd.map(r => (r.cpu == null || !r.maxcpu ? null : r.cpu * r.maxcpu)), '#E57000'),
          line('Total cores', rrd.map(r => (r.maxcpu == null ? null : r.maxcpu)), '#8A8A8A', { borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 }),
        ],
      },
      mem: {
        labels,
        datasets: [
          line('Used', rrd.map(r => (r.memused == null ? null : r.memused)), '#0091DA'),
          line('Total', rrd.map(r => (r.memtotal == null ? null : r.memtotal)), '#8A8A8A', { borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 }),
        ],
      },
      iowait: {
        labels,
        datasets: [line('IO Wait %', rrd.map(r => (r.iowait == null ? null : r.iowait * 100)), '#D4A24E')],
      },
    };
  }, [rrd]);

  const useRrd = rrdCharts != null && !rrdFailed;

  const servers = data?.servers || [];
  const totals = data?.totals || {};
  const issueList = issues || [];
  const critCount = issueList.filter(i => i.severity === 'critical').length;

  const cpuTrend = useMemo(() => {
    if (!trend) return null;
    const byTime = new Map(); // capturedAt -> node -> cpuUsage
    for (const t of trend) {
      if (!byTime.has(t.capturedAt)) byTime.set(t.capturedAt, new Map());
      byTime.get(t.capturedAt).set(t.node, t.cpuUsage);
    }
    const times = [...byTime.keys()].sort();
    const nodes = [...new Set(trend.map(t => t.node))].sort();
    return {
      labels: times,
      datasets: nodes.map((name, i) => ({
        label: name,
        data: times.map(t => {
          const v = byTime.get(t).get(name);
          return v == null ? null : v * 100;
        }),
        borderColor: PX_COLORS[i % PX_COLORS.length],
        backgroundColor: PX_COLORS[i % PX_COLORS.length],
        pointRadius: times.length > 45 ? 0 : 2,
        borderWidth: 2, tension: 0.25, spanGaps: true,
      })),
    };
  }, [trend]);

  const baseX = {
    ticks: { color: '#E5E5E5', maxTicksLimit: 8, font: { size: 10 }, callback(value) { const l = this.getLabelForValue(value); return String(l).slice(11, 16) || l; } },
    grid: { color: 'rgba(255,255,255,0.1)' },
  };
  const makeOpts = (yTicks, yMax) => ({
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: { x: baseX, y: { ticks: { color: '#E5E5E5', font: { size: 10 }, ...yTicks }, grid: { color: 'rgba(255,255,255,0.1)' }, min: 0, ...(yMax !== undefined ? { max: yMax } : {}) } },
  });
  const chartOpts = makeOpts({ callback: (v) => `${v}%` }, 100);
  const coreOpts = makeOpts({ callback: (v) => `${v}` });
  const byteOpts = makeOpts({ callback: (v) => fmtBytes(v), maxTicksLimit: 6 });
  const iowaitOpts = makeOpts({ callback: (v) => `${v}%` });

  const storagePct = totals.storageTotalBytes > 0 ? (totals.storageUsedBytes / totals.storageTotalBytes) * 100 : null;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Proxmox VE Overview" description="Nodes, guests, storage and cluster health across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {servers.length === 0 && data && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No Proxmox servers registered yet. Add one under{' '}
            <Link to="/proxmox/settings" className="text-brand underline">Proxmox VE → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Server} label="Nodes" value={totals.nodes != null ? `${fmtNum(totals.nodesOnline)} / ${fmtNum(totals.nodes)}` : '—'}
          sub="online" tone={totals.nodes && totals.nodesOnline < totals.nodes ? 'crit' : 'ok'}
          onClick={() => navigate('/proxmox/nodes')} />
        <StatCard icon={MonitorSmartphone} label="Guests" value={totals.guests != null ? `${fmtNum(totals.guestsRunning)} / ${fmtNum(totals.guests)}` : '—'}
          sub="running / total" onClick={() => navigate('/proxmox/guests')} />
        <StatCard icon={Boxes} label="VMs vs LXC" value={totals.vms != null ? `${fmtNum(totals.vms)} / ${fmtNum(totals.containers)}` : '—'}
          sub="qemu / lxc" onClick={() => navigate('/proxmox/guests')} />
        <StatCard icon={Database} label="Storage Used" value={storagePct != null ? `${storagePct.toFixed(1)}%` : '—'}
          sub={totals.storageTotalBytes ? `${fmtBytes(totals.storageUsedBytes)} of ${fmtBytes(totals.storageTotalBytes)}` : undefined}
          tone={storagePct > 95 ? 'crit' : storagePct > 85 ? 'warn' : 'default'}
          onClick={() => navigate('/proxmox/storage')} />
        <StatCard icon={ShieldAlert} label="Issues" value={fmtNum(totals.openIssues ?? issueList.length)}
          sub={(totals.criticalIssues ?? critCount) ? `${totals.criticalIssues ?? critCount} critical` : 'all clear'}
          tone={(totals.criticalIssues ?? critCount) ? 'crit' : (totals.openIssues ?? issueList.length) ? 'warn' : 'ok'}
          onClick={() => navigate('/proxmox/alerts')} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink mr-auto">
            {useRrd ? 'Node Trends' : 'CPU Usage per Node (last 24h)'}
          </p>
          {nodes && nodes.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {nodes.map(n => (
                <button key={n.id} onClick={() => setSelectedNodeId(n.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer ${
                    selectedNodeId === n.id ? 'bg-brand text-cohesity-black border-brand' : 'border-cohesity-border text-ink-muted hover:text-ink'
                  }`}>
                  {n.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            {RRD_TIMEFRAMES.map(tf => (
              <button key={tf} onClick={() => setRrdTimeframe(tf)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer ${
                  rrdTimeframe === tf ? 'bg-brand text-cohesity-black border-brand' : 'border-cohesity-border text-ink-muted hover:text-ink'
                }`}>
                {tf}
              </button>
            ))}
          </div>
        </div>
        {useRrd ? (
          <div className="grid lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-ink-muted mb-1.5">CPU — used vs total cores</p>
              <div className="h-52"><Line data={rrdCharts.cpu} options={coreOpts} /></div>
            </div>
            <div>
              <p className="text-xs font-semibold text-ink-muted mb-1.5">Memory — used vs total</p>
              <div className="h-52"><Line data={rrdCharts.mem} options={byteOpts} /></div>
            </div>
            <div className="lg:col-span-2">
              <p className="text-xs font-semibold text-ink-muted mb-1.5">IO Wait</p>
              <div className="h-40"><Line data={rrdCharts.iowait} options={iowaitOpts} /></div>
            </div>
          </div>
        ) : rrd == null && !rrdFailed ? (
          <LoadingPanel label="Loading trend…" height={200} />
        ) : trend == null ? (
          <LoadingPanel label="Loading trend…" height={200} />
        ) : !cpuTrend || cpuTrend.labels.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No trend data yet — snapshots accumulate as servers poll.</div>
        ) : (
          <div className="h-60"><Line data={cpuTrend} options={chartOpts} /></div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Layers size={15} className="text-brand" /> Servers</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : servers.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {servers.map(s => (
                <div key={s.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{s.name}</p>
                    <p className="text-[11px] text-ink-faint truncate">{s.host}{s.pveVersion ? ` · PVE ${s.pveVersion}` : ''}</p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <Badge tone={s.status === 'error' ? 'crit' : s.status === 'success' ? 'ok' : 'neutral'}>
                      {s.status === 'error' ? 'Unreachable' : s.status === 'success' ? 'Up' : 'Pending'}
                    </Badge>
                    {s.lastPollAt && (
                      <span className="text-[10px] text-ink-faint whitespace-nowrap" title={fmtWhen(s.lastPollAt)}>
                        polled {fmtWhen(s.lastPollAt)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Issues</p>
          <p className="text-[11px] text-ink-faint mb-3">
            Offline nodes, storage over threshold, failed/stale backups, cert expiry, quorum loss and task failures.
          </p>
          {issues == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issueList.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
              {issueList.map((i, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{i.message}</p>
                    <p className="text-[10px] text-ink-faint">{i.source}</p>
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
