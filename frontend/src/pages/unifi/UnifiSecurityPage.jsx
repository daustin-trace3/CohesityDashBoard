import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen } from './helpers';

export default function UnifiSecurityPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/unifi/security')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ ips: {}, rogueCounts: {}, events: [] }); toast({ type: 'error', title: 'Failed to load security data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const ips = data?.ips || {};
  const rogueCounts = data?.rogueCounts || {};
  const events = data?.events || [];

  const ctl = useTableControls(events, {
    searchKeys: ['event_type', 'message', 'event_key'],
    defaultSortKey: 'occurred_at', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Security" description="Intrusion prevention status, rogue AP counts and security events">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading security data…" height={160} />
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-3 mb-4">
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-sm font-semibold text-ink flex items-center gap-2"><ShieldCheck size={15} className="text-brand" /> IPS / IDS</p>
                <Badge tone={ips.enabled ? 'ok' : 'neutral'}>{ips.enabled ? 'Enabled' : 'Disabled'}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Categories</p>
                  <p className="text-sm text-ink tnum">{fmtNum(ips.categories?.length)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Ad Blocking</p>
                  <p className="text-sm text-ink">{ips.adBlocking ? 'On' : 'Off'}</p>
                </div>
              </div>
            </div>
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink flex items-center gap-2 mb-2"><ShieldAlert size={15} className="text-brand" /> Rogue Access Points</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Total Seen</p>
                  <p className="text-lg font-bold text-ink tnum">{fmtNum(rogueCounts.total)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Flagged</p>
                  <p className={`text-lg font-bold tnum ${rogueCounts.flagged ? 'text-status-crit' : 'text-ink'}`}>{fmtNum(rogueCounts.flagged)}</p>
                </div>
              </div>
            </div>
          </div>

          <p className="text-sm font-semibold text-ink mb-3">Security Events</p>
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <TableControls ctl={ctl} rows={events} searchPlaceholder="Filter by event type or message…"
              filters={[{ k: 'event_type', label: 'Types' }]} />
            {events.length === 0 ? (
              <div className="text-sm text-status-ok py-6 text-center">No security events recorded.</div>
            ) : ctl.rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No events match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="occurred_at" label="Time" ctl={ctl} />
                    <SortTh k="event_type" label="Event" ctl={ctl} />
                    <th className="py-2 pr-3">Message</th>
                  </tr></thead>
                  <tbody>
                    {ctl.pageRows.map((e) => (
                      <tr key={e.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(e.occurred_at)}</td>
                        <td className="py-2 pr-3"><Badge tone="crit">{e.event_type || e.event_key || '—'}</Badge></td>
                        <td className="py-2 pr-3 text-ink-muted max-w-[420px] truncate" title={e.message}>{e.message || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={ctl} />
          </div>
        </>
      )}
    </div>
  );
}
