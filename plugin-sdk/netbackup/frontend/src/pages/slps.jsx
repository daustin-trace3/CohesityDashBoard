// NetBackup SLP / Replication — ports host frontend/src/pages/netbackup/NbSlpPage.jsx.
import {
  injectStyles, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  WorkflowIcon, ArrowLeftRightIcon,
} from '../ui.jsx';
import { BRAND, fmtNum, fmtWhen, apiGet } from './helpers.js';

injectStyles();

export default function NbSlpPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiGet('/slps')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => setData({ slps: [], replication: { jobs24h: 0, failed24h: 0, jobs7d: 0, failed7d: 0, byPolicy: [] } })), []);

  React.useEffect(() => { load(); }, [load]);

  const slps = data?.slps || [];
  const replication = data?.replication || { jobs24h: 0, failed24h: 0, jobs7d: 0, failed7d: 0, byPolicy: [] };

  const slpCtl = useTableControls(slps, { searchKeys: ['name', 'sourceName', 'dataClassification'], defaultSortKey: 'name', defaultSortDir: 'asc', paginate: true });
  const policyCtl = useTableControls(replication.byPolicy || [], { searchKeys: ['policyName', 'sourceName'], defaultSortKey: 'total7d', defaultSortDir: 'desc', paginate: true });

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={WorkflowIcon} title="SLP / Replication" description="Storage Lifecycle Policies and replication/duplication job outcomes">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={data == null} />
      </PageHeader>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }} className="nb-stat-grid">
        <style>{`@media (min-width: 900px) { .nb-stat-grid { grid-template-columns: repeat(4,1fr) !important; } }`}</style>
        <StatCard icon={ArrowLeftRightIcon} label="Replication Jobs (24h)" value={fmtNum(replication.jobs24h)} />
        <StatCard icon={ArrowLeftRightIcon} label="Failed (24h)" value={fmtNum(replication.failed24h)} tone={replication.failed24h ? 'crit' : 'ok'} />
        <StatCard icon={ArrowLeftRightIcon} label="Replication Jobs (7d)" value={fmtNum(replication.jobs7d)} />
        <StatCard icon={ArrowLeftRightIcon} label="Failed (7d)" value={fmtNum(replication.failed7d)} tone={replication.failed7d ? 'warn' : 'ok'} />
      </div>

      <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Storage Lifecycle Policies</p>
        {data == null ? (
          <LoadingPanel label="Loading SLPs…" height={140} />
        ) : slps.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No SLPs found — the source may not expose an SLP API, or none are configured.</div>
        ) : (
          <>
            <TableControls ctl={slpCtl} rows={slps} searchPlaceholder="Filter by name, source or classification…"
              filters={[{ k: 'sourceName', label: 'Sources' }, { k: 'dataClassification', label: 'Classifications' }]} />
            {slpCtl.rows.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No SLPs match your filters.</div>
            ) : (
              <div className="nb-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <SortTh k="name" label="Name" ctl={slpCtl} />
                    <SortTh k="sourceName" label="Source" ctl={slpCtl} />
                    <SortTh k="dataClassification" label="Classification" ctl={slpCtl} />
                    <SortTh k="priority" label="Priority" ctl={slpCtl} align="right" />
                    <SortTh k="operationCount" label="Operations" ctl={slpCtl} align="right" />
                  </tr></thead>
                  <tbody>
                    {slpCtl.pageRows.map((s) => (
                      <tr key={s.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)', fontWeight: 500 }}>{s.name}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{s.sourceName}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{s.dataClassification || '—'}</td>
                        <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{s.priority ?? '—'}</td>
                        <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)', cursor: 'default' }}
                          title={(s.operations || []).length ? JSON.stringify(s.operations, null, 2) : 'No operations'}>{fmtNum(s.operationCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={slpCtl} />
          </>
        )}
      </div>

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArrowLeftRightIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Replication by Policy
        </p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : (replication.byPolicy || []).length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No replication/duplication jobs in the last 7 days.</div>
        ) : (
          <>
            <TableControls ctl={policyCtl} rows={replication.byPolicy} searchPlaceholder="Filter by policy or source…" filters={[{ k: 'sourceName', label: 'Sources' }]} />
            {policyCtl.rows.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No rows match your filters.</div>
            ) : (
              <div className="nb-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <SortTh k="policyName" label="Policy" ctl={policyCtl} />
                    <SortTh k="sourceName" label="Source" ctl={policyCtl} />
                    <SortTh k="total7d" label="Jobs (7d)" ctl={policyCtl} align="right" />
                    <SortTh k="failed7d" label="Failed (7d)" ctl={policyCtl} align="right" />
                    <SortTh k="lastStatus" label="Last Status" ctl={policyCtl} />
                    <SortTh k="lastRunAt" label="Last Run" ctl={policyCtl} align="right" />
                  </tr></thead>
                  <tbody>
                    {policyCtl.pageRows.map((p, i) => (
                      <tr key={`${p.sourceId}|${p.policyName}|${i}`} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)', fontWeight: 500 }}>{p.policyName || '—'}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{p.sourceName}</td>
                        <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink)' }}>{fmtNum(p.total7d)}</td>
                        <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(p.failed7d)}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={p.failed7d ? 'crit' : 'ok'}>{p.lastStatus || '—'}</Badge></td>
                        <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-faint)', fontSize: 11 }}>{fmtWhen(p.lastRunAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={policyCtl} />
          </>
        )}
      </div>
    </div>
  );
}
