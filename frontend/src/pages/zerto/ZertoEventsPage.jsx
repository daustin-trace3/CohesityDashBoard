import { useCallback, useEffect, useState } from 'react';
import { ScrollText, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen } from './helpers';

const WINDOWS = [{ v: 1, label: '24 hours' }, { v: 3, label: '3 days' }, { v: 7, label: '7 days' }, { v: 14, label: '14 days' }, { v: 30, label: '30 days' }];
const PAGE_SIZES = [25, 50, 100, 200];

const catTone = (c) => (c === 'Alerts' ? 'warn' : c === 'Events' ? 'info' : 'neutral');

function Tile({ label, value, tone }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`text-xl font-semibold tnum ${tone || 'text-ink'}`}>{value}</p>
    </div>
  );
}

export default function ZertoEventsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');           // debounced copy of q
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  useEffect(() => { const t = setTimeout(() => { setTerm(q); setPage(0); }, 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(() => client.get('/zerto/events', { params: { days, category: category || undefined, q: term || undefined, page, pageSize } })
    .then(({ data: d }) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => { setData({ rows: [], total: 0, counts: {} }); toast({ type: 'error', title: 'Failed to load events' }); }), [days, category, term, page, pageSize, toast]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    try {
      const res = await client.get('/zerto/events.csv', { params: { days, category: category || undefined, q: term || undefined }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zerto-events-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { toast({ type: 'error', title: 'Export failed' }); }
  };

  const counts = data?.counts || {};
  const rows = data?.rows || [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const cats = Object.keys(counts.byCategory || {}).sort();

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ScrollText} title="Zerto Events" description="The event log from Zerto Analytics: operational events and alert transitions across every site, collected each poll and kept for the retention window.">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <button onClick={exportCsv} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
          <Download size={12} /> Export
        </button>
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Tile label={`Events (${days}d)`} value={fmtNum(counts.windowTotal)} />
        <Tile label="Alert transitions" value={fmtNum(counts.byCategory?.Alerts || 0)} tone="text-status-warn" />
        <Tile label="Operational events" value={fmtNum(counts.byCategory?.Events || 0)} tone="text-status-info" />
        <Tile label="Reported failures" value={fmtNum(counts.failures)} tone={counts.failures ? 'text-status-crit' : undefined} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select value={days} onChange={(e) => { setDays(Number(e.target.value)); setPage(0); }}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
            {WINDOWS.map((w) => <option key={w.v} value={w.v}>Last {w.label}</option>)}
          </select>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(0); }}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
            <option value="">All categories</option>
            {cats.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by description, type, code, site or ZORG…"
            className="ml-auto bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-xs text-ink focus:border-brand/60 outline-none w-80 max-w-full" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(total)} rows</span>
        </div>

        {data == null ? <LoadingPanel label="Loading events…" height={140} />
          : rows.length === 0 ? <div className="text-sm text-ink-muted py-6 text-center">{counts.windowTotal ? 'No events match your filters.' : 'No events in this window yet; they collect from the next poll on.'}</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Occurred</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Code</th>
                  <th className="py-2 pr-3">Site</th>
                  <th className="py-2 pr-3">Description</th>
                  <th className="py-2">Result</th>
                </tr></thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.event_identifier} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink-muted text-[11px] tnum whitespace-nowrap">{fmtWhen(e.occurred_on)}</td>
                      <td className="py-2 pr-3"><Badge tone={catTone(e.category)}>{e.category || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-ink text-[12px]">{e.event_type || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{e.code || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{e.site_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted max-w-[440px]"><span className="line-clamp-2" title={e.description}>{e.description || '—'}</span></td>
                      <td className="py-2">{e.completed_successfully == null ? <span className="text-ink-faint text-xs">—</span>
                        : e.completed_successfully ? <Badge tone="ok">ok</Badge> : <Badge tone="crit">failed</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {total > pageSize && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 mt-1 border-t border-cohesity-border">
            <label className="flex items-center gap-2 text-xs text-ink-faint">
              Rows per page
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
                className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer">
                {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-faint tnum">{page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {fmtNum(total)}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(0)} disabled={page === 0} className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">«</button>
                <button onClick={() => setPage(page - 1)} disabled={page === 0} className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">‹</button>
                <span className="text-xs text-ink-faint px-1 tnum">{page + 1} / {pageCount}</span>
                <button onClick={() => setPage(page + 1)} disabled={page >= pageCount - 1} className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">›</button>
                <button onClick={() => setPage(pageCount - 1)} disabled={page >= pageCount - 1} className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">»</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
