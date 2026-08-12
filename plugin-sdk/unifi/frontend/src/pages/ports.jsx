// Port of frontend/src/pages/unifi/UnifiPortsPage.jsx onto the plugin ui kit.
import {
  PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  apiFetch, poeWatts, BRAND,
} from '../ui.jsx';
import { Cable } from '../icons.jsx';
import PortHistoryModal from './portHistoryModal.jsx';

export default function UnifiPortsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [historyTarget, setHistoryTarget] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/unifi/ports')
    .then((data) => { setRows(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((p) => ({
    ...p,
    status_label: p.up ? 'Up' : 'Down',
    poe_label: p.poe_enable ? (p.poe_good === 0 ? 'Fault' : 'Active') : p.poe_capable ? 'Capable' : 'None',
    poe_w: poeWatts(p),
    err_total: (Number(p.rx_errors) || 0) + (Number(p.tx_errors) || 0),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['device_name', 'name', 'network_name', 'device_model'],
    defaultSortKey: 'device_name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="uf-root animate-fade-in">
      <PageHeader icon={Cable} title="Ports" description="All switch and gateway ports across the estate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by device, port name or network…"
          filters={[
            { k: 'status_label', label: 'Status' },
            { k: 'poe_label', label: 'PoE' },
            { k: 'media', label: 'Media' },
            { k: 'device_name', label: 'Devices' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading ports…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ports found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ports match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="device_name" label="Device" ctl={ctl} />
                <SortTh k="port_idx" label="Port" ctl={ctl} align="right" />
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="media" label="Media" ctl={ctl} />
                <SortTh k="status_label" label="Status" ctl={ctl} />
                <SortTh k="speed" label="Speed" ctl={ctl} align="right" />
                <SortTh k="poe_label" label="PoE" ctl={ctl} />
                <SortTh k="err_total" label="Errors" ctl={ctl} align="right" />
                <SortTh k="network_name" label="Network" ctl={ctl} />
                <SortTh k="source_name" label="Source" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((p) => (
                  <tr key={`${p.device_mac}-${p.port_idx}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setHistoryTarget(p)} className="text-brand hover:underline cursor-pointer text-left">{p.device_name || p.device_mac}</button>
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{p.port_idx}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint">{p.media || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={p.up ? 'ok' : 'neutral'}>{p.status_label}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{p.speed ? `${p.speed} Mbps` : '—'}</td>
                    <td className="py-2 pr-3">
                      {p.poe_label === 'None' ? <span className="text-ink-faint">—</span> : (
                        <Badge tone={p.poe_label === 'Fault' ? 'crit' : p.poe_label === 'Active' ? 'info' : 'neutral'}>
                          {p.poe_label}{p.poe_w != null ? ` ${p.poe_w.toFixed(1)}W` : ''}
                        </Badge>
                      )}
                    </td>
                    <td className={`py-2 pr-3 text-right tnum ${p.err_total > 0 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{p.err_total}</td>
                    <td className="py-2 pr-3 text-ink-faint">{p.network_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px]">{p.source_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {historyTarget && (
        <PortHistoryModal
          mac={historyTarget.device_mac}
          portIdx={historyTarget.port_idx}
          portLabel={historyTarget.name}
          deviceName={historyTarget.device_name}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}
