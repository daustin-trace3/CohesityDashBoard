import { useEffect, useState, useCallback } from 'react';
import { Database, HardDrive } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtBytes, fmtRatio } from './helpers';

function UsageBar({ pct }) {
  if (pct == null) return <span className="text-ink-faint">—</span>;
  const color = pct > 90 ? '#C75D5D' : pct > 80 ? '#D4A24E' : '#6CB33F';
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="w-24 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
      </div>
      <span className="tnum text-xs" style={{ color: pct > 80 ? color : undefined }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

export default function NxStoragePage() {
  const { toast } = useToast();
  const [containers, setContainers] = useState(null);
  const [disks, setDisks] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/storage')
    .then(({ data }) => { setContainers(data.containers || []); setDisks(data.disks || []); setLastRefreshed(new Date()); })
    .catch(() => { setContainers([]); setDisks([]); toast({ type: 'error', title: 'Failed to load storage' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const containerList = (containers || []).map(c => ({
    ...c,
    used_pct: c.capacity_bytes > 0 ? (c.usage_bytes / c.capacity_bytes) * 100 : null,
  }));
  const ctl = useTableControls(containerList, {
    searchKeys: ['name', 'cluster_name'],
    defaultSortKey: 'used_pct', defaultSortDir: 'desc',
    paginate: true,
  });

  const diskList = (disks || []).map(d => ({ ...d, status_label: d.bad ? 'BAD' : d.online === 0 ? 'OFFLINE' : (d.status || 'ONLINE') }));
  const diskCtl = useTableControls(diskList, {
    searchKeys: ['serial', 'model', 'vendor', 'tier', 'host_name'],
    defaultSortKey: 'host_name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="Storage" description="Storage containers and physical disks across all clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Containers</p>
        <TableControls ctl={ctl} rows={containerList} searchPlaceholder="Filter by container or cluster…"
          filters={[{ k: 'cluster_name', label: 'Clusters' }]} />
        {containers == null ? (
          <LoadingPanel label="Loading containers…" height={140} />
        ) : containerList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No containers found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No containers match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Container" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="replication_factor" label="RF" ctl={ctl} align="right" />
                <th className="py-2 pr-3 text-left text-[11px] uppercase tracking-wide">Efficiency</th>
                <SortTh k="capacity_bytes" label="Capacity" ctl={ctl} align="right" />
                <SortTh k="free_bytes" label="Free" ctl={ctl} align="right" />
                <SortTh k="reduction_ratio_ppm" label="Reduction" ctl={ctl} align="right" />
                <SortTh k="used_pct" label="Used" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.cluster_name || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.replication_factor ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {c.compression_enabled ? <Badge tone="info" className="mr-1">Compress</Badge> : null}
                      {c.dedup_enabled ? <Badge tone="info" className="mr-1">Dedup</Badge> : null}
                      {c.erasure_code ? <Badge tone="info">EC-X</Badge> : null}
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(c.capacity_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(c.free_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(c.reduction_ratio_ppm)}</td>
                    <td className="py-2 pr-3"><UsageBar pct={c.used_pct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><HardDrive size={15} className="text-brand" /> Physical Disks</p>
        <TableControls ctl={diskCtl} rows={diskList} searchPlaceholder="Filter by serial, model, tier or host…"
          filters={[{ k: 'tier', label: 'Tiers' }, { k: 'status_label', label: 'Status' }]} />
        {disks == null ? (
          <LoadingPanel label="Loading disks…" height={140} />
        ) : diskList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No disk data collected.</div>
        ) : diskCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No disks match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="serial" label="Serial" ctl={diskCtl} />
                <SortTh k="host_name" label="Host" ctl={diskCtl} />
                <SortTh k="model" label="Model" ctl={diskCtl} />
                <SortTh k="tier" label="Tier" ctl={diskCtl} />
                <SortTh k="size_bytes" label="Size" ctl={diskCtl} align="right" />
                <SortTh k="status_label" label="Status" ctl={diskCtl} />
              </tr></thead>
              <tbody>
                {diskCtl.pageRows.map((d) => (
                  <tr key={d.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{d.serial || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{d.host_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{[d.vendor, d.model].filter(Boolean).join(' ') || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{d.tier || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(d.size_bytes)}</td>
                    <td className="py-2 pr-3"><Badge tone={d.bad ? 'crit' : d.online === 0 ? 'warn' : 'ok'}>{d.status_label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={diskCtl} />
      </div>
    </div>
  );
}
