import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { MonitorSmartphone } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, ppmPct, powerTone, powerLabel, parseJsonArr } from './helpers';

const ngtTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (!s) return 'neutral';
  if (v.includes('enabled') || v.includes('installed') || v.includes('reachable') || v.includes('current')) return 'ok';
  return 'warn';
};
const fmtMem = (mb) => (mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`);

export default function NxVMsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/vms')
    .then(({ data }) => { setRows(data.vms || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load VMs' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map(v => {
    const ips = parseJsonArr(v.ip_addresses);
    return {
      ...v,
      power: powerLabel(v.power_state),
      ip: ips[0] || '',
      ip_extra: ips.length > 1 ? ips.length - 1 : 0,
      cpu_pct: ppmPct(v.cpu_usage_ppm),
      mem_pct: ppmPct(v.memory_usage_ppm),
    };
  });
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'guest_os', 'host_name', 'cluster_name', 'ip'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={MonitorSmartphone} title="VMs" description="Every VM across all registered Nutanix clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VM, OS, host, cluster or IP…"
          filters={[
            { k: 'cluster_name', label: 'Clusters' },
            { k: 'power', label: 'Power states' },
            { k: 'guest_os', label: 'Guest OS' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading VMs…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VMs found — data appears after the next poll.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VMs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="VM" ctl={ctl} />
                <SortTh k="power" label="Power" ctl={ctl} />
                <SortTh k="cpu_pct" label="CPU %" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Mem %" ctl={ctl} align="right" />
                <SortTh k="host_name" label="Host" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="num_vcpus" label="vCPU" ctl={ctl} align="right" />
                <SortTh k="memory_mb" label="Memory" ctl={ctl} align="right" />
                <SortTh k="ip" label="IP" ctl={ctl} />
                <SortTh k="ngt_status" label="NGT" ctl={ctl} />
                <SortTh k="guest_os" label="Guest OS" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((v) => (
                  <tr key={v.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      {v.name ? (
                        <Link to={`/ops/server360?name=${encodeURIComponent(v.name)}`} title="Open Server 360"
                          className="text-ink font-medium hover:text-brand">{v.name}</Link>
                      ) : '—'}
                    </td>
                    <td className="py-2 pr-3"><Badge tone={powerTone(v.power_state)}>{v.power}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.cpu_pct != null ? `${v.cpu_pct.toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.mem_pct != null ? `${v.mem_pct.toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.host_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.cluster_name || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.num_vcpus)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMem(v.memory_mb)}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.ip || '—'}{v.ip_extra ? ` +${v.ip_extra}` : ''}</td>
                    <td className="py-2 pr-3"><Badge tone={ngtTone(v.ngt_status)}>{v.ngt_status || 'Unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[180px] truncate" title={v.guest_os || ''}>{v.guest_os || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
