import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ShieldCheck, X, Users, CalendarClock, FolderTree } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

const fmtFrequency = (s) => {
  if (!s) return null;
  if (s % 604800 === 0) { const w = s / 604800; return w === 1 ? 'Weekly' : `Every ${w} weeks`; }
  if (s % 86400 === 0) { const d = s / 86400; return d === 1 ? 'Daily' : `Every ${d} days`; }
  if (s % 3600 === 0) return `Every ${s / 3600}h`;
  return `Every ${s}s`;
};

function DetailSection({ icon: Icon, title, count, children }) {
  return (
    <div className="mb-4 last:mb-0">
      <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5">
        <Icon size={13} className="text-brand" /> {title}
        <span className="text-ink-faint font-normal tnum">({count})</span>
      </p>
      {children}
    </div>
  );
}

function PolicyDetailModal({ policy, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client.get(`/netbackup/policies/${policy.id}`)
      .then(({ data }) => { if (!cancelled) setDetail(data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [policy.id]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-auto min-w-[560px] max-w-[92vw] p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate">{policy.name}</h2>
            <p className="text-[11px] text-ink-faint">
              {policy.policyType || '—'} · {policy.sourceName}
              {' '}<Badge tone={policy.active ? 'ok' : 'neutral'}>{policy.active ? 'Active' : 'Inactive'}</Badge>
            </p>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink cursor-pointer shrink-0"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto min-h-[120px]">
          {error ? (
            <div className="text-sm text-status-error py-6 text-center">Failed to load policy detail.</div>
          ) : !detail ? (
            <div className="flex items-center justify-center py-10"><Spinner /></div>
          ) : !detail.hasDetail ? (
            <div className="text-sm text-ink-muted py-6 text-center">
              No stored detail for this policy yet — it will populate on the next poll of {policy.sourceName}.
            </div>
          ) : (
            <>
              <DetailSection icon={Users} title="Clients" count={detail.clients.length}>
                {detail.clients.length === 0 ? <p className="text-xs text-ink-faint">None</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {detail.clients.map((c) => (
                      <Link key={c} to={`/ops/server360?name=${encodeURIComponent(c)}`} title="Open Server 360"
                        className="text-xs px-2 py-1 rounded-md bg-surface-overlay border border-cohesity-border text-ink hover:text-brand hover:border-brand/50 transition-colors">
                        {c}
                      </Link>
                    ))}
                  </div>
                )}
              </DetailSection>
              <DetailSection icon={CalendarClock} title="Schedules" count={detail.schedules.length}>
                {detail.schedules.length === 0 ? <p className="text-xs text-ink-faint">None</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-1.5 pr-3">Name</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">Frequency</th><th className="py-1.5">Retention Level</th>
                    </tr></thead>
                    <tbody>
                      {detail.schedules.map((s, i) => (
                        <tr key={`${s.name}-${i}`} className="border-b border-cohesity-border/50">
                          <td className="py-1.5 pr-3 text-ink">{s.name || '—'}</td>
                          <td className="py-1.5 pr-3 text-ink-muted">{s.type || '—'}</td>
                          <td className="py-1.5 pr-3 text-ink-muted">{fmtFrequency(s.frequencySeconds) || '—'}</td>
                          <td className="py-1.5 text-ink-muted tnum">{s.retentionLevel ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </DetailSection>
              <DetailSection icon={FolderTree} title="Backup Selections" count={detail.selections.length}>
                {detail.selections.length === 0 ? <p className="text-xs text-ink-faint">None</p> : (
                  <ul className="space-y-1">
                    {detail.selections.map((sel, i) => (
                      <li key={i} className="text-xs font-mono text-ink-muted bg-surface-overlay border border-cohesity-border rounded-md px-2 py-1 break-all">{sel}</li>
                    ))}
                  </ul>
                )}
              </DetailSection>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function NbPoliciesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detailPolicy, setDetailPolicy] = useState(null);

  const load = useCallback(() => client.get('/netbackup/policies')
    .then(({ data }) => { setRows(data.policies || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load policies' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'sourceName'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Policies" description="Backup policies across all registered NetBackup sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <p className="text-sm font-semibold text-ink">Policies</p>
          <CsvExportButton filename="netbackup-policies" rows={ctl.rows} columns={[
            { label: 'Name', get: 'name' },
            { label: 'Source', get: 'sourceName' },
            { label: 'Type', get: 'policyType' },
            { label: 'Active', get: (r) => (r.active ? 'Yes' : 'No') },
            { label: 'Clients', get: 'clientCount' },
            { label: 'Schedules', get: 'scheduleCount' },
            { label: 'Selections', get: 'selectionCount' },
            { label: 'Failed (24h)', get: 'failed24h' },
          ]} />
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by policy or source…"
          filters={[{ k: 'policyType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading policies…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No policies found — register a NetBackup source under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No policies match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="policyType" label="Type" ctl={ctl} />
                <SortTh k="active" label="Active" ctl={ctl} />
                <SortTh k="sourceName" label="Source" ctl={ctl} />
                <SortTh k="clientCount" label="Clients" ctl={ctl} align="right" />
                <SortTh k="scheduleCount" label="Schedules" ctl={ctl} align="right" />
                <SortTh k="selectionCount" label="Selections" ctl={ctl} align="right" />
                <SortTh k="failed24h" label="Failed (24h)" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetailPolicy(p)} title="View clients, schedules and selections"
                        className="text-ink font-medium hover:text-brand cursor-pointer text-left">
                        {p.name}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{p.policyType || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{p.sourceName}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.clientCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.scheduleCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.selectionCount)}</td>
                    <td className="py-2 pr-3 text-right">
                      {p.failed24h ? <Badge tone="crit">{p.failed24h}</Badge> : <span className="text-ink-faint tnum">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
      {detailPolicy && <PolicyDetailModal policy={detailPolicy} onClose={() => setDetailPolicy(null)} />}
    </div>
  );
}
