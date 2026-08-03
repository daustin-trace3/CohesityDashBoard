import {
  injectStyles, PageHeader, StatCard, Panel, Badge, LoadingPanel, LastUpdated,
  RefreshButton, fmtBytes, fmtPct, FileIcon, DbIcon, ServerIcon, BellIcon, ShieldIcon, DownloadIcon,
} from '../ui.jsx';

injectStyles();

export default function ReportingPage() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [generatedAt, setGeneratedAt] = React.useState(null);

  const load = React.useCallback(() => {
    setLoading(true);
    fetch('/api/rubrik/report', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => {
        setData(json);
        setGeneratedAt(json.generatedAt ? new Date(json.generatedAt) : new Date());
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const kpis = data?.kpis || {};
  const byCluster = data?.byCluster || [];
  const insights = data?.insights || [];

  const exportCsv = () => {
    const rows = ['Cluster,Connection,Used Bytes,Capacity Bytes,Used %,Data Reduction,Nodes,Version'];
    for (const c of byCluster) {
      rows.push([
        JSON.stringify(c.cluster), c.connection,
        c.usedBytes ?? '', c.capacityBytes ?? '', c.usagePercent ?? '',
        c.dataReduction ?? '', c.nodes ?? '', c.version ?? '',
      ].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rubrik-estate-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rbk-root rbk-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        icon={FileIcon}
        title="Executive Report"
        description={generatedAt ? `Estate summary generated ${generatedAt.toLocaleString()}` : 'Estate-wide summary across capacity, alerts, and data protection'}
      >
        <RefreshButton onClick={load} refreshing={loading} label="Regenerate" />
        <LastUpdated date={generatedAt} prefix="Generated" />
        <button
          onClick={exportCsv}
          disabled={loading || byCluster.length === 0}
          className="rbk-btn-ghost"
        >
          <DownloadIcon size={13} /> Export CSV
        </button>
        <button onClick={() => window.print()} disabled={loading} className="rbk-btn-accent">
          Print / PDF
        </button>
      </PageHeader>

      {loading ? (
        <div className="rbk-panel" style={{ padding: 16 }}><LoadingPanel label="Generating estate report…" height={320} /></div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }} className="rbk-report-kpi-grid">
            <style>{`@media (min-width: 768px) { .rbk-report-kpi-grid { grid-template-columns: repeat(4,1fr) !important; } }`}</style>
            <StatCard icon={DbIcon} label="Total Capacity" value={fmtBytes(kpis.totalCapacityBytes)} sub={`${fmtBytes(kpis.usedBytes)} used`} tone="brand" />
            <StatCard icon={ServerIcon} label="Clusters" value={kpis.clusters ?? '—'} sub={`${kpis.clustersReporting ?? 0} reporting`} tone={kpis.clustersReporting === kpis.clusters ? 'ok' : 'warn'} />
            <StatCard icon={BellIcon} label="Open Alerts" value={kpis.openAlerts ?? '—'} sub={(kpis.openAlerts ?? 0) > 0 ? 'Needs review' : 'No open alerts'} tone={(kpis.openAlerts ?? 0) > 0 ? 'crit' : 'ok'} />
            <StatCard icon={ShieldIcon} label="Backup Success (30d)" value={kpis.successRate30d != null ? fmtPct(kpis.successRate30d, 0) : '—'} tone={kpis.successRate30d == null ? 'default' : kpis.successRate30d >= 95 ? 'ok' : kpis.successRate30d >= 85 ? 'warn' : 'crit'} />
          </div>

          <Panel title="Capacity by Cluster" icon={DbIcon}>
            <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--rbk-ink-faint)', borderBottom: '1px solid var(--rbk-border)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 12px 8px 0', fontWeight: 600 }}>Cluster</th>
                    <th style={{ padding: '8px 12px 8px 0', fontWeight: 600 }}>Connection</th>
                    <th style={{ padding: '8px 12px 8px 0', fontWeight: 600, textAlign: 'right' }}>Used</th>
                    <th style={{ padding: '8px 12px 8px 0', fontWeight: 600, textAlign: 'right' }}>Capacity</th>
                    <th style={{ padding: '8px 12px 8px 0', fontWeight: 600, textAlign: 'right' }}>% Used</th>
                    <th style={{ padding: '8px 12px 8px 0', fontWeight: 600, textAlign: 'right' }}>Data Reduction</th>
                    <th style={{ padding: '8px 12px 8px 0', fontWeight: 600, textAlign: 'right' }}>Nodes</th>
                    <th style={{ padding: '8px 0', fontWeight: 600, textAlign: 'right' }}>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {byCluster.map((c) => {
                    const pct = c.usagePercent;
                    const tone = pct == null ? 'neutral' : pct >= 86 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
                    return (
                      <tr key={c.cluster} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', fontWeight: 500 }}>{c.cluster}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}>{c.connection}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>{fmtBytes(c.usedBytes)}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>{fmtBytes(c.capacityBytes)}</td>
                        <td style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}><Badge tone={tone}>{pct != null ? fmtPct(pct, 1) : 'No data'}</Badge></td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>{c.dataReduction != null ? `${c.dataReduction.toFixed(2)}x` : '—'}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>{c.nodes ?? '—'}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 0', textAlign: 'right' }}>{c.version ?? '—'}</td>
                      </tr>
                    );
                  })}
                  {byCluster.length === 0 && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--rbk-ink-faint)' }}>No clusters configured</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Risk Summary & Recommendations" icon={BellIcon}>
            {insights.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--rbk-ink-faint)', textAlign: 'center', padding: '12px 0' }}>No insights available.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {insights.slice(0, 10).map((ins, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, borderBottom: i < insights.length - 1 ? '1px solid var(--rbk-border)' : 'none', paddingBottom: 8 }}>
                    <Badge tone={ins.severity === 'critical' ? 'crit' : ins.severity === 'warning' ? 'warn' : ins.severity === 'ok' ? 'ok' : 'info'} style={{ marginTop: 2, flexShrink: 0, textTransform: 'capitalize' }}>
                      {ins.severity}
                    </Badge>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--rbk-ink)' }}>{ins.title}</p>
                      {ins.recommendation && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>{ins.recommendation}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
