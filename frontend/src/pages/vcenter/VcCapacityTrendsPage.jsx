import { useEffect, useState, useMemo, useCallback } from 'react';
import { TrendingUp, MemoryStick, Cpu, MonitorSmartphone } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend } from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes } from './helpers';
import { fmtMhz, PanelTitle, NoSitesState } from './capacityShared';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']];
const TB = 1e12;
const GHZ = 1000;

const line = (label, data, color, extra = {}) => ({
  label, data, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0.25, pointRadius: 0, spanGaps: true, fill: false, ...extra,
});

function chartOptions(unit) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: { y: { beginAtZero: true, ticks: { callback: (v) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}` } } },
    plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}` } } },
  };
}

function monthsLabel(m) {
  if (m == null) return 'not growing';
  if (m > 120) return '10+ years';
  return `${m.toFixed(1)} months`;
}

export default function VcCapacityTrendsPage() {
  const { toast } = useToast();
  const [sites, setSites] = useState(null);
  const [clusters, setClusters] = useState([]);
  const [scope, setScope] = useState('all');
  const [days, setDays] = useState(30);
  const [trend, setTrend] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [vcs, setVcs] = useState([]);
  const [lookup, setLookup] = useState({ vcenterId: '', vm: '' });
  const [vmTrend, setVmTrend] = useState(null);
  const [vmLoading, setVmLoading] = useState(false);

  useEffect(() => {
    client.get('/vcenter/capacity/sites').then(({ data: j }) => { setSites(j.sites || []); setClusters(j.clusters || []); }).catch(() => { setSites([]); });
    client.get('/vcenter/vcenters').then(({ data: j }) => setVcs(Array.isArray(j) ? j : [])).catch(() => setVcs([]));
  }, []);

  const loadTrend = useCallback(() => {
    const params = new URLSearchParams({ days: String(days) });
    if (scope.startsWith('site:')) params.set('siteId', scope.slice(5));
    if (scope.startsWith('cluster:')) params.set('cluster', scope.slice(8));
    setTrend(null);
    return client.get(`/vcenter/capacity/trends?${params}`)
      .then(({ data: j }) => { setTrend(j); setLastRefreshed(new Date()); })
      .catch(() => { setTrend({ points: [], growth: {} }); toast({ type: 'error', title: 'Failed to load trends' }); });
  }, [scope, days, toast]);

  useEffect(() => { loadTrend(); }, [loadTrend]);

  const points = trend?.points || [];
  const growth = trend?.growth || {};
  const labels = points.map((p) => (days <= 7 ? String(p.t).slice(5, 13).replace('T', ' ') + 'h' : String(p.t).slice(0, 10)));

  const memData = useMemo(() => ({
    labels,
    datasets: [
      line('Used (avg)', points.map((p) => p.memBytesUsedAvg / TB), '#0091DA', { fill: true, backgroundColor: 'rgba(0,145,218,0.12)' }),
      line('Used (peak)', points.map((p) => p.memBytesUsedPeak / TB), '#0091DA', { borderDash: [4, 3], borderWidth: 1.5 }),
      line('Allocated to VMs', points.map((p) => (p.vmemMbAllocated * 1048576) / TB), '#4ED4B8', { borderWidth: 1.5 }),
      line('N+1 usable', points.map((p) => p.usableMemBytes / TB), '#6CB33F'),
    ],
  }), [points]);

  const cpuData = useMemo(() => ({
    labels,
    datasets: [
      line('Used (avg)', points.map((p) => p.cpuMhzUsedAvg / GHZ), '#0091DA', { fill: true, backgroundColor: 'rgba(0,145,218,0.12)' }),
      line('Used (peak)', points.map((p) => p.cpuMhzUsedPeak / GHZ), '#0091DA', { borderDash: [4, 3], borderWidth: 1.5 }),
      line('Allocated (vCPU × core GHz)', points.map((p) => (p.cpuCores ? (p.vcpuAllocated * (p.cpuMhzCapacity / p.cpuCores)) / GHZ : null)), '#4ED4B8', { borderWidth: 1.5 }),
      line('N+1 usable', points.map((p) => p.usableCpuMhz / GHZ), '#6CB33F'),
    ],
  }), [points]);

  const memOpts = useMemo(() => chartOptions('TB'), []);
  const cpuOpts = useMemo(() => chartOptions('GHz'), []);

  const runLookup = async () => {
    if (!lookup.vcenterId || !lookup.vm.trim()) return;
    setVmLoading(true);
    try {
      const { data: j } = await client.get(`/vcenter/capacity/vm-trends?vcenterId=${lookup.vcenterId}&vm=${encodeURIComponent(lookup.vm.trim())}&days=${days}`);
      setVmTrend(j.points || []);
    } catch { setVmTrend([]); } finally { setVmLoading(false); }
  };

  const vmLabels = (vmTrend || []).map((p) => String(p.t).slice(5, 16).replace('T', ' '));
  const vmMem = useMemo(() => ({ labels: vmLabels, datasets: [line('Memory used (GB)', (vmTrend || []).map((p) => (p.memUsageMb || 0) / 1024), '#0091DA', { fill: true, backgroundColor: 'rgba(0,145,218,0.12)' })] }), [vmTrend]);
  const vmCpu = useMemo(() => ({ labels: vmLabels, datasets: [line('CPU used (GHz)', (vmTrend || []).map((p) => (p.cpuUsageMhz || 0) / GHZ), '#6CB33F', { fill: true, backgroundColor: 'rgba(108,179,63,0.12)' })] }), [vmTrend]);

  const scopeLabel = scope === 'all' ? 'all sites' : scope.startsWith('site:') ? (sites || []).find((s) => String(s.id) === scope.slice(5))?.name || 'site' : scope.slice(8).split('|').slice(1).join('|');
  const last = points[points.length - 1];

  const controls = (
    <>
      <select value={scope} onChange={(e) => setScope(e.target.value)} className="bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none" style={{ width: 'auto', cursor: 'pointer' }}>
        <option value="all">All sites</option>
        {(sites || []).map((s) => <option key={s.id} value={`site:${s.id}`}>{s.name}</option>)}
        {clusters.length > 0 && <option disabled>── clusters ──</option>}
        {clusters.map((c) => <option key={`${c.vcenterId}|${c.name}`} value={`cluster:${c.vcenterId}|${c.name}`}>{c.name} · {c.vcenterName}</option>)}
      </select>
      <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none" style={{ width: 'auto', cursor: 'pointer' }}>
        {RANGES.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
      </select>
    </>
  );

  if (sites == null) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={TrendingUp} title="Capacity Trends" description="Hourly samples rolled up per site or cluster — average and peak demand against N+1 usable, with a linear growth projection" />
        <LoadingPanel label="Loading…" height={200} />
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={TrendingUp} title="Capacity Trends" description="Hourly samples rolled up per site or cluster — average and peak demand against N+1 usable, with a linear growth projection" />
        <NoSitesState what="trend history" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader icon={TrendingUp} title="Capacity Trends" description="Hourly samples rolled up per site or cluster — average and peak demand against N+1 usable, with a linear growth projection">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={loadTrend} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={MemoryStick} label="Memory growth" value={growth.memBytesPerDay != null ? `${growth.memBytesPerDay >= 0 ? '+' : ''}${fmtBytes(growth.memBytesPerDay)} / day` : '—'}
          sub={`${scopeLabel} · last ${days} days`} tone={growth.memBytesPerDay > 0 ? 'brand' : 'default'} />
        <StatCard icon={MemoryStick} label="Memory usable full in" value={monthsLabel(growth.monthsUntilMemFull)} sub="at the current growth rate"
          tone={growth.monthsUntilMemFull != null && growth.monthsUntilMemFull < 6 ? 'crit' : growth.monthsUntilMemFull != null && growth.monthsUntilMemFull < 12 ? 'warn' : 'ok'} />
        <StatCard icon={Cpu} label="CPU growth" value={growth.cpuMhzPerDay != null ? `${growth.cpuMhzPerDay >= 0 ? '+' : ''}${fmtMhz(growth.cpuMhzPerDay)} / day` : '—'}
          sub={`${scopeLabel} · last ${days} days`} tone={growth.cpuMhzPerDay > 0 ? 'brand' : 'default'} />
        <StatCard icon={Cpu} label="CPU usable full in" value={monthsLabel(growth.monthsUntilCpuFull)} sub="at the current growth rate"
          tone={growth.monthsUntilCpuFull != null && growth.monthsUntilCpuFull < 6 ? 'crit' : growth.monthsUntilCpuFull != null && growth.monthsUntilCpuFull < 12 ? 'warn' : 'ok'} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink mr-auto flex items-center gap-2"><MemoryStick size={15} className="text-brand" /> Memory</p>
          {last && <span className="text-[11px] text-ink-faint tnum">latest: {fmtBytes(last.memBytesUsedAvg)} used of {fmtBytes(last.usableMemBytes)} N+1 usable · {fmtNum(last.vmsOn)} VMs on</span>}
          {controls}
        </div>
        {trend == null ? <LoadingPanel label="Loading history…" height={260} />
          : points.length === 0 ? <div className="text-sm text-ink-muted py-8 text-center">No samples in this window yet — history starts with the first hourly sample (Site Capacity → Sample now).</div>
            : <div style={{ height: 260 }}><Line data={memData} options={memOpts} /></div>}
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink mr-auto flex items-center gap-2"><Cpu size={15} className="text-brand" /> CPU</p>
          {last && <span className="text-[11px] text-ink-faint tnum">latest: {fmtMhz(last.cpuMhzUsedAvg)} used of {fmtMhz(last.usableCpuMhz)} N+1 usable · {fmtNum(last.vcpuAllocated)} vCPU allocated</span>}
        </div>
        {trend == null ? <LoadingPanel label="Loading history…" height={260} />
          : points.length === 0 ? <div className="text-sm text-ink-muted py-8 text-center">No samples in this window yet.</div>
            : <div style={{ height: 260 }}><Line data={cpuData} options={cpuOpts} /></div>}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <PanelTitle icon={MonitorSmartphone} meta={`${days}-day window · 90 days retained per VM`}>VM History</PanelTitle>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select value={lookup.vcenterId} onChange={(e) => setLookup((l) => ({ ...l, vcenterId: e.target.value }))} className="bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none" style={{ width: 'auto', cursor: 'pointer' }}>
            <option value="">Select a vCenter…</option>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <input value={lookup.vm} onChange={(e) => setLookup((l) => ({ ...l, vm: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') runLookup(); }}
            placeholder="Exact VM name" className="w-full max-w-md bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none" spellCheck={false} />
          <button onClick={runLookup} disabled={vmLoading || !lookup.vcenterId || !lookup.vm.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
            {vmLoading ? 'Loading…' : 'Look up'}
          </button>
        </div>
        {vmTrend == null ? (
          <p className="text-[11px] text-ink-faint">Pick a vCenter and enter a VM name to chart its sampled CPU and memory demand.</p>
        ) : vmTrend.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No history for that VM in the last {days} days — check the name (it must match exactly).</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            <div><p className="text-[11px] text-ink-faint mb-1">Memory used (GB)</p><div style={{ height: 200 }}><Line data={vmMem} options={{ plugins: { legend: { display: false } } }} /></div></div>
            <div><p className="text-[11px] text-ink-faint mb-1">CPU used (GHz)</p><div style={{ height: 200 }}><Line data={vmCpu} options={{ plugins: { legend: { display: false } } }} /></div></div>
          </div>
        )}
      </div>
    </div>
  );
}
