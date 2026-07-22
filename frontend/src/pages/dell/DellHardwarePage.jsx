import { useEffect, useState, useCallback } from 'react';
import { Wrench, HardDrive, Layers, Unplug } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, healthTone } from './helpers';

function FailingSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['device_name', 'device_service_tag', 'kind', 'name', 'serial', 'ome_name'],
    defaultSortKey: 'status', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><HardDrive size={15} className="text-brand" /> Failing Components</p>
      <p className="text-[11px] text-ink-faint mb-3">Disks, DIMMs, PSUs and NICs whose reported status is warning or critical — replace-before-fail candidates.</p>
      {rows.length === 0 ? (
        <div className="text-sm text-status-ok py-4 text-center">All inventoried components report healthy.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by device, component, serial…"
            filters={[{ k: 'ome_name', label: 'OME instances' }, { k: 'kind', label: 'Component types' }, { k: 'status', label: 'Status' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="device_name" label="Device" ctl={ctl} />
                <SortTh k="kind" label="Component" ctl={ctl} />
                <th className="py-2 pr-3">Detail</th>
                <SortTh k="serial" label="Serial" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink whitespace-nowrap">{c.device_name || c.device_service_tag || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.kind}</td>
                    <td className="py-2 pr-3 text-ink-muted text-xs max-w-[280px] truncate" title={c.name || ''}>
                      {c.name || '—'}{c.slot ? ` · slot ${c.slot}` : ''}{c.size_bytes ? ` · ${fmtBytes(c.size_bytes)}` : ''}
                    </td>
                    <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{c.serial || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(c.status)}>{c.status}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{c.ome_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </div>
  );
}

function FirmwareSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['baseline_name', 'service_tag', 'device_model', 'ome_name'],
    defaultSortKey: 'noncompliant_components', defaultSortDir: 'desc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Layers size={15} className="text-brand" /> Firmware Compliance</p>
      <p className="text-[11px] text-ink-faint mb-3">Devices out of compliance with their OME firmware baselines. Empty when no baselines are defined on the appliance.</p>
      {rows.length === 0 ? (
        <div className="text-sm text-status-ok py-4 text-center">No non-compliant devices reported.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by baseline, service tag, model…"
            filters={[{ k: 'ome_name', label: 'OME instances' }, { k: 'baseline_name', label: 'Baselines' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="baseline_name" label="Baseline" ctl={ctl} />
                <SortTh k="service_tag" label="Service Tag" ctl={ctl} />
                <SortTh k="device_model" label="Model" ctl={ctl} />
                <SortTh k="noncompliant_components" label="Components Behind" ctl={ctl} align="center" />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((f) => (
                  <tr key={f.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{f.baseline_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{f.service_tag || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{f.device_model || '—'}</td>
                    <td className="py-2 pr-3 text-center tnum text-status-warn font-semibold">{fmtNum(f.noncompliant_components)}</td>
                    <td className="py-2 pr-3 text-ink-muted">{f.ome_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </div>
  );
}

export default function DellHardwarePage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/dell/governance')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ failing: [], firmware: [], disconnected: [] }); toast({ type: 'error', title: 'Failed to load hardware health data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Wrench} title="Hardware" description="Failing components, firmware drift and disconnected devices across the Dell estate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading hardware health…" height={200} />
      ) : (
        <>
          <FailingSection rows={data.failing || []} />
          <FirmwareSection rows={data.firmware || []} />

          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Unplug size={15} className="text-brand" /> Disconnected Devices</p>
            <p className="text-[11px] text-ink-faint mb-3">Registered in OME but currently unreachable from the appliance.</p>
            {(data.disconnected || []).length === 0 ? (
              <div className="text-sm text-status-ok py-4 text-center">Every device is connected to its OME instance.</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {data.disconnected.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 bg-surface-overlay rounded-lg px-3 py-2">
                    <Badge tone="crit">disconnected</Badge>
                    <span className="text-xs text-ink-muted">{d.name || d.service_tag} — {d.model || d.device_type}<span className="text-ink-faint"> · {d.ome_name}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
