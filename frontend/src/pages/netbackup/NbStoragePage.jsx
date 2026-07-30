import { useEffect, useState, useCallback, useMemo } from 'react';
import { HardDrive, Database } from 'lucide-react';
import { Doughnut } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated, Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes } from './helpers';

ChartJS.register(ArcElement, Tooltip, Legend);

function UsageBar({ pct }) {
  if (pct == null) return <span className="text-ink-faint text-[11px]">—</span>;
  const tone = pct > 90 ? 'bg-status-crit' : pct > 80 ? 'bg-status-warn' : 'bg-brand';
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <div className="flex-1 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-[11px] text-ink-muted tnum w-10 text-right">{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function NbStoragePage() {
  const { toast } = useToast();
  const [units, setUnits] = useState(null);
  const [pools, setPools] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netbackup/storage')
    .then(({ data }) => { setUnits(data.storageUnits || []); setPools(data.diskPools || []); setLastRefreshed(new Date()); })
    .catch(() => { setUnits([]); setPools([]); toast({ type: 'error', title: 'Failed to load storage' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const unitList = (units || []).map(u => ({
    ...u,
    usedPct: u.capacityBytes > 0 && u.usedBytes != null ? (u.usedBytes / u.capacityBytes) * 100 : null,
  }));
  const poolList = (pools || []).map(p => ({
    ...p,
    usedPct: p.totalCapacityBytes > 0 && p.usedCapacityBytes != null ? (p.usedCapacityBytes / p.totalCapacityBytes) * 100 : null,
  }));

  const poolTypeRollup = useMemo(() => {
    const byType = new Map();
    for (const p of poolList) {
      const type = p.serverType || 'Unknown';
      if (!byType.has(type)) byType.set(type, { type, pools: 0, total: 0, used: 0 });
      const t = byType.get(type);
      t.pools += 1;
      t.total += p.totalCapacityBytes || 0;
      t.used += p.usedCapacityBytes || 0;
    }
    return [...byType.values()]
      .map((t) => ({ ...t, usedPct: t.total > 0 ? (t.used / t.total) * 100 : null }))
      .sort((a, b) => b.total - a.total);
  }, [poolList]);

  const unitCtl = useTableControls(unitList, { searchKeys: ['name', 'sourceName'], defaultSortKey: 'name', paginate: true });
  const poolCtl = useTableControls(poolList, { searchKeys: ['name', 'sourceName'], defaultSortKey: 'name', paginate: true });

  const totals = useMemo(() => {
    const capacity = unitList.reduce((n, u) => n + (u.capacityBytes || 0), 0) + poolList.reduce((n, p) => n + (p.totalCapacityBytes || 0), 0);
    const used = unitList.reduce((n, u) => n + (u.usedBytes || 0), 0) + poolList.reduce((n, p) => n + (p.usedCapacityBytes || 0), 0);
    return { capacity, used };
  }, [unitList, poolList]);

  const doughnut = {
    labels: ['Used', 'Free'],
    datasets: [{
      data: [totals.used, Math.max(0, totals.capacity - totals.used)],
      backgroundColor: ['#F59E0B', '#22C55E'],
      borderWidth: 0,
    }],
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={HardDrive} title="Storage" description="Storage units and disk pools across all registered NetBackup sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Storage Units</p>
          <TableControls ctl={unitCtl} rows={unitList} searchPlaceholder="Filter by unit or source…"
            filters={[{ k: 'storageUnitType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
          {units == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : unitList.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No storage units found — register a NetBackup source under Settings.</div>
          ) : unitCtl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No storage units match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="name" label="Name" ctl={unitCtl} />
                  <SortTh k="storageUnitType" label="Type" ctl={unitCtl} />
                  <SortTh k="diskPool" label="Disk Pool" ctl={unitCtl} />
                  <SortTh k="mediaServer" label="Media Server" ctl={unitCtl} />
                  <SortTh k="maxConcurrentJobs" label="Max Jobs" ctl={unitCtl} align="right" />
                  <SortTh k="usedPct" label="Used" ctl={unitCtl} align="right" />
                </tr></thead>
                <tbody>
                  {unitCtl.pageRows.map((u) => (
                    <tr key={u.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{u.name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{u.storageUnitType || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{u.diskPool || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{u.mediaServer || '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(u.maxConcurrentJobs)}</td>
                      <td className="py-2 pr-3 text-right"><UsageBar pct={u.usedPct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={unitCtl} />
        </div>
        <div className="panel p-4">
          <p className="text-sm font-semibold text-ink mb-3">Used vs Free</p>
          {units == null || pools == null ? (
            <LoadingPanel label="Loading…" height={200} />
          ) : totals.capacity === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No capacity data yet.</div>
          ) : (
            <div className="h-52 flex items-center justify-center">
              <Doughnut data={doughnut} options={{ responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } } }} />
            </div>
          )}
        </div>
      </div>

      {poolTypeRollup.length > 0 && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Database size={15} className="text-brand" /> Capacity by Pool Type</p>
          <p className="text-[11px] text-ink-faint mb-3">
            Usable (formatted) pool capacity as reported by NetBackup — not raw disk, and for deduplicating
            pools (MSDP, OST) post-dedup consumption, not front-end protected data.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Pool Type</th>
                <th className="py-2 pr-3 text-right">Pools</th>
                <th className="py-2 pr-3 text-right">Used</th>
                <th className="py-2 pr-3 text-right">Capacity</th>
                <th className="py-2 pr-3 text-right">Free</th>
                <th className="py-2 pr-3 w-[220px]">Usage</th>
              </tr></thead>
              <tbody>
                {poolTypeRollup.map((t) => (
                  <tr key={t.type} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink font-medium">{t.type}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{t.pools}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtBytes(t.used)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(t.total)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(Math.max(0, t.total - t.used))}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-cohesity-border overflow-hidden">
                          <div className={`h-full rounded-full ${t.usedPct >= 90 ? 'bg-status-crit' : t.usedPct >= 80 ? 'bg-status-warn' : 'bg-brand'}`}
                            style={{ width: `${Math.min(100, t.usedPct || 0)}%` }} />
                        </div>
                        <span className="text-[11px] text-ink-faint tnum w-10 text-right">{t.usedPct != null ? `${t.usedPct.toFixed(0)}%` : '—'}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Database size={15} className="text-brand" /> Disk Pools</p>
        <TableControls ctl={poolCtl} rows={poolList} searchPlaceholder="Filter by pool or source…"
          filters={[{ k: 'serverType', label: 'Pool Types' }, { k: 'status', label: 'Statuses' }, { k: 'sourceName', label: 'Sources' }]} />
        {pools == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : poolList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No disk pools found.</div>
        ) : poolCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No disk pools match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={poolCtl} />
                <SortTh k="serverType" label="Server Type" ctl={poolCtl} />
                <SortTh k="status" label="Status" ctl={poolCtl} />
                <SortTh k="volumeCount" label="Volumes" ctl={poolCtl} align="right" />
                <SortTh k="usedPct" label="Used" ctl={poolCtl} align="right" />
                <SortTh k="sourceName" label="Source" ctl={poolCtl} />
              </tr></thead>
              <tbody>
                {poolCtl.pageRows.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{p.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.serverType || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={p.status && p.status.toLowerCase() !== 'up' ? 'warn' : 'ok'}>{p.status || 'Unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.volumeCount)}</td>
                    <td className="py-2 pr-3 text-right"><UsageBar pct={p.usedPct} /></td>
                    <td className="py-2 pr-3 text-ink-muted">{p.sourceName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={poolCtl} />
      </div>
    </div>
  );
}
