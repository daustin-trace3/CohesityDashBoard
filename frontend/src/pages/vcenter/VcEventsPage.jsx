import { useEffect, useState, useCallback } from 'react';
import { History, ShieldAlert, ScrollText } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, severityTone, fmtWhen } from './helpers';

// SQLite timestamps are UTC without a zone suffix.
const asDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : null);

function fmtDuration(fromIso, toIso) {
  const from = asDate(fromIso);
  const to = toIso ? asDate(toIso) : new Date();
  if (!from || Number.isNaN(from.getTime())) return '—';
  const mins = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  if (hours < 48) return `${Math.floor(hours)}h ${mins % 60}m`;
  return `${(hours / 24).toFixed(1)}d`;
}

/* Each section owns its own table-controls instance. */

function IssueTimelineSection({ rows }) {
  const list = rows.map(r => ({
    ...r,
    state: r.status === 'open' ? 'Open' : 'Resolved',
    duration_min: (() => {
      const from = asDate(r.first_seen); const to = r.status === 'open' ? new Date() : asDate(r.resolved_at);
      return from && to ? Math.round((to.getTime() - from.getTime()) / 60000) : null;
    })(),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'vcenter', 'target', 'type'],
    defaultSortKey: 'last_seen', defaultSortDir: 'desc',
    paginate: true, defaultPageSize: 10,
  });
  const openCount = rows.filter(r => r.status === 'open').length;
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Issue Timeline</p>
      <p className="text-[11px] text-ink-faint mb-3">
        Lifecycle of the dashboard's own detections — when each issue opened, how long it lasted, and when it resolved.
        {rows.length > 0 && ` ${openCount} currently open.`}
      </p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No issue history yet — it accumulates as vCenters poll.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, vCenter or target…"
            filters={[{ k: 'state', label: 'States' }, { k: 'severity', label: 'Severities' }, { k: 'vcenter', label: 'vCenters' }, { k: 'type', label: 'Types' }]} />
          {ctl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No issues match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="state" label="State" ctl={ctl} />
                  <SortTh k="severity" label="Severity" ctl={ctl} />
                  <th className="py-2 pr-3">Issue</th>
                  <SortTh k="vcenter" label="vCenter" ctl={ctl} />
                  <SortTh k="first_seen" label="Opened" ctl={ctl} />
                  <SortTh k="resolved_at" label="Resolved" ctl={ctl} />
                  <SortTh k="duration_min" label="Duration" ctl={ctl} align="right" />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={r.id} className={`border-b border-cohesity-border/50 ${r.status === 'resolved' ? 'opacity-70' : ''}`}>
                      <td className="py-2 pr-3"><Badge tone={r.status === 'open' ? 'crit' : 'ok'}>{r.state}</Badge></td>
                      <td className="py-2 pr-3"><Badge tone={severityTone(r.severity)}>{r.severity}</Badge></td>
                      <td className="py-2 pr-3 text-ink text-xs leading-relaxed max-w-[380px]">{r.message}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.vcenter}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(r.first_seen)}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{r.status === 'open' ? '—' : fmtWhen(r.resolved_at)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtDuration(r.first_seen, r.status === 'open' ? null : r.resolved_at)}</td>
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

function VsphereEventsSection({ rows, days, setDays }) {
  const list = rows.map(e => ({ ...e, type_short: e.event_type ? String(e.event_type).replace(/Event$/, '') : '—' }));
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'entity_name', 'username', 'vcenter_name', 'type_short'],
    defaultSortKey: 'created_at', defaultSortDir: 'desc',
    paginate: true, defaultPageSize: 25,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <p className="text-sm font-semibold text-ink mr-auto flex items-center gap-2"><ScrollText size={15} className="text-brand" /> vSphere Events</p>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>
      <p className="text-[11px] text-ink-faint mb-3">
        Native events from each vCenter — errors, warnings, and key activity (migrations, power operations, host connectivity, maintenance). Collected on every poll.
      </p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">
          No events in this window yet — they're pulled from each vCenter's event stream on every poll.
        </div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, entity, user or type…"
            filters={[{ k: 'severity', label: 'Severities' }, { k: 'vcenter_name', label: 'vCenters' }, { k: 'type_short', label: 'Types' }]} />
          {ctl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No events match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="created_at" label="Time" ctl={ctl} />
                  <SortTh k="severity" label="Severity" ctl={ctl} />
                  <SortTh k="type_short" label="Type" ctl={ctl} />
                  <th className="py-2 pr-3">Message</th>
                  <SortTh k="entity_name" label="Entity" ctl={ctl} />
                  <SortTh k="username" label="User" ctl={ctl} />
                  <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((e) => (
                    <tr key={e.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(e.created_at)}</td>
                      <td className="py-2 pr-3"><Badge tone={e.severity === 'error' ? 'crit' : e.severity === 'warning' ? 'warn' : 'info'}>{e.severity}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{e.type_short}</td>
                      <td className="py-2 pr-3 text-ink text-xs leading-relaxed max-w-[420px]">{e.message || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{e.entity_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px]">{e.username || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{e.vcenter_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} sizes={[25, 50, 100, 'all']} />
        </>
      )}
    </div>
  );
}

export default function VcEventsPage() {
  const { toast } = useToast();
  const [issues, setIssues] = useState(null);
  const [events, setEvents] = useState(null);
  const [days, setDays] = useState(7);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/vcenter/issue-history').then(({ data }) => setIssues(data)),
    client.get(`/vcenter/events?days=${days}`).then(({ data }) => setEvents(data)),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setIssues(i => i || []); setEvents(e => e || []); toast({ type: 'error', title: 'Failed to load events' }); }), [toast, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={History} title="Events" description="Issue lifecycle from the dashboard's own detections, plus the native vSphere event stream">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {issues == null || events == null ? (
        <LoadingPanel label="Loading events…" height={200} />
      ) : (
        <>
          <IssueTimelineSection rows={issues} />
          <VsphereEventsSection rows={events} days={days} setDays={setDays} />
        </>
      )}
    </div>
  );
}
