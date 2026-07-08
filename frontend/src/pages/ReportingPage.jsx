import { useEffect, useState } from 'react';
import {
  FileText, Printer, Download, Database, Server, Bell, ShieldCheck,
} from 'lucide-react';
import client from '../api/client';
import { PageHeader, Panel, Badge, StatCard, LoadingPanel, LastUpdated, RefreshButton } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

export default function ReportingPage() {
  const [loading, setLoading] = useState(true);
  const [clusters, setClusters] = useState([]);
  const [latest, setLatest] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [protection, setProtection] = useState(null);
  const [insights, setInsights] = useState([]);
  const [generatedAt, setGeneratedAt] = useState(null);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    const toastId = toast({ type: 'loading', title: 'Generating report', message: 'Collecting estate-wide data…' });
    try {
      const [clRes, alRes, prRes, insRes] = await Promise.allSettled([
        client.get('/clusters'),
        client.get('/alerts?dismissed=0&resolved=0'),
        client.get('/analytics/protection-runs?days=30'),
        client.get('/insights'),
      ]);
      const cls = clRes.status === 'fulfilled' ? clRes.value.data : [];
      setClusters(cls);
      setAlerts(alRes.status === 'fulfilled' ? alRes.value.data : []);
      setProtection(prRes.status === 'fulfilled' ? prRes.value.data : null);
      setInsights(insRes.status === 'fulfilled' ? insRes.value.data.insights : []);

      const metricResults = await Promise.allSettled(
        cls.map(c => client.get(`/metrics/${c.id}/history?days=1`).then(r => ({ id: c.id, rows: r.data })))
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

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = clusters.map(c => latest[c.id]).filter(Boolean);
  const totalUsed = entries.reduce((s, m) => s + (m.used_bytes || 0), 0);
  const totalCap = entries.reduce((s, m) => s + (m.total_capacity_bytes || 0), 0);
  const criticalAlerts = alerts.filter(a => a.severity === 'critical').length;
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
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={FileText}
        title="Executive Report"
        description={generatedAt ? `Estate summary generated ${generatedAt.toLocaleString()}` : 'Estate-wide summary across capacity, alerts, and data protection'}
      >
        <RefreshButton onClick={load} refreshing={loading} label="Regenerate" />
        <LastUpdated date={generatedAt} prefix="Generated" />
        <button onClick={exportCsv} disabled={loading || clusters.length === 0}
          className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
          <Download size={13} /> Export CSV
        </button>
        <button onClick={() => window.print()} disabled={loading}
          className="text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
          <Printer size={13} /> Print / PDF
        </button>
      </PageHeader>

      {loading ? (
        <div className="panel"><LoadingPanel label="Generating estate report…" height={320} /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={Database} label="Total Capacity" value={fmtBytes(totalCap)} sub={`${fmtBytes(totalUsed)} used`} tone="brand" />
            <StatCard icon={Server} label="Clusters" value={clusters.length} sub={`${entries.length} reporting`} tone={entries.length === clusters.length ? 'ok' : 'warn'} />
            <StatCard icon={Bell} label="Open Alerts" value={alerts.length} sub={criticalAlerts > 0 ? `${criticalAlerts} critical` : 'No criticals'} tone={criticalAlerts > 0 ? 'crit' : 'ok'} />
            <StatCard icon={ShieldCheck} label="Backup Success (30d)" value={successRate != null ? `${successRate}%` : '—'} sub={protection ? `${protection.summary.failure} failures of ${protection.summary.total}` : ''} tone={successRate == null ? 'default' : successRate >= 95 ? 'ok' : successRate >= 85 ? 'warn' : 'crit'} />
          </div>

          <Panel title="Capacity by Cluster" icon={Database}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-ink-muted">
                <thead>
                  <tr className="text-ink-faint border-b border-cohesity-border text-left">
                    <th className="py-2 pr-4 font-semibold">Cluster</th>
                    <th className="py-2 pr-4 font-semibold">Connection</th>
                    <th className="py-2 pr-4 font-semibold text-right">Used</th>
                    <th className="py-2 pr-4 font-semibold text-right">Capacity</th>
                    <th className="py-2 pr-4 font-semibold text-right">% Used</th>
                    <th className="py-2 pr-4 font-semibold text-right">Data Reduction</th>
                    <th className="py-2 pr-4 font-semibold text-right">Nodes</th>
                    <th className="py-2 font-semibold text-right">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {clusters.map(c => {
                    const m = latest[c.id];
                    const pct = m?.total_capacity_bytes > 0 ? (m.used_bytes / m.total_capacity_bytes) * 100 : null;
                    const tone = pct == null ? 'neutral' : pct >= 86 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
                    return (
                      <tr key={c.id} className="border-b border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors">
                        <td className="py-2 pr-4 text-ink font-medium">{c.name}</td>
                        <td className="py-2 pr-4 capitalize">{c.connection_type}</td>
                        <td className="py-2 pr-4 text-right tnum">{fmtBytes(m?.used_bytes)}</td>
                        <td className="py-2 pr-4 text-right tnum">{fmtBytes(m?.total_capacity_bytes)}</td>
                        <td className="py-2 pr-4 text-right"><Badge tone={tone} className="tnum">{pct != null ? pct.toFixed(1) + '%' : 'No data'}</Badge></td>
                        <td className="py-2 pr-4 text-right tnum">{m?.data_reduction_ratio ? m.data_reduction_ratio.toFixed(2) + 'x' : '—'}</td>
                        <td className="py-2 pr-4 text-right tnum">{m?.node_count ?? '—'}</td>
                        <td className="py-2 text-right tnum">{m?.software_version ?? '—'}</td>
                      </tr>
                    );
                  })}
                  {clusters.length === 0 && (
                    <tr><td colSpan={8} className="text-center py-6 text-ink-faint">No clusters configured</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Risk Summary & Recommendations" icon={Bell}>
            {insights.length === 0 ? (
              <p className="text-xs text-ink-faint py-3 text-center">No insights available.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {insights.slice(0, 10).map((ins, i) => (
                  <div key={i} className="flex items-start gap-2.5 border-b border-cohesity-border/60 last:border-0 pb-2 last:pb-0">
                    <Badge tone={ins.severity === 'critical' ? 'crit' : ins.severity === 'warning' ? 'warn' : ins.severity === 'ok' ? 'ok' : 'info'} className="mt-0.5 flex-shrink-0 capitalize">
                      {ins.severity}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-ink">{ins.title}</p>
                      {ins.recommendation && <p className="text-[11px] text-ink-muted mt-0.5">{ins.recommendation}</p>}
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
