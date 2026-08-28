import { useEffect, useState, useMemo, useCallback } from 'react';
import { Building2, Server, MonitorSmartphone, Cpu, MemoryStick, ArrowLeftRight, Layers } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes } from './helpers';
import { fmtMhz, fmtPctInt, pctColor, pctTone, UsageBar, SiteDot, SiteBadge, fitVerdict, BigStat, PanelTitle, NoSitesState } from './capacityShared';

const MIB = 1024 * 1024;
const pctOf = (n, d) => (d > 0 ? (n / d) * 100 : null);

function AxisRow({ icon: IconComp, title, usable, used, allocated, fmt, ratioLabel, ratio }) {
  const usedPct = pctOf(used, usable);
  return (
    <div className="pt-3 border-t border-cohesity-border/50">
      <p className="text-xs font-semibold text-ink-muted mb-2 flex items-center gap-2"><IconComp size={13} className="text-brand" />{title}</p>
      <div className="grid grid-cols-3 gap-3 text-center mb-2">
        <BigStat value={fmt(usable)} label="N+1 usable" />
        <BigStat value={fmt(used)} label={`used · ${fmtPctInt(usedPct)} of usable`} color={usedPct != null && usedPct > 80 ? pctColor(usedPct) : undefined} />
        <BigStat value={ratio} label={ratioLabel} />
      </div>
      <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, usedPct || 0)}%`, backgroundColor: pctColor(usedPct) }} />
      </div>
    </div>
  );
}

export default function VcCapacityOverviewPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [sampling, setSampling] = useState(false);

  const load = useCallback(() => client.get('/vcenter/capacity/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ sites: [], failover: [] }); toast({ type: 'error', title: 'Failed to load capacity overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const sampleNow = async () => {
    setSampling(true);
    try {
      const { data: r } = await client.post('/vcenter/capacity/sample', { refresh: false });
      toast({ type: 'success', title: `Sampled ${r.sampled} of ${r.vcenters} vCenter(s).` });
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Sample failed', message: err?.response?.data?.error || 'Sampling failed.' });
    } finally {
      setSampling(false);
    }
  };

  const sites = data?.sites || [];
  const failover = data?.failover || [];
  const pairs = data?.pairs || [];
  const siteByName = new Map(sites.map((s) => [s.name, s]));

  const clusterRows = useMemo(() => sites.flatMap((s) => (s.clusters || []).map((c) => ({
    key: `${c.vcenterId}|${c.name}`, siteName: s.name, siteColor: s.color, name: c.name, vcenterName: c.vcenterName,
    hostCount: c.hostCount, hostsConnected: c.hostsConnected, vmsOn: c.vmsOn, vmCount: c.vmCount,
    cpuUsedPct: pctOf(c.cpu?.mhzUsed, c.cpu?.usableMhz), memUsedPct: pctOf(c.mem?.bytesUsed, c.mem?.usableBytes),
    usableMem: c.mem?.usableBytes || 0, vcpuPerCore: c.cpu?.usableCores > 0 ? c.cpu.vcpuAllocated / c.cpu.usableCores : null,
  }))), [sites]);

  const totals = sites.reduce((a, s) => ({
    clusters: a.clusters + (s.clusters || []).length, hosts: a.hosts + (s.totals?.hostCount || 0), connected: a.connected + (s.totals?.hostsConnected || 0),
    vmsOn: a.vmsOn + (s.totals?.vmsOn || 0), vms: a.vms + (s.totals?.vmCount || 0),
  }), { clusters: 0, hosts: 0, connected: 0, vmsOn: 0, vms: 0 });

  const fitting = failover.filter((f) => f.fits).map((f) => f.target);
  const fitSummary = failover.length === 0 ? '—' : fitting.length === failover.length ? 'Either site' : fitting.length === 0 ? 'Neither site' : `${fitting.join(', ')} only`;
  const fitTone = failover.length === 0 ? 'default' : fitting.length === failover.length ? 'ok' : fitting.length === 0 ? 'crit' : 'warn';
  const unmapped = data?.unmappedClusterCount || 0;

  if (data === null) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={Building2} title="Site Capacity" description="Per-site compute — allocated, used and N+1 usable — with the automatic failover fit" />
        <LoadingPanel label="Loading site capacity…" height={200} />
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={Building2} title="Site Capacity" description="Per-site compute — allocated, used and N+1 usable — with the automatic failover fit" />
        <NoSitesState />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Building2} title="Site Capacity" description="Per-site compute — allocated, used and N+1 usable — with the automatic failover fit">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
        <button onClick={sampleNow} disabled={sampling} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50" title="Write an hourly capacity sample now">
          {sampling && <Spinner size={13} />} {sampling ? 'Sampling…' : 'Sample now'}
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Building2} label="Sites" value={fmtNum(sites.length)} sub={sites.length <= 3 ? sites.map((s) => s.name).join(' · ') : 'assigned in Settings → Sites'} tone="brand" />
        <StatCard icon={Layers} label="Clusters mapped" value={unmapped ? `${fmtNum(totals.clusters)} / ${fmtNum(totals.clusters + unmapped)}` : fmtNum(totals.clusters)}
          sub={unmapped ? `${unmapped} unmapped — assign in Settings` : 'all clusters assigned'} tone={unmapped ? 'warn' : 'ok'}
          onClick={() => navigate('/vcenter/settings#sites')} />
        <StatCard icon={Server} label="ESX Hosts" value={`${fmtNum(totals.connected)} / ${fmtNum(totals.hosts)}`} sub="connected"
          tone={totals.connected < totals.hosts ? 'warn' : 'default'} onClick={() => navigate('/vcenter/hosts')} />
        <StatCard icon={MonitorSmartphone} label="Running VMs" value={fmtNum(totals.vmsOn)} sub={`of ${fmtNum(totals.vms)} guests`} onClick={() => navigate('/vcenter/inventory')} />
        <StatCard icon={ArrowLeftRight} label="Full failover fits" value={fitSummary} sub="whole estate on one site" tone={fitTone} onClick={() => navigate('/vcenter/capacity/explorer')} />
      </div>

      <div className={`grid md:grid-cols-2 ${sites.length > 4 ? 'lg:grid-cols-3' : ''} gap-4 mb-4`}>
        {sites.map((site) => {
          const t = site.totals || {};
          const cpu = t.cpu || {};
          const mem = t.mem || {};
          return (
            <div key={site.id} className="panel p-4" style={{ borderTop: `3px solid ${site.color || BRAND}` }}>
              <PanelTitle meta={`${fmtNum((site.clusters || []).length)} cluster${(site.clusters || []).length === 1 ? "" : "s"} · ${fmtNum(t.hostsConnected)}/${fmtNum(t.hostCount)} hosts up · ${fmtNum(t.vmsOn)} VMs on`}>
                <SiteDot site={site} /> {site.name}
              </PanelTitle>
              <AxisRow icon={MemoryStick} title="Memory" usable={mem.usableBytes} used={mem.bytesUsed} allocated={(mem.mbAllocated || 0) * MIB} fmt={fmtBytes}
                ratio={fmtBytes((mem.mbAllocated || 0) * MIB)} ratioLabel={`allocated · ${fmtPctInt(mem.allocPct)} of usable`} />
              <AxisRow icon={Cpu} title="CPU" usable={cpu.usableMhz} used={cpu.mhzUsed} allocated={cpu.vcpuAllocated} fmt={fmtMhz}
                ratio={cpu.usableCores > 0 ? `${(cpu.vcpuAllocated / cpu.usableCores).toFixed(2)}:1` : '—'} ratioLabel={`vCPU : usable core (${fmtNum(cpu.vcpuAllocated)} vCPU)`} />
            </div>
          );
        })}
      </div>

          {pairs.length > 0 && (
            <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <PanelTitle icon={ArrowLeftRight} meta="paired sites · combined demand vs combined N+1 usable, and everything on one side alone">Failover Pairs</PanelTitle>
              <div className={`grid md:grid-cols-2 ${pairs.length > 2 ? 'lg:grid-cols-3' : ''} gap-3`}>
                {pairs.map((p) => {
                  const dirs = [p.aToB, p.bToA];
                  const worst = dirs.every((d) => d.fits) ? 'ok' : dirs.some((d) => d.fits) ? 'warn' : 'crit';
                  return (
                    <div key={p.id} className="rounded-lg px-4 py-3" style={{ background: 'var(--surface-overlay)', border: `1px solid ${worst === 'crit' ? 'rgba(248,113,113,0.4)' : 'var(--border)'}` }}>
                      <div className="flex items-center gap-2 mb-3">
                        <SiteDot site={p.a} /><span className="text-sm font-semibold text-ink">{p.a.name}</span>
                        <span className="text-ink-faint">⇄</span>
                        <SiteDot site={p.b} /><span className="text-sm font-semibold text-ink mr-auto">{p.b.name}</span>
                        <Badge tone={worst}>{worst === 'ok' ? 'Either way' : worst === 'warn' ? 'One way' : 'Neither way'}</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center mb-3">
                        <BigStat value={fmtPctInt(p.combined.mem.usedPct)} label={`memory · ${fmtBytes(p.combined.mem.bytesUsed)} of ${fmtBytes(p.combined.mem.usableBytes)}`} color={p.combined.mem.usedPct > 80 ? pctColor(p.combined.mem.usedPct) : undefined} />
                        <BigStat value={fmtPctInt(p.combined.cpu.usedPct)} label={`CPU · ${fmtMhz(p.combined.cpu.mhzUsed)} of ${fmtMhz(p.combined.cpu.usableMhz)}`} color={p.combined.cpu.usedPct > 80 ? pctColor(p.combined.cpu.usedPct) : undefined} />
                        <BigStat value={`${fmtNum(p.combined.hostCount)} / ${fmtNum(p.combined.vmsOn)}`} label="hosts / VMs on across the pair" />
                      </div>
                      {dirs.map((d) => (
                        <div key={d.from} className="flex items-center gap-2 text-xs py-1.5 border-t border-cohesity-border/50">
                          <span className="text-ink-muted" style={{ minWidth: 0 }}>Everything on <b className="text-ink">{d.to}</b> (if {d.from} fails)</span>
                          <span className="tnum ml-auto" style={{ color: d.memUsedPct > 80 ? pctColor(d.memUsedPct) : undefined }}>mem {fmtPctInt(d.memUsedPct)}</span>
                          <span className="tnum" style={{ color: d.cpuUsedPct > 80 ? pctColor(d.cpuUsedPct) : undefined }}>cpu {fmtPctInt(d.cpuUsedPct)}</span>
                          <Badge tone={d.fits ? (Math.max(d.memUsedPct, d.cpuUsedPct) > 80 ? 'warn' : 'ok') : 'crit'}>{d.fits ? 'Fits' : 'Does not fit'}</Badge>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <PanelTitle icon={ArrowLeftRight} meta="whole-estate demand today vs each site's N+1 usable · judged on used, not allocated">Failover Fit</PanelTitle>
        <div className={`grid md:grid-cols-2 ${failover.length > 4 ? 'lg:grid-cols-3' : ''} gap-3`}>
          {failover.map((f) => {
            const site = siteByName.get(f.target);
            const v = fitVerdict(f);
            return (
              <div key={f.target} className="rounded-lg px-4 py-3" style={{ background: 'var(--surface-overlay)', border: `1px solid ${v.tone === 'crit' ? 'rgba(248,113,113,0.4)' : 'var(--cohesity-border)'}` }}>
                <div className="flex items-center gap-2 mb-3">
                  <SiteDot site={site} />
                  <p className="text-sm font-semibold text-ink mr-auto">If everything ran in {f.target}</p>
                  <Badge tone={v.tone}>{v.label}</Badge>
                </div>
                <div className="grid grid-cols-4 gap-2 text-center">
                  <BigStat value={fmtPctInt(f.memUsedPct)} label="memory used" color={f.memUsedPct > 80 ? pctColor(f.memUsedPct) : undefined} />
                  <BigStat value={fmtPctInt(f.cpuUsedPct)} label="CPU used" color={f.cpuUsedPct > 80 ? pctColor(f.cpuUsedPct) : undefined} />
                  <BigStat value={f.vcpuPerCore != null ? `${f.vcpuPerCore.toFixed(1)}:1` : '—'} label="vCPU : core" />
                  <BigStat value={fmtPctInt(f.memAllocPct)} label="memory allocated" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <PanelTitle icon={Layers} meta={data.lastSampleAt ? `${fmtNum(data.sampleCount)} hourly samples on record` : 'no hourly samples yet — use Sample now'}>Clusters by Site</PanelTitle>
        {clusterRows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No clusters match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Cluster</th>
                <th className="py-2 pr-3">Site</th>
                <th className="py-2 pr-3">vCenter</th>
                <th className="py-2 pr-3 text-right">Hosts</th>
                <th className="py-2 pr-3 text-right">VMs on</th>
                <th className="py-2 pr-3 text-right">N+1 usable mem</th>
                <th className="py-2 pr-3 text-right">vCPU : core</th>
                <th className="py-2 pr-3 text-right">CPU used</th>
                <th className="py-2 pr-3 text-right">Mem used</th>
              </tr></thead>
              <tbody>
                {clusterRows.map((c) => (
                  <tr key={c.key} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.name}</td>
                    <td className="py-2 pr-3"><SiteBadge site={{ name: c.siteName, color: c.siteColor }} /></td>
                    <td className="py-2 pr-3 text-ink-muted">{c.vcenterName}</td>
                    <td className={`py-2 pr-3 text-right tnum ${c.hostsConnected < c.hostCount ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtNum(c.hostsConnected)} / {fmtNum(c.hostCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.vmsOn)} / {fmtNum(c.vmCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(c.usableMem)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.vcpuPerCore != null ? `${c.vcpuPerCore.toFixed(1)}:1` : '—'}</td>
                    <td className="py-2 pr-3"><UsageBar pct={c.cpuUsedPct} /></td>
                    <td className="py-2 pr-3"><UsageBar pct={c.memUsedPct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
