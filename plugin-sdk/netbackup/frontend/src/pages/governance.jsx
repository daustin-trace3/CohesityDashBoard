// NetBackup Governance — ports host frontend/src/pages/netbackup/NbGovernancePage.jsx.
import {
  injectStyles, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  ClipboardCheckIcon, ShieldOffIcon, ClockIcon, UsersIcon, ArchiveIcon, GitCompareArrowsIcon,
} from '../ui.jsx';
import { BRAND, fmtNum, fmtWhen, apiGet } from './helpers.js';

injectStyles();

function Section({ innerRef, icon: Icon, title, blurb, rows, columns, emptyLabel, searchKeys, filters, rowKey }) {
  const ctl = useTableControls(rows, { searchKeys, defaultSortKey: columns[0]?.k, defaultSortDir: 'asc', paginate: true, defaultPageSize: 10 });
  return (
    <div ref={innerRef} className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={15} style={{ color: 'var(--nb-brand)' }} /> {title}
      </p>
      {blurb && <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginBottom: 12 }}>{blurb}</p>}
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--nb-ok)', padding: '24px 0', textAlign: 'center' }}>{emptyLabel}</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter…" filters={filters || []} />
          {ctl.rows.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No rows match your filters.</div>
          ) : (
            <div className="nb-scroll" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                  {columns.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r, i) => (
                    <tr key={rowKey(r, i)} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                      {columns.map((c) => (
                        <td key={c.k} className={c.align === 'right' ? 'nb-tnum' : undefined} style={{ padding: '8px 12px 8px 0', textAlign: c.align || 'left', color: c.color || 'var(--nb-ink-muted)' }}>
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
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const inactiveRef = React.useRef(null);
  const idleRef = React.useRef(null);
  const unprotectedRef = React.useRef(null);
  const driftRef = React.useRef(null);

  const load = React.useCallback(() => apiGet('/governance')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => setData({ inactivePolicies: [], idlePolicies: [], unprotectedClients: [], catalogBackup: null, versionDrift: { dominant: null, rows: [] }, summary: {} })), []);

  React.useEffect(() => { load(); }, [load]);

  const inactivePolicies = data?.inactivePolicies || [];
  const idlePolicies = data?.idlePolicies || [];
  const unprotectedClients = data?.unprotectedClients || [];
  const catalogBackup = data?.catalogBackup || null;
  const versionDrift = data?.versionDrift || { dominant: null, rows: [] };
  const summary = data?.summary || {};

  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={ClipboardCheckIcon} title="Governance" description="Inactive/idle policies, unprotected clients, catalog backup health, and version drift">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={data == null} />
      </PageHeader>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }} className="nb-stat-grid">
        <style>{`@media (min-width: 900px) { .nb-stat-grid { grid-template-columns: repeat(5,1fr) !important; } }`}</style>
        <StatCard icon={ShieldOffIcon} label="Inactive Policies" value={fmtNum(summary.inactiveCount)} tone={summary.inactiveCount ? 'warn' : 'ok'} onClick={() => scrollTo(inactiveRef)} />
        <StatCard icon={ClockIcon} label="Idle Policies" value={fmtNum(summary.idleCount)} tone={summary.idleCount ? 'warn' : 'ok'} onClick={() => scrollTo(idleRef)} />
        <StatCard icon={UsersIcon} label="Unprotected Clients" value={fmtNum(summary.unprotectedCount)} tone={summary.unprotectedCount ? 'crit' : 'ok'} onClick={() => scrollTo(unprotectedRef)} />
        <StatCard icon={ArchiveIcon} label="Catalog Backup" value={summary.catalogOk == null ? '—' : summary.catalogOk ? 'OK' : 'Stale'} tone={summary.catalogOk == null ? 'default' : summary.catalogOk ? 'ok' : 'crit'} />
        <StatCard icon={GitCompareArrowsIcon} label="Version Outliers" value={fmtNum(summary.outlierCount)} tone={summary.outlierCount ? 'warn' : 'ok'} onClick={() => scrollTo(driftRef)} />
      </div>

      {data == null ? (
        <LoadingPanel label="Loading governance data…" height={200} />
      ) : (
        <>
          <Section innerRef={inactiveRef} icon={ShieldOffIcon} title="Inactive Policies"
            blurb="Policies marked inactive but still configured — verify they should stay disabled."
            rows={inactivePolicies} emptyLabel="No inactive policies."
            searchKeys={['name', 'sourceName', 'policyType']}
            filters={[{ k: 'sourceName', label: 'Sources' }, { k: 'policyType', label: 'Policy Types' }]}
            rowKey={(r, i) => `${r.sourceId}|${r.name}|${i}`}
            columns={[{ k: 'name', label: 'Policy' }, { k: 'sourceName', label: 'Source' }, { k: 'policyType', label: 'Type' }]} />

          <Section innerRef={idleRef} icon={ClockIcon} title="Idle Policies"
            blurb="Active policies with no successful run in the last 7 days."
            rows={idlePolicies} emptyLabel="No idle policies."
            searchKeys={['name', 'sourceName', 'policyType']}
            filters={[{ k: 'sourceName', label: 'Sources' }, { k: 'policyType', label: 'Policy Types' }]}
            rowKey={(r, i) => `${r.sourceId}|${r.name}|${i}`}
            columns={[
              { k: 'name', label: 'Policy' }, { k: 'sourceName', label: 'Source' }, { k: 'policyType', label: 'Type' },
              { k: 'lastRunAt', label: 'Last Run', align: 'right', render: (r) => fmtWhen(r.lastRunAt) },
            ]} />

          <Section innerRef={unprotectedRef} icon={UsersIcon} title="Unprotected Clients"
            blurb="Clients seen in job history whose last successful backup exceeds the stale-backup threshold."
            rows={unprotectedClients} emptyLabel="No unprotected clients."
            searchKeys={['sourceName', 'clientName']}
            filters={[{ k: 'sourceName', label: 'Sources' }]}
            rowKey={(r, i) => `${r.sourceName}|${r.clientName}|${i}`}
            columns={[
              {
                k: 'clientName', label: 'Client',
                render: (r) => r.clientName
                  ? <ReactRouterDOM.Link to={`/ops/server360?name=${encodeURIComponent(r.clientName)}`} style={{ color: 'var(--nb-ink)', fontWeight: 500, textDecoration: 'none' }}>{r.clientName}</ReactRouterDOM.Link>
                  : '—',
              },
              { k: 'sourceName', label: 'Source' },
              { k: 'lastSuccessAt', label: 'Last Success', align: 'right', render: (r) => fmtWhen(r.lastSuccessAt) },
            ]} />

          <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <ArchiveIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Catalog Backup
            </p>
            {!catalogBackup ? (
              <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No NBU-Catalog policy found.</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <Badge tone={catalogBackup.ok ? 'ok' : 'crit'}>{catalogBackup.ok ? 'Healthy' : 'Stale'}</Badge>
                <span style={{ fontSize: 13, color: 'var(--nb-ink)' }}>{catalogBackup.policyName}</span>
                <span className="nb-tnum" style={{ fontSize: 12, color: 'var(--nb-ink-muted)', marginLeft: 'auto' }}>
                  Last success {fmtWhen(catalogBackup.lastSuccessAt)} · {catalogBackup.ageHours != null ? `${Math.round(catalogBackup.ageHours)}h ago` : '—'}
                </span>
              </div>
            )}
          </div>

          <Section innerRef={driftRef} icon={GitCompareArrowsIcon} title="Version Drift"
            blurb={versionDrift.dominant ? `Dominant version: ${versionDrift.dominant}. Rows off the majority are highlighted.` : 'Media server and appliance version comparison.'}
            rows={versionDrift.rows || []} emptyLabel="No version data collected yet."
            searchKeys={['sourceName', 'name', 'version']}
            filters={[{ k: 'kind', label: 'Kinds' }]}
            rowKey={(r, i) => `${r.sourceName}|${r.name}|${i}`}
            columns={[
              { k: 'sourceName', label: 'Source' }, { k: 'name', label: 'Name' }, { k: 'kind', label: 'Kind' },
              { k: 'version', label: 'Version', render: (r) => <span style={{ color: r.isOutlier ? 'var(--nb-warn)' : 'var(--nb-ink)', fontWeight: r.isOutlier ? 600 : 400 }}>{r.version || '—'}</span> },
              { k: 'isOutlier', label: 'Status', align: 'right', render: (r) => <Badge tone={r.isOutlier ? 'warn' : 'ok'}>{r.isOutlier ? 'Outlier' : 'Matches'}</Badge> },
            ]} />
        </>
      )}
    </div>
  );
}
