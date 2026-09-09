import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HardDrive, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-lg max-h-[80vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function DeviceAddressesModal({ device, onClose }) {
  const addresses = device.addresses || [];
  return (
    <ModalShell title={device.name || `Device ${device.deviceId}`} subtitle={[device.deviceType, device.deviceSubtype].filter(Boolean).join(' / ')} icon={HardDrive} onClose={onClose}>
      {device.description && <p className="text-xs text-ink-muted mb-3">{device.description}</p>}
      {addresses.length === 0 ? (
        <p className="text-sm text-ink-muted py-4 text-center">No addresses recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <th className="py-1.5 pr-3">Address</th>
              <th className="py-1.5 pr-3">State</th>
            </tr></thead>
            <tbody>
              {addresses.map((a, i) => (
                <tr key={a.address || i} className="border-b border-cohesity-border/40">
                  <td className="py-1.5 pr-3 tnum text-ink">{a.address}</td>
                  <td className="py-1.5 pr-3 text-ink-faint">{a.state || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ModalShell>
  );
}

export default function BluecatDevicesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(() => client.get('/bluecat/devices')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load devices' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((d) => ({ ...d, address_count: (d.addresses || []).length }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'deviceType', 'deviceSubtype', 'description', 'sourceName'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={HardDrive} title="Devices" description="BlueCat-registered devices and their addresses">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, type, description or source…"
          filters={[{ k: 'deviceType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading devices…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No devices found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No devices match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="deviceType" label="Type" ctl={ctl} />
                <SortTh k="deviceSubtype" label="Subtype" ctl={ctl} />
                <SortTh k="description" label="Description" ctl={ctl} />
                <SortTh k="address_count" label="Addresses" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((d) => (
                  <tr key={d.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetail(d)} className="text-brand hover:underline cursor-pointer text-left">{d.name || `Device ${d.deviceId}`}</button>
                    </td>
                    <td className="py-2 pr-3"><Badge tone="neutral">{d.deviceType || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{d.deviceSubtype || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] truncate max-w-[220px]">{d.description || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(d.address_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {detail && <DeviceAddressesModal device={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
