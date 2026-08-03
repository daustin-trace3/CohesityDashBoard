import {
  injectStyles, StatCard, Panel, Badge, EmptyState, SkeletonTable,
  LoadingPanel, timeAgo, fmtBytes, fmtPct, CsvExportButton,
  DbIcon, ServerIcon, BellIcon, ShieldIcon, ChartIcon, ActivityIcon, LayersIcon, XIcon,
} from '../ui.jsx';
import { Donut, LineChart, HBar, SparkLine } from '../charts.jsx';

injectStyles();

function useRubrikFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  return { data, error, loading };
}

function pickUnit(maxBytes) {
  if (maxBytes >= 1e15) return { div: 1e15, label: 'PB' };
  if (maxBytes >= 1e12) return { div: 1e12, label: 'TB' };
  if (maxBytes >= 1e9) return { div: 1e9, label: 'GB' };
  return { div: 1e6, label: 'MB' };
}

function usagePctColor(pct) {
  return pct >= 86 ? '#F87171' : pct >= 70 ? '#FBBF24' : '#00B388';
}

function ClusterHealthCard({ card, index }) {
  const pct = card.usedPct ?? 0;
  const color = usagePctColor(pct);
  const pulsing = pct >= 90;
  return (
    <div
      style={{
        '--rbk-i': index,
        border: `1px solid ${pulsing ? '#F87171' : 'var(--rbk-border)'}`,
        borderRadius: 12,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: 'var(--rbk-surface)',
      }}
      className={pulsing ? 'rbk-pulse-crit' : undefined}
    >
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--rbk-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.cluster}</p>
      <div className="rbk-tnum" style={{ fontSize: 24, fontWeight: 700, color, lineHeight: 1 }}>{fmtPct(pct, 1)}</div>
      <div style={{ height: 6, background: 'var(--rbk-surface-base)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: color, transition: 'width 500ms' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', fontSize: 11 }}>
        <div>
          <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Used</p>
          <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{fmtBytes(card.usedBytes)}</p>
        </div>
        <div>
          <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Capacity</p>
          <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{fmtBytes(card.capacityBytes)}</p>
        </div>
        <div>
          <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Available</p>
          <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{fmtBytes(card.availableBytes)}</p>
        </div>
        <div>
          <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Savings</p>
          <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{card.savingsX != null ? `${card.savingsX.toFixed(2)}x` : '—'}</p>
        </div>
      </div>
      {card.spark && card.spark.length >= 2 && (
        <div style={{ opacity: 0.6 }}>
          <SparkLine points={card.spark} color={color} width={100} height={24} />
        </div>
      )}
    </div>
  );
}

function AlertDetailModal({ alert, onClose }) {
  if (!alert) return null;
  const severity = alert.severity || 'info';
  const tone = severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'info';
  const fmtTime = (ts) => {
    if (!ts) return '—';
    try { return new Date(ts.replace(' ', 'T') + (ts.includes('T') ? '' : 'Z')).toLocaleString(); } catch { return ts; }
  };
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(4px)' }} />
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className="rbk-panel"
        style={{ position: 'relative', width: 'min(520px,90vw)', padding: 20, boxShadow: '0 24px 64px rgba(0,0,0,.6)' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--rbk-ink)' }}>{alert.alertType || 'Alert'}</p>
            <Badge tone={tone} style={{ marginTop: 6, textTransform: 'uppercase' }}>{severity}</Badge>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--rbk-ink-faint)', cursor: 'pointer' }}>
            <XIcon size={18} />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Cluster</span><span style={{ color: 'var(--rbk-ink)' }}>{alert.cluster || '—'}</span></div>
          <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Triggered</span><span className="rbk-tnum" style={{ color: 'var(--rbk-ink)' }}>{fmtTime(alert.firstSeen)}</span></div>
          {alert.objectName && <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Object</span><span style={{ color: 'var(--rbk-ink)' }}>{alert.objectName}</span></div>}
          {alert.description && <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Message</span><span style={{ color: 'var(--rbk-ink)' }}>{alert.description}</span></div>}
        </div>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const { data, loading } = useRubrikFetch('/overview');
  const { data: clustersData } = useRubrikFetch('/clusters');
  const [trendDays, setTrendDays] = React.useState(7);
  const [selectedAlert, setSelectedAlert] = React.useState(null);

  const kpis = data?.kpis || {};
  const storage = data?.storage || {};
  const clusterCards = data?.clusterCards || [];
  const recentCriticalAlerts = data?.recentCriticalAlerts || [];
  const capacityTrend = data?.capacityTrend || [];

  const trendByCluster = React.useMemo(() => {
    if (!capacityTrend.length) return { series: [], refLines: [], unit: { div: 1e12, label: 'TB' }, clusterCount: 0 };
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - trendDays * 86400000).toISOString().slice(0, 10);
    const byCluster = {};
    for (const row of capacityTrend) {
      if (!byCluster[row.cluster]) byCluster[row.cluster] = [];
      byCluster[row.cluster].push(row);
    }
    const maxBytes = Math.max(1, ...capacityTrend.map((r) => r.usedBytes || 0), ...capacityTrend.map((r) => r.capacityBytes || 0));
    const unit = pickUnit(maxBytes);
    const colors = ['#00B388', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#f97316', '#ec4899', '#fbbf24'];
    const series = [];
    const refLines = [];
    Object.entries(byCluster).forEach(([cluster, rows], i) => {
      const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
      const visible = sorted.filter((r) => r.day >= cutoff || r.day > today);
      const historyPts = visible.filter((r) => r.day <= today).map((r) => ({ x: r.day, y: r.usedBytes / unit.div }));
      const forecastPts = visible.filter((r) => r.day > today).map((r) => ({ x: r.day, y: r.usedBytes / unit.div }));
      const color = colors[i % colors.length];
      if (historyPts.length) series.push({ label: cluster, color, points: historyPts });
      if (forecastPts.length) {
        const bridge = historyPts.length ? [historyPts[historyPts.length - 1]] : [];
        series.push({ label: `${cluster} (forecast)`, color, dashed: true, points: [...bridge, ...forecastPts] });
      }
      const cap = sorted[sorted.length - 1]?.capacityBytes;
      if (cap) refLines.push({ y: cap / unit.div, color: color + '66', dash: '2 4' });
    });
    return { series, refLines, unit, clusterCount: Object.keys(byCluster).length };
  }, [capacityTrend, trendDays]);

  const totalUsed = storage.used ?? kpis.usedBytes ?? 0;
  const totalFree = storage.free ?? kpis.freeBytes ?? 0;
  const usedPct = kpis.usedPct ?? (totalUsed + totalFree > 0 ? (totalUsed / (totalUsed + totalFree)) * 100 : 0);

  const topClusters = [...clusterCards].sort((a, b) => (b.usedPct || 0) - (a.usedPct || 0)).slice(0, 10);

  const clusterStatusRows = (clustersData || []).slice().sort((a, b) => {
    const aOk = a.status === 'Connected' ? 0 : 1;
    const bOk = b.status === 'Connected' ? 0 : 1;
    return aOk - bOk;
  });

  const csvColumns = [
    { label: 'Day', get: 'day' }, { label: 'Cluster', get: 'cluster' },
    { label: 'UsedBytes', get: 'usedBytes' }, { label: 'CapacityBytes', get: 'capacityBytes' },
  ];

  return (
    <div className="rbk-root rbk-fade-in">
      {selectedAlert && <AlertDetailModal alert={selectedAlert} onClose={() => setSelectedAlert(null)} />}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }}
        className="rbk-kpi-grid">
        <style>{`
          @media (min-width: 768px) { .rbk-kpi-grid { grid-template-columns: repeat(3,1fr) !important; } }
          @media (min-width: 1280px) { .rbk-kpi-grid { grid-template-columns: repeat(5,1fr) !important; } }
        `}</style>
        <StatCard icon={DbIcon} label="Total Capacity" value={fmtBytes(kpis.totalCapacityBytes)} sub={`${fmtBytes(kpis.freeBytes)} free`} tone="brand" loading={loading} />
        <StatCard icon={LayersIcon} label="Storage Used" value={fmtPct(usedPct, 1)} sub={fmtBytes(kpis.usedBytes)} tone={usedPct >= 86 ? 'crit' : usedPct >= 70 ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={ServerIcon} label="Clusters Online" value={`${kpis.clustersOnline ?? 0} / ${kpis.clustersTotal ?? 0}`} sub={kpis.clustersOnline === kpis.clustersTotal ? 'All reachable' : `${(kpis.clustersTotal ?? 0) - (kpis.clustersOnline ?? 0)} need attention`} tone={kpis.clustersOnline === kpis.clustersTotal ? 'ok' : 'warn'} loading={loading} />
        <StatCard icon={BellIcon} label="Active Alerts" value={kpis.activeAlerts ?? '—'} sub={(kpis.criticalAlerts ?? 0) > 0 ? `${kpis.criticalAlerts} critical` : 'No criticals'} tone={(kpis.criticalAlerts ?? 0) > 0 ? 'crit' : (kpis.activeAlerts ?? 0) > 0 ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={ShieldIcon} label="Backup Success (7d)" value={kpis.successRate7d != null ? fmtPct(kpis.successRate7d, 0) : '—'} sub={kpis.failed7d != null ? `${kpis.failed7d} failed` : ''} tone={kpis.successRate7d == null ? 'default' : kpis.successRate7d >= 95 ? 'ok' : kpis.successRate7d >= 85 ? 'warn' : 'crit'} loading={loading} />
      </div>

      {/* Two-column main content */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="rbk-main-grid">
        <style>{`@media (min-width: 1280px) { .rbk-main-grid { grid-template-columns: 2fr 3fr !important; } }`}</style>
        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel title="Global Storage Utilization" icon={LayersIcon}>
            {loading ? <LoadingPanel height={110} /> : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <Donut pct={usedPct} size={110} thresholds={{ crit: 86, warn: 70 }} centerLabel={`${Math.round(usedPct)}%`} centerSub="used" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  <div>
                    <p className="rbk-tnum" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--rbk-ink)' }}>{fmtBytes(totalUsed)} <span style={{ color: 'var(--rbk-ink-faint)', fontWeight: 400 }}>of</span> {fmtBytes(totalUsed + totalFree)}</p>
                    <p style={{ margin: 0, fontSize: 11, color: 'var(--rbk-ink-muted)' }}>{fmtBytes(totalFree)} available</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Badge tone="brand">{typeof storage.dataReduction === 'number' ? storage.dataReduction.toFixed(1) : (storage.dataReduction ?? '—')}x data reduction</Badge>
                    <Badge tone="neutral">{storage.reporting ?? clusterCards.length} reporting</Badge>
                  </div>
                </div>
              </div>
            )}
          </Panel>

          <Panel
            title="Capacity Growth Trend"
            icon={ChartIcon}
            actions={
              <div style={{ display: 'flex', gap: 4 }}>
                <CsvExportButton filename="rubrik-capacity-trend" columns={csvColumns} rows={capacityTrend} />
                {[7, 14, 30].map((d) => (
                  <button key={d} onClick={() => setTrendDays(d)} className={`rbk-pill${trendDays === d ? ' rbk-pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }}>{d}d</button>
                ))}
              </div>
            }
          >
            {loading ? <LoadingPanel height={220} /> : trendByCluster.series.length === 0 ? (
              <EmptyState title="No trend data" description="Capacity history has not been collected yet." />
            ) : (
              <>
                <p style={{ fontSize: 10, color: 'var(--rbk-ink-faint)', margin: '0 0 6px' }}>{trendByCluster.clusterCount} cluster(s)</p>
                <LineChart
                  series={trendByCluster.series.map((s) => ({ ...s, points: s.points.map((p, i) => ({ x: i, y: p.y })) }))}
                  refLines={trendByCluster.refLines}
                  width={560}
                  height={220}
                  yUnit={(v) => `${v.toFixed(0)} ${trendByCluster.unit.label}`}
                />
              </>
            )}
          </Panel>
        </div>

        {/* RIGHT */}
        <Panel title="Cluster Health & Alerts" icon={ActivityIcon} actions={<span style={{ fontSize: 10, color: 'var(--rbk-ink-faint)' }}>{clusterCards.length} clusters</span>}>
          {loading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="rbk-skeleton" style={{ height: 140, borderRadius: 12 }} />)}
            </div>
          ) : clusterCards.length === 0 ? (
            <EmptyState icon={ServerIcon} title="No clusters" description="No Rubrik clusters are configured." />
          ) : (
            <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
              {clusterCards.map((c, i) => <ClusterHealthCard key={c.cluster} card={c} index={i} />)}
            </div>
          )}
        </Panel>
      </div>

      {/* Bottom 4-panel grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="rbk-bottom-grid">
        <style>{`
          @media (min-width: 1024px) { .rbk-bottom-grid { grid-template-columns: repeat(2,1fr) !important; } }
          @media (min-width: 1280px) { .rbk-bottom-grid { grid-template-columns: repeat(4,1fr) !important; } }
        `}</style>

        <Panel title="Cluster Status" icon={ServerIcon}>
          <div className="rbk-scroll" style={{ maxHeight: 256, overflowY: 'auto' }}>
            {loading ? <SkeletonTable rows={5} colWidths={['20%', '55%', '25%']} /> : clusterStatusRows.length === 0 ? (
              <EmptyState title="No clusters" />
            ) : (
              <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                <tbody>
                  {clusterStatusRows.map((c) => {
                    const online = c.status === 'Connected';
                    return (
                      <tr key={c.id} className="rbk-row" style={{ borderTop: '1px solid var(--rbk-border)' }}>
                        <td style={{ padding: '6px 6px', width: 20 }}>
                          <span className={online ? 'rbk-orb' : undefined} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: online ? 'var(--rbk-ok)' : 'var(--rbk-crit)', boxShadow: `0 0 4px ${online ? '#34D39999' : '#F8717199'}` }} />
                        </td>
                        <td style={{ padding: '6px 6px', color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }}>{c.name}</td>
                        <td style={{ padding: '6px 6px', textAlign: 'right' }}>{c.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <Panel title="Top Clusters by Capacity" icon={ChartIcon}>
          {loading ? <LoadingPanel height={220} /> : topClusters.length === 0 ? <EmptyState title="No data" /> : (
            <HBar rows={topClusters.map((c) => ({ label: c.cluster, value: Math.round(c.usedPct || 0), color: usagePctColor(c.usedPct || 0) }))} max={100} unit="%" width={300} />
          )}
        </Panel>

        <Panel title="Storage Distribution" icon={DbIcon}>
          <div className="rbk-scroll" style={{ maxHeight: 256, overflowY: 'auto' }}>
            {loading ? <SkeletonTable rows={5} /> : clusterCards.length === 0 ? <EmptyState title="No data" /> : (
              <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--rbk-ink-faint)' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Cluster</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>Used</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>Total</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>% Used</th>
                  </tr>
                </thead>
                <tbody>
                  {[...clusterCards].sort((a, b) => (b.usedPct || 0) - (a.usedPct || 0)).slice(0, 10).map((c) => (
                    <tr key={c.cluster} className="rbk-row" style={{ borderTop: '1px solid var(--rbk-border)' }}>
                      <td style={{ padding: '6px 6px', color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>{c.cluster}</td>
                      <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 6px' }}>{fmtBytes(c.usedBytes)}</td>
                      <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 6px' }}>{fmtBytes(c.capacityBytes)}</td>
                      <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600, color: usagePctColor(c.usedPct || 0) }}>{fmtPct(c.usedPct, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <Panel title="Recent Critical Alerts" icon={BellIcon}>
          <div className="rbk-scroll" style={{ maxHeight: 256, overflowY: 'auto' }}>
            {loading ? <SkeletonTable rows={4} /> : recentCriticalAlerts.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '24px 0', color: 'var(--rbk-ok)', fontSize: 12 }}>
                <ShieldIcon size={14} /> No active critical alerts
              </div>
            ) : (
              <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--rbk-ink-faint)' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Time</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Cluster</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Issue</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCriticalAlerts.map((a) => (
                    <tr key={a.id} onClick={() => setSelectedAlert(a)} className="rbk-row" style={{ borderTop: '1px solid var(--rbk-border)', cursor: 'pointer' }}>
                      <td className="rbk-tnum" style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>{timeAgo(a.firstSeen)}</td>
                      <td style={{ padding: '6px 6px', color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 80 }}>{a.cluster}</td>
                      <td style={{ padding: '6px 6px', color: 'var(--rbk-warn)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>{a.alertType || a.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
