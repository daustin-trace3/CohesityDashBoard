import { useEffect, useState, useCallback } from 'react';
import { ClipboardCheck, GitCompareArrows, Wrench, HardDrive } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, fmtWhen } from './helpers';

/* Each section owns its own table-controls instance. */

function DriftSection({ rows, dataAvailable }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['host', 'cluster', 'vcenter', 'field', 'value', 'expected'],
    defaultSortKey: 'cluster', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><GitCompareArrows size={15} className="text-brand" /> ESXi Configuration Drift</p>
      <p className="text-[11px] text-ink-faint mb-3">
        Within each cluster the majority value per setting (ESX build, BIOS, NTP, DNS, SSH service) is the baseline — hosts deviating from it are listed here.
      </p>
      {!dataAvailable ? (
        <div className="text-sm text-ink-muted py-6 text-center">
          Host configuration data isn't available yet — it comes from the SOAP enrichment sweep and appears after the next poll.
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-status-ok py-6 text-center">No configuration drift detected — all cluster members match their baseline.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by host, cluster or setting…"
            filters={[{ k: 'vcenter', label: 'vCenters' }, { k: 'cluster', label: 'Clusters' }, { k: 'field', label: 'Settings' }]} />
          {ctl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No drift items match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="host" label="Host" ctl={ctl} />
                  <SortTh k="cluster" label="Cluster" ctl={ctl} />
                  <SortTh k="vcenter" label="vCenter" ctl={ctl} />
                  <SortTh k="field" label="Setting" ctl={ctl} />
                  <th className="py-2 pr-3">This Host</th>
                  <th className="py-2 pr-3">Cluster Baseline</th>
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r, i) => (
                    <tr key={`${r.host}|${r.field}|${i}`} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink whitespace-nowrap">{r.host}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.cluster}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.vcenter}</td>
                      <td className="py-2 pr-3"><Badge tone="warn">{r.field}</Badge></td>
                      <td className="py-2 pr-3 text-status-warn text-[11px] tnum max-w-[220px] truncate" title={r.value}>{r.value}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] tnum max-w-[220px] truncate" title={r.expected}>
                        {r.expected} <span className="text-ink-faint">({r.baseline_hosts}/{r.cluster_hosts} hosts)</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
        </>
      )}
    </div>
  );
}

function ToolsSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'host_name', 'cluster_name', 'vcenter_name', 'tools_version'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Wrench size={15} className="text-brand" /> Outdated VMware Tools</p>
      <p className="text-[11px] text-ink-faint mb-3">VMs whose Tools status reports an upgrade is needed — schedule a Tools update for these guests.</p>
      {rows.length === 0 ? (
        <div className="text-sm text-status-ok py-6 text-center">All VMs report current (or unmanaged) VMware Tools.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by VM, host or cluster…"
            filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'cluster_name', label: 'Clusters' }, { k: 'tools_version_status', label: 'Statuses' }]} />
          {ctl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No VMs match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="name" label="VM" ctl={ctl} />
                  <SortTh k="tools_version" label="Tools Version" ctl={ctl} />
                  <SortTh k="tools_version_status" label="Status" ctl={ctl} />
                  <SortTh k="guest_os" label="Guest OS" ctl={ctl} />
                  <SortTh k="host_name" label="Host" ctl={ctl} />
                  <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                  <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r, i) => (
                    <tr key={`${r.vcenter_name}|${r.name}|${i}`} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{r.name}</td>
                      <td className="py-2 pr-3 text-status-warn tnum text-[11px]">{r.tools_version || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone="warn">{String(r.tools_version_status || '').replace(/^guestTools/, '')}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[180px] truncate" title={r.guest_os || ''}>{r.guest_os || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.host_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.cluster_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.vcenter_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
        </>
      )}
    </div>
  );
}

function OrphanSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['path', 'datastore_name', 'vcenter_name'],
    defaultSortKey: 'size_bytes', defaultSortDir: 'desc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><HardDrive size={15} className="text-brand" /> Orphaned VMDKs</p>
      <p className="text-[11px] text-ink-faint mb-3">
        Disk files on datastores that no registered VM references — candidates for cleanup after verification.
        The sweep needs the Datastore.Browse privilege; without it this list stays empty.
      </p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No orphaned VMDKs recorded.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by path or datastore…"
            filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'datastore_name', label: 'Datastores' }]} />
          {ctl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No orphans match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="path" label="Path" ctl={ctl} />
                  <SortTh k="datastore_name" label="Datastore" ctl={ctl} />
                  <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
                  <SortTh k="size_bytes" label="Size" ctl={ctl} align="right" />
                  <SortTh k="modified_at" label="Last Modified" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={r.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink tnum text-[11px] max-w-[380px] truncate" title={r.path}>{r.path}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.datastore_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.vcenter_name}</td>
                      <td className="py-2 pr-3 text-right tnum text-status-warn font-semibold">{fmtBytes(r.size_bytes)}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(r.modified_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
        </>
      )}
    </div>
  );
}

export default function VcGovernancePage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/vcenter/governance')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ drift: [], outdatedTools: [], orphans: [], orphanBytes: 0, driftDataAvailable: false }); toast({ type: 'error', title: 'Failed to load governance data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const drift = data?.drift || [];
  const tools = data?.outdatedTools || [];
  const orphans = data?.orphans || [];

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ClipboardCheck} title="Governance" description="Configuration drift across cluster members, VMs with outdated VMware Tools, and orphaned disk files">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={GitCompareArrows} label="Drift Items" value={fmtNum(drift.length)}
          sub="hosts off cluster baseline" tone={drift.length ? 'warn' : 'ok'} />
        <StatCard icon={Wrench} label="Outdated Tools" value={fmtNum(tools.length)}
          sub="VMs needing upgrade" tone={tools.length ? 'warn' : 'ok'} />
        <StatCard icon={HardDrive} label="Orphaned Space" value={orphans.length ? fmtBytes(data?.orphanBytes) : '0'}
          sub={`${fmtNum(orphans.length)} orphaned disk(s)`} tone={orphans.length ? 'warn' : 'ok'} />
      </div>

      {data == null ? (
        <LoadingPanel label="Loading governance data…" height={200} />
      ) : (
        <>
          <DriftSection rows={drift} dataAvailable={!!data.driftDataAvailable} />
          <ToolsSection rows={tools} />
          <OrphanSection rows={orphans} />
        </>
      )}
    </div>
  );
}
