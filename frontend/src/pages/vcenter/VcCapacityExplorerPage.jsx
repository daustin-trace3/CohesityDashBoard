// Failover Explorer — pick VMs (or a whole site) and move them to another
// site client-side; the impact panel shows before → after against each
// site's N+1 usable. Nothing is written back. Mirrors the vCenter plugin's
// capacityExplorer.jsx; table uses the shared tableTools kit.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowLeftRight, Layers, Building2 } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes } from './helpers';
import { fmtMhz, fmtPctInt, pctColor, SiteDot, SiteBadge, PanelTitle, NoSitesState } from './capacityShared';

const MIB = 1024 * 1024;
const pctOf = (n, d) => (d > 0 ? (n / d) * 100 : null);
const ghostBtn = 'inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer';
const inp = 'bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

function ImpactRow({ label, before, after, fmt, usable }) {
  const changed = before !== after;
  const pctAfter = pctOf(after, usable);
  return (
    <div className="text-xs py-1 border-b border-cohesity-border/30" style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px' }}>
      <span className="text-ink-muted">{label}</span>
      {usable > 0 ? (
        <span className="tnum text-right" style={{ color: pctAfter > 80 ? pctColor(pctAfter) : undefined }}>{fmtPctInt(pctAfter)} of usable</span>
      ) : <span />}
      <span className="tnum whitespace-nowrap" style={{ gridColumn: '1 / -1' }}>
        <span className="text-ink-faint">{fmt(before)}</span>
        <span className="text-ink-faint"> → </span>
        <span className={`font-semibold ${changed ? 'text-ink' : 'text-ink-faint'}`}>{fmt(after)}</span>
      </span>
    </div>
  );
}

export default function VcCapacityExplorerPage() {
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [scenario, setScenario] = useState(new Map()); // vmId -> targetSiteId
  const [selected, setSelected] = useState(new Set());
  const [preset, setPreset] = useState({ from: '', to: '' });

  const load = useCallback(() => client.get('/vcenter/capacity/explorer')
    .then(({ data: j }) => { setData(j); setScenario(new Map()); setSelected(new Set()); setLastRefreshed(new Date()); })
    .catch(() => setData({ sites: [], vms: [] })), []);
  useEffect(() => { load(); }, [load]);

  const sites = data?.sites || [];
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const rows = useMemo(() => (data?.vms || []).map((v) => ({
    ...v,
    siteName: siteById.get(v.siteId)?.name || '',
    targetName: siteById.get(scenario.get(v.id) ?? v.siteId)?.name || '',
    state: v.powerState === 'POWERED_ON' ? 'On' : v.powerState === 'POWERED_OFF' ? 'Off' : 'Suspended',
    memUsageBytes: (v.memUsageMb || 0) * MIB,
  })), [data, scenario, siteById]);
  const ctl = useTableControls(rows, { searchKeys: ['name', 'cluster', 'vcenterName'], defaultSortKey: 'memUsageBytes', defaultSortDir: 'desc', paginate: true, defaultPageSize: 50 });

  // Delta math: before = server rollup; each moved VM is subtracted from its
  // source and added to its target. Powered-on VMs carry used + allocated.
  const impact = useMemo(() => {
    const out = {};
    for (const s of sites) {
      out[s.id] = {
        cpuUsedBefore: s.cpu?.mhzUsed || 0, cpuUsedAfter: s.cpu?.mhzUsed || 0,
        memUsedBefore: s.mem?.bytesUsed || 0, memUsedAfter: s.mem?.bytesUsed || 0,
        vcpuBefore: s.cpu?.vcpuAllocated || 0, vcpuAfter: s.cpu?.vcpuAllocated || 0,
        memAllocBefore: (s.mem?.mbAllocated || 0) * MIB, memAllocAfter: (s.mem?.mbAllocated || 0) * MIB,
        usableCpu: s.cpu?.usableMhz || 0, usableCores: s.cpu?.usableCores || 0, usableMem: s.mem?.usableBytes || 0,
        movedIn: 0, movedOut: 0,
      };
    }
    const apply = (site, vm, sign) => {
      if (!site || vm.powerState !== 'POWERED_ON') return;
      site.cpuUsedAfter += sign * (vm.cpuUsageMhz || 0);
      site.memUsedAfter += sign * (vm.memUsageMb || 0) * MIB;
      site.vcpuAfter += sign * (vm.cpuCount || 0);
      site.memAllocAfter += sign * (vm.memoryMb || 0) * MIB;
    };
    for (const vm of data?.vms || []) {
      const target = scenario.get(vm.id);
      if (!vm.siteId || target == null || target === vm.siteId) continue;
      apply(out[vm.siteId], vm, -1);
      apply(out[target], vm, +1);
      if (out[vm.siteId]) out[vm.siteId].movedOut += 1;
      if (out[target]) out[target].movedIn += 1;
    }
    return out;
  }, [data, sites, scenario]);

  const moveVms = (ids, targetSiteId) => {
    setScenario((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        const vm = (data?.vms || []).find((v) => v.id === id);
        if (!vm || !vm.siteId) continue;
        if (targetSiteId === vm.siteId) next.delete(id); else next.set(id, targetSiteId);
      }
      return next;
    });
    setSelected(new Set());
  };
  const moveAll = (fromId, toId) => moveVms((data?.vms || []).filter((v) => v.siteId === fromId).map((v) => v.id), toId);
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pageIds = ctl.pageRows.filter((v) => v.siteId != null).map((v) => v.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const togglePage = () => setSelected((s) => { const n = new Set(s); if (allPageSelected) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id)); return n; });

  const movedCount = scenario.size;
  const anyOverflow = Object.values(impact).some((i) => pctOf(i.memUsedAfter, i.usableMem) > 100 || pctOf(i.cpuUsedAfter, i.usableCpu) > 100);
  const touched = sites.filter((s) => impact[s.id].movedIn || impact[s.id].movedOut);
  const worst = touched.filter((s) => impact[s.id].movedIn).map((s) => ({ site: s, pct: pctOf(impact[s.id].memUsedAfter, impact[s.id].usableMem) }))
    .sort((a, b) => (b.pct || 0) - (a.pct || 0))[0] || null;
  // With many sites (one per cluster) the impact list shows only sites the
  // scenario touches; with a few, every site stays visible.
  const manySites = sites.length > 4;
  const impactSites = manySites ? touched : sites;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ArrowLeftRight} title="Failover Explorer" description="Move VMs — or a whole site — to another site and see the resulting demand against N+1 usable. Nothing is changed in vCenter.">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? <LoadingPanel label="Loading explorer…" /> : sites.length === 0 ? <NoSitesState what="the explorer" /> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard icon={Layers} label="VMs in scenario" value={fmtNum(movedCount)} sub={movedCount ? 'moved from their current site' : 'select VMs or use a preset'} tone={movedCount ? 'brand' : 'default'} />
            <StatCard icon={Building2} label="Sites affected" value={fmtNum(touched.length)} sub={touched.length ? touched.map((s) => s.name).slice(0, 3).join(', ') + (touched.length > 3 ? '…' : '') : `of ${fmtNum(sites.length)} sites`} tone={touched.length ? 'brand' : 'default'} />
            <StatCard icon={ArrowLeftRight} label="Busiest target after" value={worst ? fmtPctInt(worst.pct) : '—'} sub={worst ? `${worst.site.name} memory of N+1 usable` : 'no moves yet'}
              tone={!worst ? 'default' : worst.pct > 100 ? 'crit' : worst.pct > 80 ? 'warn' : 'ok'} />
            <StatCard icon={ArrowLeftRight} label="Scenario verdict" value={movedCount ? (anyOverflow ? 'Does not fit' : 'Fits') : '—'} sub={movedCount ? 'against N+1 usable' : 'no moves yet'}
              tone={!movedCount ? 'default' : anyOverflow ? 'crit' : 'ok'} />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <p className="text-sm font-semibold text-ink mr-auto">Virtual Machines</p>
                {selected.size > 0 && (
                  <>
                    <span className="text-[11px] text-ink-faint tnum">{fmtNum(selected.size)} selected → move to</span>
                    {sites.map((s) => <button key={s.id} onClick={() => moveVms([...selected], s.id)} className={ghostBtn}><SiteDot site={s} size={8} /> {s.name}</button>)}
                  </>
                )}
              </div>
              <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by VM, cluster or vCenter…"
                filters={[{ k: 'siteName', label: 'Sites' }, { k: 'state', label: 'States' }, { k: 'cluster', label: 'Clusters' }]} />
              {rows.length === 0 ? (
                <div className="text-sm text-ink-muted py-6 text-center">No VMs in mapped clusters yet.</div>
              ) : ctl.rows.length === 0 ? (
                <div className="text-sm text-ink-muted py-6 text-center">No VMs match your filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-2 w-6"><input type="checkbox" checked={allPageSelected} onChange={togglePage} className="accent-brand cursor-pointer" title="Select this page" /></th>
                      <SortTh k="name" label="VM" ctl={ctl} />
                      <SortTh k="cluster" label="Cluster" ctl={ctl} />
                      <SortTh k="state" label="State" ctl={ctl} />
                      <SortTh k="cpuUsageMhz" label="CPU used" ctl={ctl} align="right" />
                      <SortTh k="memUsageBytes" label="Mem used" ctl={ctl} align="right" />
                      <SortTh k="memoryMb" label="vCPU / vRAM" ctl={ctl} align="right" />
                      <SortTh k="siteName" label="Site" ctl={ctl} />
                      <SortTh k="targetName" label="Scenario" ctl={ctl} />
                    </tr></thead>
                    <tbody>
                      {ctl.pageRows.map((vm) => {
                        const target = scenario.get(vm.id);
                        const moved = target != null && target !== vm.siteId;
                        return (
                          <tr key={vm.id} className="border-b border-cohesity-border/50" style={moved ? { background: 'rgba(0,145,218,0.06)' } : undefined}>
                            <td className="py-2 pr-2"><input type="checkbox" checked={selected.has(vm.id)} onChange={() => toggle(vm.id)} disabled={vm.siteId == null} className="accent-brand cursor-pointer" /></td>
                            <td className="py-2 pr-3 text-ink">{vm.name}<span className="block text-[10px] text-ink-faint">{vm.vcenterName}</span></td>
                            <td className="py-2 pr-3 text-ink-muted">{vm.cluster}</td>
                            <td className="py-2 pr-3"><Badge tone={vm.powerState === 'POWERED_ON' ? 'ok' : 'neutral'}>{vm.state}</Badge></td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{vm.powerState === 'POWERED_ON' ? fmtMhz(vm.cpuUsageMhz) : '—'}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{vm.powerState === 'POWERED_ON' ? fmtBytes(vm.memUsageBytes) : '—'}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtNum(vm.cpuCount)} / {fmtBytes((vm.memoryMb || 0) * MIB)}</td>
                            <td className="py-2 pr-3"><SiteBadge site={siteById.get(vm.siteId)} /></td>
                            <td className="py-2 pr-3">
                              {moved ? (
                                <span className="text-xs text-brand inline-flex items-center gap-1">→ <SiteDot site={siteById.get(target)} size={8} /> {vm.targetName}</span>
                              ) : <span className="text-[11px] text-ink-faint">stays</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <TablePager ctl={ctl} />
            </div>

            <div className="flex flex-col gap-4">
              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <PanelTitle icon={ArrowLeftRight}>Scenario</PanelTitle>
                <p className="text-[11px] text-ink-faint mb-2">Move every VM of one site to another, or tick VMs in the table and pick a destination.</p>
                <div className="flex flex-col gap-2">
                  {manySites ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <select value={preset.from} onChange={(e) => setPreset((p) => ({ ...p, from: e.target.value }))} className={inp} style={{ flex: '1 1 120px' }}>
                        <option value="">From site…</option>
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      <span className="text-ink-faint">→</span>
                      <select value={preset.to} onChange={(e) => setPreset((p) => ({ ...p, to: e.target.value }))} className={inp} style={{ flex: '1 1 120px' }}>
                        <option value="">To site…</option>
                        {sites.filter((s) => String(s.id) !== preset.from).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      <button onClick={() => moveAll(Number(preset.from), Number(preset.to))} disabled={!preset.from || !preset.to} className={ghostBtn}>Move all</button>
                    </div>
                  ) : sites.flatMap((from) => sites.filter((to) => to.id !== from.id).map((to) => (
                    <button key={`${from.id}-${to.id}`} onClick={() => moveAll(from.id, to.id)} className={`${ghostBtn} justify-start`}>
                      <SiteDot site={from} size={8} /> {from.name} <span className="text-ink-faint">→</span> <SiteDot site={to} size={8} /> {to.name}
                    </button>
                  )))}
                  {movedCount > 0 && (
                    <button onClick={() => { setScenario(new Map()); setSelected(new Set()); }} className={`${ghostBtn} justify-center text-status-crit`}>Reset scenario</button>
                  )}
                </div>
              </div>

              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <PanelTitle icon={Layers} meta={manySites && touched.length ? `${fmtNum(sites.length - touched.length)} sites unchanged` : 'before → after'}>Impact by Site</PanelTitle>
                {manySites && touched.length === 0 && <p className="text-[11px] text-ink-faint">Sites appear here once the scenario moves VMs into or out of them.</p>}
                <div className="flex flex-col gap-3">
                  {impactSites.map((s) => {
                    const i = impact[s.id];
                    const memPct = pctOf(i.memUsedAfter, i.usableMem);
                    const cpuPct = pctOf(i.cpuUsedAfter, i.usableCpu);
                    const over = memPct > 100 || cpuPct > 100;
                    const tight = !over && (memPct > 80 || cpuPct > 80);
                    return (
                      <div key={s.id} className="rounded-lg px-3 py-2 bg-surface-overlay border" style={{ borderColor: over ? 'rgba(248,113,113,0.4)' : undefined }}>
                        <div className="flex items-center gap-2 mb-1">
                          <SiteDot site={s} />
                          <p className="text-sm font-semibold text-ink mr-auto">{s.name}</p>
                          {(i.movedIn || i.movedOut) ? <span className="text-[10px] text-ink-faint tnum">+{i.movedIn} / −{i.movedOut} VMs</span> : null}
                          <Badge tone={over ? 'crit' : tight ? 'warn' : 'ok'}>{over ? 'Does not fit' : tight ? 'Tight' : 'Fits'}</Badge>
                        </div>
                        <ImpactRow label="Memory used" before={i.memUsedBefore} after={i.memUsedAfter} fmt={fmtBytes} usable={i.usableMem} />
                        <ImpactRow label="CPU used" before={i.cpuUsedBefore} after={i.cpuUsedAfter} fmt={fmtMhz} usable={i.usableCpu} />
                        <ImpactRow label="Memory allocated" before={i.memAllocBefore} after={i.memAllocAfter} fmt={fmtBytes} usable={i.usableMem} />
                        <div className="flex items-center gap-2 text-xs py-1">
                          <span className="text-ink-muted" style={{ width: 120, flexShrink: 0 }}>vCPU : usable core</span>
                          <span className="tnum text-ink-faint">{i.usableCores ? (i.vcpuBefore / i.usableCores).toFixed(2) : '—'}</span>
                          <span className="text-ink-faint">→</span>
                          <span className={`tnum font-semibold ${i.vcpuBefore !== i.vcpuAfter ? 'text-ink' : 'text-ink-faint'}`}>{i.usableCores ? (i.vcpuAfter / i.usableCores).toFixed(2) : '—'}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
