import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, timeAgo, severityTone } from './helpers';

export default function NetAppAlertsPage() {
  const { toast } = useToast();
  const [alerts, setAlerts] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netapp/alerts')
    .then(({ data }) => { setAlerts(data); setLastRefreshed(new Date()); })
    .catch(() => { setAlerts([]); toast({ type: 'error', title: 'Failed to load NetApp alerts' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const counts = (alerts || []).reduce((a, x) => {
    const t = severityTone(x.severity);
    if (t === 'crit') a.crit += 1; else if (t === 'warn') a.warn += 1; else a.info += 1;
    return a;
  }, { crit: 0, warn: 0, info: 0 });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AlertTriangle} title="NetApp Alerts" description="Health alerts and EMS events across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="Critical / Error" value={counts.crit} tone={counts.crit > 0 ? 'crit' : 'ok'} />
        <StatCard icon={AlertTriangle} label="Warning" value={counts.warn} tone={counts.warn > 0 ? 'warn' : 'ok'} />
        <StatCard icon={AlertTriangle} label="Info" value={counts.info} tone="info" />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {alerts == null ? (
          <LoadingPanel label="Loading alerts…" height={160} />
        ) : alerts.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-status-ok py-8 justify-center"><CheckCircle2 size={16} /> No active alerts across any cluster</div>
        ) : (
          <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Severity</th><th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">Node</th>
                  <th className="py-2 pr-3">Source</th><th className="py-2 pr-3">Message</th><th className="py-2 pr-3 text-right">Seen</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity || 'unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-ink">{a.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.node_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted uppercase text-[11px]">{a.source || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.message || '—'}</td>
                    <td className="py-2 pr-3 text-right text-ink-faint">{timeAgo(a.captured_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
