// Circuit events section for the Circuits page (round 13). Server-paged over
// GET /logicmonitor/circuits/events, CSV from the .csv route, notes editable.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel } from '../../components/ui/primitives';
import { BRAND, arr, fmtNum, downloadCsv } from './helpers';
import { inp, sel, headRow, ServerPager } from './ui';
import { EVENT_KINDS, eventMeta, EventBadge, NoteCell, issuesLink, whenText, circuitName, roleLabel } from './circuitShared';

const DAY_OPTIONS = [7, 30, 90, 365];

export default function CircuitEventsSection({ sites }) {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [event, setEvent] = useState('');
  const [siteKey, setSiteKey] = useState('');
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [exporting, setExporting] = useState(false);
  const limit = pageSize === 'all' ? 500 : pageSize;

  const params = useCallback(() => {
    const p = { days };
    if (q.trim()) p.q = q.trim();
    if (event) p.event = event;
    if (siteKey) p.siteKey = siteKey;
    return p;
  }, [q, event, siteKey, days]);

  const load = useCallback(() => client.get('/logicmonitor/circuits/events', { params: { ...params(), page, pageSize: limit, limit } })
    .then(({ data }) => {
      setRows(arr(data?.rows ?? data?.items));
      setTotal(Number(data?.total) || 0);
    })
    .catch((e) => {
      setRows([]); setTotal(0);
      if (e?.response?.status !== 404) toast({ type: 'error', title: 'Failed to load circuit events' });
    }), [params, page, limit, toast]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/logicmonitor/circuits/events.csv', params(), 'logicmonitor-circuit-events'); }
    catch { toast({ type: 'error', title: 'Export failed' }); }
    finally { setExporting(false); }
  };

  const patch = (next) => setRows((cur) => (cur || []).map((r) => (r.id === next.id ? { ...r, ...next } : r)));
  const reset = (fn) => (e) => { fn(e.target.value); setPage(1); };

  return (
    <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }} data-testid="circuit-events">
      <div className="flex items-center gap-2 mb-1">
        <History size={14} className="text-ink-muted" />
        <h3 className="text-sm font-semibold text-ink">Circuit events</h3>
        <span className="text-[11px] text-ink-faint tnum">{fmtNum(total)} event(s)</span>
      </div>
      <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">Every WAN or site-link circuit going down or up, starting or stopping to flap, and entering or leaving saturation. Add a note to an event to keep the cause or the carrier ticket with it.</p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={q} onChange={reset(setQ)} placeholder="Search device, port or note..." className={`${inp} flex-1 min-w-[200px] max-w-sm`} spellCheck={false} />
        <select value={event} onChange={reset(setEvent)} className={sel} aria-label="Event">
          <option value="">All events</option>
          {EVENT_KINDS.map((k) => <option key={k} value={k}>{eventMeta(k).label}</option>)}
        </select>
        <select value={siteKey} onChange={reset(setSiteKey)} className={sel} aria-label="Site">
          <option value="">All sites</option>
          {arr(sites).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={days} onChange={(e) => { setDays(Number(e.target.value)); setPage(1); }} className={sel} aria-label="Window">
          {DAY_OPTIONS.map((d) => <option key={d} value={d}>{`Last ${d} days`}</option>)}
        </select>
        <button type="button" onClick={exportCsv} disabled={exporting}
          className="ml-auto flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
          <Download size={12} /> {exporting ? 'Exporting...' : 'Export'}
        </button>
      </div>

      {rows == null ? <LoadingPanel label="Loading circuit events..." height={120} /> : rows.length === 0 ? (
        <p className="text-sm text-ink-muted py-5 text-center">No circuit events in this window.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <th className="py-2 pr-3">When</th><th className="py-2 pr-3">Event</th><th className="py-2 pr-3">Site</th>
                <th className="py-2 pr-3">Circuit</th><th className="py-2 pr-3">Role</th><th className="py-2 pr-3">Far site</th><th className="py-2 pr-3">Note</th>
              </tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-cohesity-border/50 align-top">
                    <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{whenText(e.at)}</td>
                    <td className="py-2 pr-3"><EventBadge event={e.event} /></td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{e.siteName || e.siteKey || '-'}</td>
                    <td className="py-2 pr-3 text-ink text-[12px]">
                      {circuitName(e) || '-'}
                      {e.issueKey ? <Link to={issuesLink(e.issueKey, circuitName(e))} className="ml-2 text-[10px] text-brand hover:underline">Issue</Link> : null}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{roleLabel(e.role)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{e.farSiteName || e.farSiteKey || '-'}</td>
                    <td className="py-2 pr-3"><NoteCell ev={e} onSaved={patch} compact /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ServerPager shown={rows.length} total={total} page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} noun="event(s)" />
        </>
      )}
    </div>
  );
}
