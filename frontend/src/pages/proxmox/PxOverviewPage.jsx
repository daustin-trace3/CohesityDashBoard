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

export default function PxOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState(null);
  const [trend, setTrend] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/proxmox/overview').then(({ data }) => setData(data)),
    client.get('/proxmox/issues').then(({ data }) => setIssues(Array.isArray(data) ? data : data?.issues || [])).catch(() => setIssues([])),
    client.get('/proxmox/metrics-history', { params: { hours: 24 } }).then(({ data }) => setTrend(data)).catch(() => setTrend([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setData({ servers: [], totals: {} }); toast({ type: 'error', title: 'Failed to load Proxmox overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

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

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 8, font: { size: 10 }, callback(value) { const l = this.getLabelForValue(value); return String(l).slice(11, 16) || l; } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 }, callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,0.1)' }, min: 0, max: 100 },
    },
  };

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
        <p className="text-sm font-semibold text-ink mb-3">CPU Usage per Node (last 24h)</p>
        {trend == null ? (
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
