// Cohesity plugin — Reporting page. Ported from frontend/src/pages/ReportingPage.jsx.
// Estate-wide executive report assembled client-side from already-fetched
// endpoints (no dedicated backend report/CSV route exists for this page —
// unlike Dell's reports.jsx, which streams a server-built CSV via
// apiFetchBlob, this report's CSV is built from data the page already holds,
// exactly like the built-in did with a Blob).
import {
  apiFetch, useToast, PageHeader, Panel, Badge, StatCard, LoadingPanel, LastUpdated, RefreshButton,
} from '../ui.jsx';
import { Database, Server, Bell, ShieldCheck } from '../icons.jsx';

// Not in the shared icon kit — added locally (same 24x24 stroke style as icons.jsx).
function FileText(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6M9 9h1" />
    </svg>
  );
}
function Printer(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M6 9V2h12v7" /><rect x="6" y="14" width="12" height="8" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}
function Download(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" />
    </svg>
  );
}

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

export default function ReportingPage() {
  const [loading, setLoading] = React.useState(true);
  const [clusters, setClusters] = React.useState([]);
  const [latest, setLatest] = React.useState({});
  const [alerts, setAlerts] = React.useState([]);
  const [protection, setProtection] = React.useState(null);
  const [insights, setInsights] = React.useState([]);
  const [generatedAt, setGeneratedAt] = React.useState(null);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    const toastId = toast({ type: 'loading', title: 'Generating report', message: 'Collecting estate-wide data…' });
    try {
      const [clRes, alRes, prRes, insRes] = await Promise.allSettled([
        apiFetch('/cohesity/clusters'),
        apiFetch('/cohesity/alerts?dismissed=0&resolved=0'),
        apiFetch('/cohesity/analytics/protection-runs?days=30'),
        apiFetch('/cohesity/insights'),
      ]);
      const cls = clRes.status === 'fulfilled' ? clRes.value : [];
      setClusters(cls);
      setAlerts(alRes.status === 'fulfilled' ? alRes.value : []);
      setProtection(prRes.status === 'fulfilled' ? prRes.value : null);
      setInsights(insRes.status === 'fulfilled' ? insRes.value.insights : []);

      const metricResults = await Promise.allSettled(
        cls.map((c) => apiFetch(`/cohesity/metrics/${c.id}/history?days=1`).then((rows) => ({ id: c.id, rows })))
      );
      const map = {};
      for (const r of metricResults) {
        if (r.status === 'fulfilled' && r.value.rows.length > 0) {
          map[r.value.id] = r.value.rows[r.value.rows.length - 1];
        }
      }
      setLatest(map);
      setGeneratedAt(new Date());
      toast({ id: toastId, type: 'success', title: 'Report ready', message: 'Estate report generated successfully.' });
    } catch {
      toast({ id: toastId, type: 'error', title: 'Report failed', message: 'Could not collect all report data.' });
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = clusters.map((c) => latest[c.id]).filter(Boolean);
  const totalUsed = entries.reduce((s, m) => s + (m.used_bytes || 0), 0);
  const totalCap = entries.reduce((s, m) => s + (m.total_capacity_bytes || 0), 0);
  const criticalAlerts = alerts.filter((a) => a.severity === 'critical').length;
  const successRate = protection?.summary?.successRate;

  const exportCsv = () => {
    const rows = ['Cluster,Connection,Used Bytes,Total Bytes,Used %,Data Reduction,Software Version,Node Count'];
    for (const c of clusters) {
      const m = latest[c.id];
      const pct = m?.total_capacity_bytes > 0 ? ((m.used_bytes / m.total_capacity_bytes) * 100).toFixed(1) : '';
      rows.push([
        JSON.stringify(c.name), c.connection_type,
        m?.used_bytes ?? '', m?.total_capacity_bytes ?? '', pct,
        m?.data_reduction_ratio ?? '', m?.software_version ?? '', m?.node_count ?? '',
      ].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cohesity-estate-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ type: 'success', title: 'CSV exported', message: 'Estate report downloaded.' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        icon={FileText}
        title="Executive Report"
        description={generatedAt ? `Estate summary generated ${generatedAt.toLocaleString()}` : 'Estate-wide summary across capacity, alerts, and data protection'}
      >
        <RefreshButton onClick={load} refreshing={loading} label="Regenerate" />
        <LastUpdated date={generatedAt} prefix="Generated" />
        <button onClick={exportCsv} disabled={loading || clusters.length === 0} className="co-btn-ghost" style={{ opacity: loading || clusters.length === 0 ? 0.5 : 1 }}>
          <Download size={13} /> Export CSV
        </button>
        <button onClick={() => window.print()} disabled={loading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '6px 12px', background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.3)', color: 'var(--co-brand)', borderRadius: 8, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1 }}>
          <Printer size={13} /> Print / PDF
        </button>
      </PageHeader>

      {loading ? (
        <div className="panel"><LoadingPanel label="Generating estate report…" height={320} /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 12 }}>
            <StatCard icon={Database} label="Total Capacity" value={fmtBytes(totalCap)} sub={`${fmtBytes(totalUsed)} used`} tone="brand" />
            <StatCard icon={Server} label="Clusters" value={clusters.length} sub={`${entries.length} reporting`} tone={entries.length === clusters.length ? 'ok' : 'warn'} />
            <StatCard icon={Bell} label="Open Alerts" value={alerts.length} sub={criticalAlerts > 0 ? `${criticalAlerts} critical` : 'No criticals'} tone={criticalAlerts > 0 ? 'crit' : 'ok'} />
            <StatCard icon={ShieldCheck} label="Backup Success (30d)" value={successRate != null ? `${successRate}%` : '—'} sub={protection ? `${protection.summary.failure} failures of ${protection.summary.total}` : ''} tone={successRate == null ? 'default' : successRate >= 95 ? 'ok' : successRate >= 85 ? 'warn' : 'crit'} />
          </div>

          <Panel title="Capacity by Cluster" icon={Database}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, color: 'var(--co-ink-muted)' }}>
                <thead>
                  <tr style={{ color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 16px 8px 0', fontWeight: 600 }}>Cluster</th>
                    <th style={{ padding: '8px 16px 8px 0', fontWeight: 600 }}>Connection</th>
                    <th style={{ padding: '8px 16px 8px 0', fontWeight: 600, textAlign: 'right' }}>Used</th>
                    <th style={{ padding: '8px 16px 8px 0', fontWeight: 600, textAlign: 'right' }}>Capacity</th>
                    <th style={{ padding: '8px 16px 8px 0', fontWeight: 600, textAlign: 'right' }}>% Used</th>
                    <th style={{ padding: '8px 16px 8px 0', fontWeight: 600, textAlign: 'right' }}>Data Reduction</th>
                    <th style={{ padding: '8px 16px 8px 0', fontWeight: 600, textAlign: 'right' }}>Nodes</th>
                    <th style={{ padding: '8px 0', fontWeight: 600, textAlign: 'right' }}>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {clusters.map((c) => {
                    const m = latest[c.id];
                    const pct = m?.total_capacity_bytes > 0 ? (m.used_bytes / m.total_capacity_bytes) * 100 : null;
                    const tone = pct == null ? 'neutral' : pct >= 86 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
                    return (
                      <tr key={c.id} style={{ borderBottom: '1px solid rgba(31,43,55,.6)' }}>
                        <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500 }}>{c.name}</td>
                        <td className="capitalize" style={{ padding: '8px 16px 8px 0' }}>{c.connection_type}</td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right' }}>{fmtBytes(m?.used_bytes)}</td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right' }}>{fmtBytes(m?.total_capacity_bytes)}</td>
                        <td style={{ padding: '8px 16px 8px 0', textAlign: 'right' }}><Badge tone={tone} className="tnum">{pct != null ? pct.toFixed(1) + '%' : 'No data'}</Badge></td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right' }}>{m?.data_reduction_ratio ? m.data_reduction_ratio.toFixed(2) + 'x' : '—'}</td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right' }}>{m?.node_count ?? '—'}</td>
                        <td className="tnum" style={{ padding: '8px 0', textAlign: 'right' }}>{m?.software_version ?? '—'}</td>
                      </tr>
                    );
                  })}
                  {clusters.length === 0 && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--co-ink-faint)' }}>No clusters configured</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Risk Summary & Recommendations" icon={Bell}>
            {insights.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--co-ink-faint)', padding: '12px 0', textAlign: 'center' }}>No insights available.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {insights.slice(0, 10).map((ins, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, borderBottom: i === Math.min(insights.length, 10) - 1 ? 'none' : '1px solid rgba(31,43,55,.6)', paddingBottom: 8 }}>
                    <Badge tone={ins.severity === 'critical' ? 'crit' : ins.severity === 'warning' ? 'warn' : ins.severity === 'ok' ? 'ok' : 'info'} className="capitalize" style={{ marginTop: 2, flexShrink: 0 }}>
                      {ins.severity}
                    </Badge>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: 0 }}>{ins.title}</p>
                      {ins.recommendation && <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: '2px 0 0' }}>{ins.recommendation}</p>}
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
