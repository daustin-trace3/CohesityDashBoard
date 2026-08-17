import { AlertTriangle } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, severityTone, fmtWhen,
} from '../ui.jsx';
import { DeviceDetailModal } from './devices.jsx';

const RANGES = [{ label: '24h', days: 1 }, { label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];

export default function DellAlertsPage() {
  const [rows, setRows] = React.useState(null);
  const [days, setDays] = React.useState(7);
  const [detailId, setDetailId] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch(`/dell/alerts?days=${days}`)
    .then((json) => { setRows(Array.isArray(json) ? json : []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), [days]);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'message_id', 'device_name', 'service_tag', 'category', 'subcategory', 'ome_name'],
    defaultSortKey: 'created_at', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AlertTriangle} title="Alerts" description="Hardware and health alerts raised by the registered OME instances">
        <div className="flex items-center gap-1 mr-2">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${days === r.days ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {r.label}
            </button>
          ))}
        </div>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, device, category or OME…"
          filters={[
            { k: 'ome_name', label: 'OME instances' },
            { k: 'severity', label: 'Severities' },
            { k: 'category', label: 'Categories' },
            { k: 'subcategory', label: 'Subcategories' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading alerts…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No alerts in the selected window.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No alerts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="severity" label="Severity" ctl={ctl} />
                <SortTh k="created_at" label="Time" ctl={ctl} />
                <SortTh k="device_name" label="Source" ctl={ctl} />
                <SortTh k="category" label="Category" ctl={ctl} />
                <SortTh k="message_id" label="Message ID" ctl={ctl} />
                <th className="py-2 pr-3">Message</th>
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a) => (
                  <tr key={`${a.ome_id}|${a.alert_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity}</Badge></td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(a.created_at)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {a.device_row_id != null ? (
                        <button onClick={() => setDetailId(a.device_row_id)} className="text-brand hover:underline cursor-pointer">{a.device_name || a.service_tag}</button>
                      ) : (
                        <span className="text-ink-muted">{a.device_name || a.service_tag || '—'}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{a.category || '—'}{a.subcategory ? ` · ${a.subcategory}` : ''}</td>
                    <td className="py-2 pr-3 text-ink-faint tnum text-[11px] whitespace-nowrap">{a.message_id || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-xs max-w-[420px]">{a.message || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.ome_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {detailId != null && <DeviceDetailModal deviceId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
