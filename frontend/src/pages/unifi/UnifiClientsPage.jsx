import { useEffect, useState, useCallback } from 'react';
import { Users } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, secsToHuman, signalTone } from './helpers';

const CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'wired', label: 'Wired' },
  { key: 'wireless', label: 'Wireless' },
  { key: 'guest', label: 'Guest' },
];

function ConnectionCell({ c }) {
  if (c.is_wired) {
    return <span className="text-ink-muted text-[12px]">Wired — {c.sw_name || c.sw_mac || '—'}{c.sw_port != null ? ` port ${c.sw_port}` : ''}</span>;
  }
  const tone = signalTone(c.rssi ?? c.signal);
  const dotColor = tone === 'ok' ? '#6CB33F' : tone === 'warn' ? '#D4A24E' : '#C75D5D';
  return (
    <span className="text-ink-muted text-[12px] inline-flex items-center gap-1.5">
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
      {c.essid || '—'} via {c.ap_name || c.ap_mac || '—'}{c.signal != null ? ` (${c.signal} dBm)` : ''}
    </span>
  );
}

export default function UnifiClientsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [chip, setChip] = useState('all');

  const load = useCallback(() => client.get('/unifi/clients')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load clients' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const base = (rows || []).filter((c) => {
    if (chip === 'wired') return !!c.is_wired;
    if (chip === 'wireless') return !c.is_wired;
    if (chip === 'guest') return !!c.is_guest;
    return true;
  });

  const list = base.map((c) => ({
    ...c,
    conn_type: c.is_wired ? 'Wired' : 'Wireless',
    rate: c.is_wired ? c.wired_rate_mbps : c.tx_rate,
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'hostname', 'ip', 'mac', 'essid', 'network'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Users} title="Clients" description="Devices connected to the UniFi network">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-1 mb-3">
        {CHIPS.map((c) => (
          <button key={c.key} onClick={() => setChip(c.key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold cursor-pointer transition-colors ${chip === c.key ? 'bg-brand/10 text-brand border border-brand/30' : 'text-ink-muted border border-transparent hover:text-ink'}`}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, IP, MAC, SSID or network…"
          filters={[{ k: 'network', label: 'Networks' }, { k: 'conn_type', label: 'Connection' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading clients…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No clients found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No clients match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="ip" label="IP" ctl={ctl} />
                <SortTh k="mac" label="MAC" ctl={ctl} />
                <th className="py-2 pr-3">Connection</th>
                <SortTh k="network" label="Network" ctl={ctl} />
                <SortTh k="rate" label="Rate" ctl={ctl} align="right" />
                <SortTh k="satisfaction" label="Satisfaction" ctl={ctl} align="right" />
                <SortTh k="uptime" label="Uptime" ctl={ctl} align="right" />
                <SortTh k="rx_bytes" label="Traffic" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">
                      {c.name || c.hostname || c.mac}
                      {c.is_guest ? <Badge tone="info" className="ml-1.5">Guest</Badge> : null}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{c.ip || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{c.mac}</td>
                    <td className="py-2 pr-3"><ConnectionCell c={c} /></td>
                    <td className="py-2 pr-3 text-ink-faint">{c.network || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.rate ? `${c.rate} Mbps` : '—'}</td>
                    <td className="py-2 pr-3 text-right">
                      {c.satisfaction != null ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <div className="w-12 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.min(100, c.satisfaction)}%`, backgroundColor: c.satisfaction < 50 ? '#C75D5D' : c.satisfaction < 80 ? '#D4A24E' : '#6CB33F' }} />
                          </div>
                          <span className="tnum text-ink-muted text-[11px]">{c.satisfaction}%</span>
                        </div>
                      ) : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{secsToHuman(c.uptime)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted text-[11px]">{fmtBytes((Number(c.rx_bytes) || 0) + (Number(c.tx_bytes) || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
      <p className="text-[11px] text-ink-faint mt-2">{fmtNum(base.length)} clients shown</p>
    </div>
  );
}
