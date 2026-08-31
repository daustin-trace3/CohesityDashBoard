import { useEffect, useState, useCallback, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Undo2 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtWhen, severityTone } from './helpers';

const HOURS_OPTIONS = [{ label: '1h', v: 1 }, { label: '6h', v: 6 }, { label: '24h', v: 24 }, { label: '7d', v: 168 }];
const AUTO_REFRESH_MS = 60000;

export default function BrocadeEventsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [hours, setHours] = useState(24);
  const [ackFilter, setAckFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [acting, setActing] = useState(false);
  const timerRef = useRef(null);

  const load = useCallback(() => {
    const params = { hours };
    if (ackFilter !== '') params.acknowledged = ackFilter;
    return client.get('/brocade/events', { params })
      .then(({ data }) => { setRows(data.events || []); setLastRefreshed(new Date()); })
      .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load events' }); });
  }, [toast, hours, ackFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    timerRef.current = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['description', 'sourceName', 'sourceAddress', 'fabricName', 'messageId', 'eventId'],
    defaultSortKey: 'lastOccurredMs', defaultSortDir: 'desc',
    paginate: true, defaultPageSize: 50,
  });

  const toggleSelect = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const runAck = async (unack) => {
    if (selected.size === 0) return;
    setActing(true);
    try {
      const bySource = {};
      for (const e of list) {
        if (selected.has(e.id)) {
          if (!bySource[e.sourceId]) bySource[e.sourceId] = [];
          bySource[e.sourceId].push(e.eventId);
        }
      }
      await Promise.all(Object.entries(bySource).map(([sourceId, eventIds]) =>
        client.post(`/brocade/events/${unack ? 'unack' : 'ack'}`, { sourceId: Number(sourceId), eventIds })));
      setSelected(new Set());
      await load();
      toast({ type: 'success', title: unack ? 'Events unacknowledged' : 'Events acknowledged' });
    } catch (err) {
      toast({ type: 'error', title: 'Action failed', message: err?.response?.data?.error });
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AlertTriangle} title="Events" description="Brocade fabric events and alarms — auto-refreshing every 60s">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-1">
          {HOURS_OPTIONS.map((h) => (
            <button key={h.v} onClick={() => setHours(h.v)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${hours === h.v ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {h.label}
            </button>
          ))}
        </div>
        <select value={ackFilter} onChange={(e) => setAckFilter(e.target.value)}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer">
          <option value="">All (ack status)</option>
          <option value="0">Unacknowledged</option>
          <option value="1">Acknowledged</option>
        </select>
        {selected.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-[11px] text-ink-faint">{selected.size} selected</span>
            <button onClick={() => runAck(false)} disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-status-ok hover:border-status-ok/40 transition-colors cursor-pointer disabled:opacity-50">
              <CheckCircle2 size={13} /> Ack
            </button>
            <button onClick={() => runAck(true)} disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
              <Undo2 size={13} /> Unack
            </button>
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by description, source, fabric or message ID…"
          filters={[
            { k: 'severity', label: 'Severities' },
            { k: 'eventCategory', label: 'Categories' },
            { k: 'fabricName', label: 'Fabrics' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading events…" height={200} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No events in this window.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No events match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3 w-6"></th>
                <SortTh k="severity" label="Severity" ctl={ctl} />
                <SortTh k="eventCategory" label="Category" ctl={ctl} />
                <SortTh k="sourceName" label="Source" ctl={ctl} />
                <SortTh k="fabricName" label="Fabric" ctl={ctl} />
                <th className="py-2 pr-3">Description</th>
                <SortTh k="lastOccurredMs" label="Last Seen" ctl={ctl} />
                <SortTh k="acknowledged" label="Ack" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((e) => (
                  <tr key={e.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} className="accent-brand cursor-pointer" />
                    </td>
                    <td className="py-2 pr-3"><Badge tone={severityTone(e.severityNorm)}>{e.severity}</Badge></td>
                    <td className="py-2 pr-3 text-ink-faint">{e.eventCategory || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{e.sourceName || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint">{e.fabricName || '—'}</td>
                    <td className="py-2 pr-3 text-ink max-w-[360px] truncate" title={e.description || ''}>{e.description || e.messageId || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(e.lastOccurredMs)}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={e.acknowledged ? 'ok' : 'neutral'}>{e.acknowledged ? 'Ack' : 'Open'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
