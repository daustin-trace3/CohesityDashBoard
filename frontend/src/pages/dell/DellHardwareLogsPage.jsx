import { useEffect, useState, useCallback, useRef } from 'react';
import { ScrollText, Search } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtWhen } from './helpers';
import { DeviceDetailModal } from './DellDevicesPage';

const SEVERITIES = ['critical', 'fatal', 'warning', 'info'];
const TIMEFRAMES = [
  { value: 1, label: 'Last 24 hours' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: '', label: 'All retained (365d)' },
];

const sevTone = (s) => (s === 'critical' || s === 'fatal' ? 'crit' : s === 'warning' ? 'warn' : 'info');

export default function DellHardwareLogsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [days, setDays] = useState(30);
  const [detailId, setDetailId] = useState(null);
  const debounce = useRef(null);

  // Filters are applied server-side — the log table can hold hundreds of
  // thousands of rows, far past what client-side filtering should chew on.
  const load = useCallback((params) => client.get('/dell/hardware-logs', { params })
    .then(({ data }) => {
      setData({ rows: Array.isArray(data?.rows) ? data.rows : [], total: data?.total || 0 });
      setLastRefreshed(new Date());
    })
    .catch(() => { setData({ rows: [], total: 0 }); toast({ type: 'error', title: 'Failed to load hardware logs' }); }), [toast]);

  useEffect(() => {
    clearTimeout(debounce.current);
    const params = {
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(severity ? { severity } : {}),
      ...(days ? { days } : {}),
    };
    debounce.current = setTimeout(() => load(params), search ? 350 : 0);
    return () => clearTimeout(debounce.current);
  }, [search, severity, days, load]);

  const rows = data?.rows || [];
  const ctl = useTableControls(rows, {
    defaultSortKey: 'created_at', defaultSortDir: 'desc',
    paginate: true,
  });

  const selectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ScrollText} title="Hardware Logs" description="iDRAC Lifecycle/SEL log entries collected from every server — searchable by device, timeframe and severity">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={() => load({ ...(search.trim() ? { search: search.trim() } : {}), ...(severity ? { severity } : {}), ...(days ? { days } : {}) })} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search device name, service tag, message, event code…"
              className="w-full bg-surface-overlay border border-cohesity-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink outline-none focus:border-brand" />
          </div>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={selectCls} aria-label="Severity">
            <option value="">All severities</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : '')} className={selectCls} aria-label="Timeframe">
            {TIMEFRAMES.map((t) => <option key={String(t.value)} value={t.value}>{t.label}</option>)}
          </select>
          {data && (
            <p className="text-[11px] text-ink-faint ml-auto tnum">
              {rows.length.toLocaleString()}{rows.length === 5000 ? '+' : ''} matching · {Number(data.total || 0).toLocaleString()} total retained
            </p>
          )}
        </div>

        {data == null ? (
          <LoadingPanel label="Loading hardware logs…" height={200} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">
            No hardware log entries match. Logs appear after the first poll of a server's iDRAC Lifecycle log.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="severity" label="Severity" ctl={ctl} />
                  <SortTh k="created_at" label="Time" ctl={ctl} />
                  <SortTh k="device_name" label="Device" ctl={ctl} />
                  <SortTh k="category" label="Category" ctl={ctl} />
                  <SortTh k="message_id" label="Event Code" ctl={ctl} />
                  <th className="py-2 pr-3">Message</th>
                  <SortTh k="ome_name" label="OME" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((l) => (
                    <tr key={l.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3"><Badge tone={sevTone(l.severity)}>{l.severity}</Badge></td>
                      <td className="py-2 pr-3 text-ink-faint text-xs tnum whitespace-nowrap">{fmtWhen(l.created_at)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {l.device_row_id != null ? (
                          <button onClick={() => setDetailId(l.device_row_id)} className="text-brand hover:underline cursor-pointer">
                            {l.device_name || l.device_service_tag || `#${l.device_id}`}
                          </button>
                        ) : (
                          <span className="text-ink-muted">{l.device_name || l.device_service_tag || `#${l.device_id}`}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted text-xs whitespace-nowrap">{l.category || '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint tnum text-xs">{l.message_id || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-xs max-w-[420px]">
                        <span className="block truncate" title={l.message || ''}>{l.message || '—'}</span>
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">{l.ome_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>

      {detailId != null && <DeviceDetailModal deviceId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
