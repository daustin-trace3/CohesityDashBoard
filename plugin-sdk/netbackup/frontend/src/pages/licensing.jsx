// NetBackup Licensing — ports host frontend/src/pages/netbackup/NbLicensingPage.jsx.
import {
  injectStyles, PageHeader, StatCard, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BoxesIcon, CloudIcon, UsersIcon, GlobeIcon,
} from '../ui.jsx';
import { Donut } from '../charts.jsx';
import { TB, fmtTb, fmtNum, fmtWhen, apiGet } from './helpers.js';

injectStyles();

function MeterCard({ title, icon: Icon, pct, consumedTb, entitledTb, sub, empty }) {
  const gaugeColor = pct == null ? undefined : pct >= 90 ? '#EF4444' : pct >= 75 ? '#F59E0B' : '#6CB33F';
  return (
    <div className="nb-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(177,24,30,0.1)', border: '1px solid rgba(177,24,30,0.2)', flexShrink: 0 }}>
          <Icon size={18} style={{ color: 'var(--nb-brand)' }} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--nb-ink)', margin: 0 }}>{title}</p>
          {sub && <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', margin: '2px 0 0', lineHeight: 1.4 }}>{sub}</p>}
        </div>
      </div>
      {empty ? (
        <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: 'var(--nb-ink-muted)' }}>{empty}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
          {pct != null ? (
            <Donut pct={pct} size={96} stroke={10} colorOverride={gaugeColor} centerSub={pct > 100 ? 'Over' : 'Used'} />
          ) : (
            <div style={{ height: 96, width: 96, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: '50%', border: '1px dashed var(--nb-border)', textAlign: 'center', padding: 12 }}>
              <span style={{ fontSize: 10, color: 'var(--nb-ink-muted)', lineHeight: 1.3 }}>No entitlement set</span>
            </div>
          )}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, minWidth: 160 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--nb-ink-muted)', fontSize: 12 }}>Consumed</span>
              <span className="nb-tnum" style={{ color: 'var(--nb-ink)', fontWeight: 600 }}>{fmtTb(consumedTb * TB)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--nb-ink-muted)', fontSize: 12 }}>Entitled</span>
              <span className="nb-tnum" style={{ color: 'var(--nb-ink)', fontWeight: 600 }}>{entitledTb > 0 ? `${entitledTb.toLocaleString()} TB` : '— not set'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function NbLicensingPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiGet('/licensing')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => setData({ totals: {}, byWorkload: [], byDomain: [], entitledTb: 0, upstream: null })), []);

  React.useEffect(() => { load(); }, [load]);

  const totals = data?.totals || {};
  const byWorkload = data?.byWorkload || [];
  const byDomain = data?.byDomain || [];
  const entitledTb = data?.entitledTb || 0;
  const consumedTb = (totals.frontEndBytes || 0) / TB;
  const computedPct = entitledTb > 0 ? (consumedTb / entitledTb) * 100 : null;

  const upstream = data?.upstream || null;
  const upstreamPct = upstream && upstream.entitledTb > 0 ? (upstream.reportedTb / upstream.entitledTb) * 100 : null;

  const showDelta = upstream != null && entitledTb > 0;
  const delta = showDelta ? consumedTb - upstream.reportedTb : null;

  const domainCtl = useTableControls(byDomain, { searchKeys: ['sourceName', 'sourceType'], defaultSortKey: 'frontEndBytes', defaultSortDir: 'desc', paginate: true });

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={BoxesIcon} title="Licensing" description="Veritas's own licensing meter alongside ICC's computed FETB estimate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={data == null} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading licensing data…" height={280} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="nb-two-col">
            <style>{`@media (min-width: 768px) { .nb-two-col { grid-template-columns: 1fr 1fr !important; } }`}</style>
            <MeterCard title="Veritas Licensing Meter" icon={CloudIcon} pct={upstreamPct} consumedTb={upstream?.reportedTb || 0} entitledTb={upstream?.entitledTb || 0}
              sub={upstream ? `${upstream.meter || 'Alta meter'}${upstream.asOf ? ` · as of ${fmtWhen(upstream.asOf)}` : ''}` : 'From Veritas Alta'}
              empty={!upstream ? 'Awaiting live Alta connection — Veritas’s own meter will appear here.' : null} />
            <MeterCard title="ICC Computed (FETB)" icon={BoxesIcon} pct={computedPct} consumedTb={consumedTb} entitledTb={entitledTb} sub="Largest successful job per client, last 30 days" />
          </div>

          {showDelta && (
            <div className="nb-panel" style={{ padding: 12, fontSize: 13, color: 'var(--nb-ink-muted)' }}>
              ICC computes <span className="nb-tnum" style={{ color: 'var(--nb-ink)', fontWeight: 600 }}>{fmtTb(consumedTb * TB)}</span> vs Veritas{' '}
              <span className="nb-tnum" style={{ color: 'var(--nb-ink)', fontWeight: 600 }}>{fmtTb((upstream.reportedTb || 0) * TB)}</span> · Δ{' '}
              <span className="nb-tnum" style={{ fontWeight: 600, color: Math.abs(delta) > (upstream.reportedTb || 0) * 0.1 ? 'var(--nb-warn)' : 'var(--nb-ink)' }}>
                {delta >= 0 ? '+' : ''}{fmtTb(delta * TB)}
              </span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }} className="nb-stat-grid">
            <style>{`@media (min-width: 900px) { .nb-stat-grid { grid-template-columns: repeat(4,1fr) !important; } }`}</style>
            <StatCard icon={BoxesIcon} label="Consumed (FETB)" value={fmtTb(totals.frontEndBytes)} />
            <StatCard icon={BoxesIcon} label="Entitled" value={entitledTb > 0 ? `${entitledTb.toLocaleString()} TB` : '—'} />
            <StatCard icon={UsersIcon} label="Clients" value={fmtNum(totals.clients)} />
            <StatCard icon={GlobeIcon} label="Domains" value={fmtNum(totals.sources)} />
          </div>

          <Panel title="Consumption by Workload">
            {byWorkload.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '16px 0', textAlign: 'center' }}>No workload breakdown yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }} className="nb-wl-stat-grid">
                <style>{`@media (min-width: 700px) { .nb-wl-stat-grid { grid-template-columns: repeat(3,1fr) !important; } } @media (min-width: 1200px) { .nb-wl-stat-grid { grid-template-columns: repeat(5,1fr) !important; } }`}</style>
                {byWorkload.map((w) => (
                  <StatCard key={w.workload} icon={BoxesIcon} label={w.workload} value={fmtTb(w.frontEndBytes)} sub={`${fmtNum(w.clients)} clients`} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Consumption by Domain">
            {byDomain.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No per-domain data yet.</div>
            ) : (
              <>
                <TableControls ctl={domainCtl} rows={byDomain} searchPlaceholder="Filter by domain…" filters={[{ k: 'sourceType', label: 'Types' }]} />
                <div className="nb-scroll" style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                      <SortTh k="sourceName" label="Domain" ctl={domainCtl} />
                      <SortTh k="sourceType" label="Type" ctl={domainCtl} />
                      <SortTh k="clients" label="Clients" ctl={domainCtl} align="right" />
                      <SortTh k="frontEndBytes" label="FETB" ctl={domainCtl} align="right" />
                      <SortTh k="usagePercent" label="% of Entitlement" ctl={domainCtl} align="right" />
                    </tr></thead>
                    <tbody>
                      {domainCtl.pageRows.map((d) => {
                        const tone = d.usagePercent == null ? 'neutral' : d.usagePercent >= 90 ? 'crit' : d.usagePercent >= 75 ? 'warn' : 'ok';
                        return (
                          <tr key={d.sourceId} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                            <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>{d.sourceName}</td>
                            <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{d.sourceType}</td>
                            <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink)' }}>{fmtNum(d.clients)}</td>
                            <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink)' }}>{fmtTb(d.frontEndBytes)}</td>
                            <td style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}><Badge tone={tone}>{d.usagePercent != null ? `${d.usagePercent.toFixed(1)}%` : '—'}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <TablePager ctl={domainCtl} />
              </>
            )}
          </Panel>

          {data.capturedAt && <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)' }}>Captured {fmtWhen(data.capturedAt)} · basis: computed-fetb</p>}
        </div>
      )}
    </div>
  );
}
