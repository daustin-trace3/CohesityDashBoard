import { useEffect, useState, useMemo, useCallback } from 'react';
import { Gauge, Server, MonitorSmartphone, Database, ShieldAlert, Boxes, Play, Power, HardDrive, Wrench, Cpu, MemoryStick } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, severityTone } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

const VC_COLORS = ['#0091DA', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#4ED4B8', '#D46CB3', '#8FA3B0'];

export default function VcOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [trend, setTrend] = useState(null);
  const [trendDays, setTrendDays] = useState(30);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/vcenter/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ vcenters: [], hosts: {}, datastores: {}, issues: [] }); toast({ type: 'error', title: 'Failed to load vCenter overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    client.get(`/vcenter/trends?days=${trendDays}`).then(({ data }) => setTrend(data)).catch(() => setTrend([]));
  }, [trendDays]);

  // VM guest count per vCenter over time — daily last snapshot per vCenter.
  const vmTrend = useMemo(() => {
    if (!trend) return null;
    const byDay = new Map(); // day -> vcenter_name -> vms_total (last wins, rows are time-ordered)
    for (const t of trend) {
      const day = String(t.captured_at).slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day).set(t.vcenter_name, t.vms_total);
    }
    const days = [...byDay.keys()].sort();
    const names = [...new Set(trend.map(t => t.vcenter_name))].sort();
    return {
      labels: days,
      datasets: names.map((name, i) => ({
        label: name,
        data: days.map(d => byDay.get(d).get(name) ?? null),
        borderColor: VC_COLORS[i % VC_COLORS.length],
        backgroundColor: VC_COLORS[i % VC_COLORS.length],
        pointRadius: days.length > 45 ? 0 : 2,
        borderWidth: 2, tension: 0.25, spanGaps: true,
      })),
    };
  }, [trend]);

  const osBar = useMemo(() => {
    const top = (data?.osBreakdown || []).slice(0, 12);
    return {
      labels: top.map(o => o.guest_os),
      datasets: [{
        data: top.map(o => o.count),
        backgroundColor: top.map((_, i) => VC_COLORS[i % VC_COLORS.length]),
        borderRadius: 3, barThickness: 12,
      }],
    };
  }, [data]);

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    },
  };

  const vcs = data?.vcenters || [];
  const hosts = data?.hosts || {};
  const ds = data?.datastores || {};
  const issues = data?.issues || [];
  const vm = data?.vmStats || {};
  const cap = data?.capacity || {};
  const orphans = data?.orphans || {};
  const density = data?.density || [];
  const dsUsedPct = ds.capacity > 0 ? ((ds.capacity - ds.free) / ds.capacity) * 100 : null;
  const critCount = issues.filter(i => i.severity === 'critical').length;
  const avgDensity = density.length ? density.reduce((n, h) => n + (h.vm_count || 0), 0) / density.length : null;

  const densityBar = useMemo(() => {
    const top = density.slice(0, 30);
    return {
      labels: top.map(h => h.name),
      datasets: [{
        data: top.map(h => h.vm_count),
        backgroundColor: top.map(h => (h.vm_count > (avgDensity || 0) * 1.5 ? '#D4A24E' : BRAND)),
        borderRadius: 3,
      }],
    };
  }, [density, avgDensity]);

  const ratio = (r) => (r == null ? '—' : `${r.toFixed(2)}:1`);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="vCenter Overview" description="ESX hosts, clusters, datastores and certificates across all registered vCenters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {vcs.length === 0 && data && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No vCenters registered yet. Add one under{' '}
            <Link to="/vcenter/settings" className="text-brand underline">vCenter → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Server} label="vCenters" value={vcs.length ? `${vcs.filter(v => v.lastPollStatus !== 'error').length} / ${vcs.length}` : '—'}
          sub="reachable" tone={vcs.some(v => v.lastPollStatus === 'error') ? 'crit' : 'brand'}
          onClick={() => navigate('/vcenter/settings')} />
        <StatCard icon={Server} label="ESX Hosts" value={hosts.total != null ? `${fmtNum(hosts.connected)} / ${fmtNum(hosts.total)}` : '—'}
          sub={hosts.maintenance ? `up · ${fmtNum(hosts.maintenance)} in maintenance` : 'up'}
          tone={hosts.total && hosts.connected < hosts.total ? 'warn' : 'ok'}
          onClick={() => navigate('/vcenter/hosts')} />
        <StatCard icon={MonitorSmartphone} label="VMs" value={fmtNum(data?.vmCount ?? hosts.vms)} sub="across all hosts"
          onClick={() => navigate('/vcenter/inventory')} />
        <StatCard icon={Database} label="Datastore Usage" value={dsUsedPct != null ? `${dsUsedPct.toFixed(1)}%` : '—'}
          sub={ds.capacity ? `${fmtBytes(ds.capacity - ds.free)} of ${fmtBytes(ds.capacity)}` : undefined}
          tone={dsUsedPct > 80 ? 'crit' : dsUsedPct > 70 ? 'warn' : 'default'}
          onClick={() => navigate('/vcenter/datastores')} />
        <StatCard icon={ShieldAlert} label="Issues" value={fmtNum(issues.length)}
          sub={issues.length ? `${critCount} critical` : 'all clear'}
          tone={critCount ? 'crit' : issues.length ? 'warn' : 'ok'} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Play} label="Running VMs" value={fmtNum(vm.powered_on)} tone="ok"
          sub={vm.suspended ? `${fmtNum(vm.suspended)} suspended` : 'powered on'}
          onClick={() => navigate('/vcenter/inventory')} />
        <StatCard icon={Power} label="Powered Off" value={fmtNum(vm.powered_off)}
          sub="VM guests" onClick={() => navigate('/vcenter/inventory')} />
        <StatCard icon={HardDrive} label="Orphaned VMDKs" value={orphans.count ? fmtBytes(orphans.bytes) : orphans.count === 0 ? '0' : '—'}
          sub={orphans.count ? `${fmtNum(orphans.count)} disk(s) unattached` : orphans.count === 0 ? 'none found' : 'needs datastore-browse privilege'}
          tone={orphans.bytes > 0 ? 'warn' : 'default'}
          onClick={() => navigate('/vcenter/governance')} />
        <StatCard icon={Wrench} label="Outdated VMware Tools" value={fmtNum(vm.tools_outdated)}
          sub="VMs needing a Tools upgrade" tone={vm.tools_outdated ? 'warn' : 'ok'}
          onClick={() => navigate('/vcenter/governance')} />
      </div>

      {/* Compute capacity & overcommit */}
      <div className="grid md:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Cpu size={15} className="text-brand" /> CPU Capacity</p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xl font-bold text-ink tnum">{fmtNum(cap.cpu_cores)}</p>
              <p className="text-[11px] text-ink-faint">physical cores</p>
            </div>
            <div>
              <p className="text-xl font-bold text-ink tnum">{fmtNum(cap.vcpus_allocated)}</p>
              <p className="text-[11px] text-ink-faint">vCPUs allocated (running)</p>
            </div>
            <div>
              <p className={`text-xl font-bold tnum ${cap.cpu_overcommit > 4 ? 'text-status-warn' : 'text-ink'}`}>{ratio(cap.cpu_overcommit)}</p>
              <p className="text-[11px] text-ink-faint">vCPU : pCore overcommit</p>
            </div>
          </div>
        </div>
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><MemoryStick size={15} className="text-brand" /> Memory Capacity</p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xl font-bold text-ink tnum">{fmtBytes(cap.mem_bytes_total)}</p>
              <p className="text-[11px] text-ink-faint">physical memory</p>
            </div>
            <div>
              <p className="text-xl font-bold text-ink tnum">{fmtBytes(cap.vm_mem_bytes_allocated)}</p>
              <p className="text-[11px] text-ink-faint">allocated to running VMs</p>
            </div>
            <div>
              <p className={`text-xl font-bold tnum ${cap.mem_overcommit > 1.5 ? 'text-status-warn' : 'text-ink'}`}>{ratio(cap.mem_overcommit)}</p>
              <p className="text-[11px] text-ink-faint">allocated : physical overcommit</p>
            </div>
          </div>
        </div>
      </div>

      {/* Trends */}
      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <p className="text-sm font-semibold text-ink mr-auto">VM Guests per vCenter</p>
            <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))}
              className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </div>
          {trend == null ? (
            <LoadingPanel label="Loading trend…" height={200} />
          ) : vmTrend.labels.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No trend data yet — snapshots accumulate as vCenters poll.</div>
          ) : (
            <div className="h-60"><Line data={vmTrend} options={chartOpts} /></div>
          )}
        </div>
        <div className="panel p-4">
          <p className="text-sm font-semibold text-ink mb-3">VMs by Guest OS</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={200} />
          ) : (data.osBreakdown || []).length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No guest OS data yet.</div>
          ) : (
            <div style={{ height: Math.max(200, Math.min(12, data.osBreakdown.length) * 24 + 60) }}>
              <Bar data={osBar} options={{
                ...chartOpts, indexAxis: 'y',
                plugins: { legend: { display: false } },
                scales: {
                  x: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
                  y: { ticks: { color: '#E5E5E5', font: { size: 9 }, callback(value) { const l = this.getLabelForValue(value); return l.length > 26 ? `${l.slice(0, 25)}…` : l; } }, grid: { display: false } },
                },
              }} />
            </div>
          )}
        </div>
      </div>

      {/* ESXi host density */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink mr-auto flex items-center gap-2"><Server size={15} className="text-brand" /> ESXi Host Density</p>
          {avgDensity != null && (
            <span className="text-[11px] text-ink-faint tnum">
              avg {avgDensity.toFixed(1)} VMs/host{density.length > 30 ? ` · top 30 of ${density.length} hosts` : ''} · amber = 1.5× above average
            </span>
          )}
        </div>
        {data == null ? (
          <LoadingPanel label="Loading…" height={180} />
        ) : density.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No per-host VM counts yet.</div>
        ) : (
          <div className="h-52">
            <Bar data={densityBar} options={{
              ...chartOpts,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { color: '#E5E5E5', font: { size: 9 }, maxRotation: 60, minRotation: 40, callback(value) { const l = this.getLabelForValue(value); return l.length > 22 ? `${l.slice(0, 21)}…` : l; } }, grid: { display: false } },
                y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' }, title: { display: true, text: 'VMs', color: '#8FA3B0', font: { size: 10 } } },
              },
            }} />
          </div>
        )}
      </div>

      {/* Per-vCenter status */}
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Boxes size={15} className="text-brand" /> vCenters</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : vcs.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {vcs.map(v => (
                <div key={v.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{v.name}</p>
                    <p className="text-[11px] text-ink-faint truncate">{v.host}{v.version ? ` · v${v.version}${v.build ? ` build ${v.build}` : ''}` : ''}</p>
                  </div>
                  <Badge tone={v.lastPollStatus === 'error' ? 'crit' : v.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                    {v.lastPollStatus === 'error' ? 'Unreachable' : v.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Issues feed */}
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Issues</p>
          <p className="text-[11px] text-ink-faint mb-3">
            Hosts down, datastores over {data?.thresholds?.dsUsedWarnPct ?? 80}%, clusters under {data?.thresholds?.clusterFreeWarnPct ?? 20}% headroom, certificates within {data?.thresholds?.certWarnDays ?? 60} days of expiry.
          </p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
              {issues.map((i, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{i.message}</p>
                    <p className="text-[10px] text-ink-faint">{i.vcenter}</p>
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
