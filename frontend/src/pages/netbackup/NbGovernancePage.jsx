import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, ShieldOff, Clock, Users, Archive, GitCompareArrows } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen } from './helpers';

function Section({ innerRef, icon: Icon, title, blurb, rows, columns, emptyLabel, searchKeys, filters, rowKey }) {
  const ctl = useTableControls(rows, { searchKeys, defaultSortKey: columns[0]?.k, defaultSortDir: 'asc', paginate: true, defaultPageSize: 10 });
  return (
    <div ref={innerRef} className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Icon size={15} className="text-brand" /> {title}</p>
      {blurb && <p className="text-[11px] text-ink-faint mb-3">{blurb}</p>}
      {rows.length === 0 ? (
        <div className="text-sm text-status-ok py-6 text-center">{emptyLabel}</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter…" filters={filters || []} />
          {ctl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No rows match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  {columns.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r, i) => (
                    <tr key={rowKey(r, i)} className="border-b border-cohesity-border/50">
                      {columns.map((c) => (
                        <td key={c.k} className={`py-2 pr-3 ${c.align === 'right' ? 'text-right tnum' : ''} ${c.cls || 'text-ink-muted'}`}>
                          {c.render ? c.render(r) : (r[c.k] ?? '—')}
                        </td>
                      ))}
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

export default function NbGovernancePage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const inactiveRef = useRef(null);
  const idleRef = useRef(null);
  const unprotectedRef = useRef(null);
  const driftRef = useRef(null);

  const load = useCallback(() => client.get('/netbackup/governance')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => {
      setData({ inactivePolicies: [], idlePolicies: [], unprotectedClients: [], catalogBackup: null, versionDrift: { dominant: null, rows: [] }, summary: {} });
      toast({ type: 'error', title: 'Failed to load governance data' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);

  const inactivePolicies = data?.inactivePolicies || [];
  const idlePolicies = data?.idlePolicies || [];
  const unprotectedClients = data?.unprotectedClients || [];
  const catalogBackup = data?.catalogBackup || null;
  const versionDrift = data?.versionDrift || { dominant: null, rows: [] };
  const summary = data?.summary || {};

  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ClipboardCheck} title="Governance" description="Inactive/idle policies, unprotected clients, catalog backup health, and version drift">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={ShieldOff} label="Inactive Policies" value={fmtNum(summary.inactiveCount)}
          tone={summary.inactiveCount ? 'warn' : 'ok'} onClick={() => scrollTo(inactiveRef)} />
        <StatCard icon={Clock} label="Idle Policies" value={fmtNum(summary.idleCount)}
          tone={summary.idleCount ? 'warn' : 'ok'} onClick={() => scrollTo(idleRef)} />
        <StatCard icon={Users} label="Unprotected Clients" value={fmtNum(summary.unprotectedCount)}
          tone={summary.unprotectedCount ? 'crit' : 'ok'} onClick={() => scrollTo(unprotectedRef)} />
        <StatCard icon={Archive} label="Catalog Backup" value={summary.catalogOk == null ? '—' : summary.catalogOk ? 'OK' : 'Stale'}
          tone={summary.catalogOk == null ? 'default' : summary.catalogOk ? 'ok' : 'crit'} />
        <StatCard icon={GitCompareArrows} label="Version Outliers" value={fmtNum(summary.outlierCount)}
          tone={summary.outlierCount ? 'warn' : 'ok'} onClick={() => scrollTo(driftRef)} />
      </div>

      {data == null ? (
        <LoadingPanel label="Loading governance data…" height={200} />
      ) : (
        <>
          <Section innerRef={inactiveRef} icon={ShieldOff} title="Inactive Policies"
            blurb="Policies marked inactive but still configured — verify they should stay disabled."
            rows={inactivePolicies} emptyLabel="No inactive policies."
            searchKeys={['name', 'sourceName', 'policyType']}
            filters={[{ k: 'sourceName', label: 'Sources' }, { k: 'policyType', label: 'Policy Types' }]}
            rowKey={(r, i) => `${r.sourceId}|${r.name}|${i}`}
            columns={[
              { k: 'name', label: 'Policy' },
              { k: 'sourceName', label: 'Source' },
              { k: 'policyType', label: 'Type' },
            ]} />

          <Section innerRef={idleRef} icon={Clock} title="Idle Policies"
            blurb="Active policies with no successful run in the last 7 days."
            rows={idlePolicies} emptyLabel="No idle policies."
            searchKeys={['name', 'sourceName', 'policyType']}
            filters={[{ k: 'sourceName', label: 'Sources' }, { k: 'policyType', label: 'Policy Types' }]}
            rowKey={(r, i) => `${r.sourceId}|${r.name}|${i}`}
            columns={[
              { k: 'name', label: 'Policy' },
              { k: 'sourceName', label: 'Source' },
              { k: 'policyType', label: 'Type' },
              { k: 'lastRunAt', label: 'Last Run', align: 'right', render: (r) => fmtWhen(r.lastRunAt) },
            ]} />

          <Section innerRef={unprotectedRef} icon={Users} title="Unprotected Clients"
            blurb="Clients seen in job history whose last successful backup exceeds the stale-backup threshold."
            rows={unprotectedClients} emptyLabel="No unprotected clients."
            searchKeys={['sourceName', 'clientName']}
            filters={[{ k: 'sourceName', label: 'Sources' }]}
            rowKey={(r, i) => `${r.sourceName}|${r.clientName}|${i}`}
            columns={[
              {
                k: 'clientName', label: 'Client',
                render: (r) => r.clientName
                  ? <Link to={`/ops/server360?name=${encodeURIComponent(r.clientName)}`} className="text-ink font-medium hover:text-brand">{r.clientName}</Link>
                  : '—',
              },
              { k: 'sourceName', label: 'Source' },
              { k: 'lastSuccessAt', label: 'Last Success', align: 'right', render: (r) => fmtWhen(r.lastSuccessAt) },
            ]} />

          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Archive size={15} className="text-brand" /> Catalog Backup</p>
            {!catalogBackup ? (
              <div className="text-sm text-ink-muted py-6 text-center">No NBU-Catalog policy found.</div>
            ) : (
              <div className="flex items-center gap-4">
                <Badge tone={catalogBackup.ok ? 'ok' : 'crit'}>{catalogBackup.ok ? 'Healthy' : 'Stale'}</Badge>
                <span className="text-sm text-ink">{catalogBackup.policyName}</span>
                <span className="text-xs text-ink-muted ml-auto tnum">
                  Last success {fmtWhen(catalogBackup.lastSuccessAt)} · {catalogBackup.ageHours != null ? `${Math.round(catalogBackup.ageHours)}h ago` : '—'}
                </span>
              </div>
            )}
          </div>

          <Section innerRef={driftRef} icon={GitCompareArrows} title="Version Drift"
            blurb={versionDrift.dominant ? `Dominant version: ${versionDrift.dominant}. Rows off the majority are highlighted.` : 'Media server and appliance version comparison.'}
            rows={versionDrift.rows || []} emptyLabel="No version data collected yet."
            searchKeys={['sourceName', 'name', 'version']}
            filters={[{ k: 'kind', label: 'Kinds' }]}
            rowKey={(r, i) => `${r.sourceName}|${r.name}|${i}`}
            columns={[
              { k: 'sourceName', label: 'Source' },
              { k: 'name', label: 'Name' },
              { k: 'kind', label: 'Kind' },
              {
                k: 'version', label: 'Version',
                render: (r) => <span className={r.isOutlier ? 'text-status-warn font-semibold' : 'text-ink'}>{r.version || '—'}</span>,
              },
              {
                k: 'isOutlier', label: 'Status', align: 'right',
                render: (r) => <Badge tone={r.isOutlier ? 'warn' : 'ok'}>{r.isOutlier ? 'Outlier' : 'Matches'}</Badge>,
              },
            ]} />
        </>
      )}
    </div>
  );
}
