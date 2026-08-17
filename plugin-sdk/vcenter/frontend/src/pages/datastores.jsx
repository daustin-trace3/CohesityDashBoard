// vCenter Datastores & Cluster Capacity — ported from frontend/src/pages/vcenter/VcDatastoresPage.jsx.
import { Database, Layers } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtNum, fmtBytes, fmtPct,
} from '../ui.jsx';
import { VmListModal, VmDetailModal } from '../vmModals.jsx';

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

export default function VcDatastoresPage() {
  const [rows, setRows] = React.useState(null);
  const [clusters, setClusters] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [vmModal, setVmModal] = React.useState(null);
  const [detailVmId, setDetailVmId] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiFetch('/vcenter/datastores').then((json) => setRows(Array.isArray(json) ? json : [])),
    apiFetch('/vcenter/clusters').then((json) => setClusters(Array.isArray(json) ? json : [])).catch(() => setClusters([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'ds_type', 'vcenter_name'],
    defaultSortKey: 'used_pct', defaultSortDir: 'desc',
    paginate: true,
  });

  const clusterList = (clusters || []).map(c => ({
    ...c,
    cpu_free_pct: c.cpu_mhz_capacity > 0 && c.cpu_mhz_used != null ? (1 - c.cpu_mhz_used / c.cpu_mhz_capacity) * 100 : null,
    mem_free_pct: c.mem_bytes_capacity > 0 && c.mem_bytes_used != null ? (1 - c.mem_bytes_used / c.mem_bytes_capacity) * 100 : null,
  }));
  const clCtl = useTableControls(clusterList, {
    searchKeys: ['name', 'vcenter_name'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="Datastores & Cluster Capacity" description="Datastore usage (warning above 80%) and cluster compute headroom (warning below 20%)">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Datastores</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by datastore, type or vCenter…"
          filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'ds_type', label: 'Types' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading datastores…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No datastores found — register a vCenter under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No datastores match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Datastore" ctl={ctl} />
                <SortTh k="ds_type" label="Type" ctl={ctl} />
                <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
                <SortTh k="vm_count" label="VMs" ctl={ctl} align="right" />
                <SortTh k="capacity_bytes" label="Capacity" ctl={ctl} align="right" />
                <SortTh k="free_bytes" label="Free" ctl={ctl} align="right" />
                <SortTh k="used_pct" label="Used" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((d) => (
                  <tr key={`${d.vcenter_id}|${d.datastore_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setVmModal({
                        title: `VMs on ${d.name}`,
                        subtitle: `${d.ds_type || 'Datastore'} · ${d.vcenter_name}`,
                        icon: Database,
                        filter: { datastore: d.name, vcenterId: d.vcenter_id },
                      })} className="text-brand hover:underline cursor-pointer text-left">{d.name || '—'}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{d.ds_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{d.vcenter_name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(d.vm_count)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(d.capacity_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(d.free_bytes)}</td>
                    <td className="py-2 pr-3"><UsageBar pct={d.used_pct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {/* Cluster capacity */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Layers size={15} className="text-brand" /> Cluster Capacity</p>
        <p className="text-[11px] text-ink-faint mb-3">CPU and memory headroom per cluster (from host quickstats). Headroom under 20% raises an issue on the Overview.</p>
        {clusters == null ? (
          <LoadingPanel label="Loading clusters…" height={100} />
        ) : clusterList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No clusters found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Cluster" ctl={clCtl} />
                <SortTh k="vcenter_name" label="vCenter" ctl={clCtl} />
                <SortTh k="host_count" label="Hosts" ctl={clCtl} align="right" />
                <SortTh k="vm_count" label="VMs" ctl={clCtl} align="right" />
                <SortTh k="cpu_free_pct" label="CPU Headroom" ctl={clCtl} align="right" />
                <SortTh k="mem_free_pct" label="Memory Headroom" ctl={clCtl} align="right" />
                <th className="py-2 pr-3 text-left text-[11px] uppercase tracking-wide">HA / DRS</th>
              </tr></thead>
              <tbody>
                {clCtl.rows.map((c) => (
                  <tr key={`${c.vcenter_id}|${c.cluster_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.vcenter_name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.host_count)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.vm_count)}</td>
                    <td className={`py-2 pr-3 text-right tnum ${c.cpu_free_pct != null && c.cpu_free_pct < 20 ? 'text-status-crit font-semibold' : 'text-ink'}`}>{fmtPct(c.cpu_free_pct)}</td>
                    <td className={`py-2 pr-3 text-right tnum ${c.mem_free_pct != null && c.mem_free_pct < 20 ? 'text-status-crit font-semibold' : 'text-ink'}`}>{fmtPct(c.mem_free_pct)}</td>
                    <td className="py-2 pr-3">
                      {c.ha_enabled ? <Badge tone="ok">HA</Badge> : null}{' '}
                      {c.drs_enabled ? <Badge tone="info">DRS</Badge> : null}
                      {!c.ha_enabled && !c.drs_enabled ? <span className="text-ink-faint text-xs">—</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {vmModal && (
        <VmListModal {...vmModal} onClose={() => setVmModal(null)}
          onSelectVm={(v) => setDetailVmId(v.id)} />
      )}
      {detailVmId != null && <VmDetailModal vmId={detailVmId} onClose={() => setDetailVmId(null)} />}
    </div>
  );
}
