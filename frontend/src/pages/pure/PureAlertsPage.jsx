import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, timeAgo, severityTone } from './helpers';

export default function PureAlertsPage() {
  const { toast } = useToast();
  const [alerts, setAlerts] = useState(null);

  const load = useCallback(() => {
    return client
      .get('/pure/alerts')
      .then(({ data }) => setAlerts(data))
      .catch(() => {
        setAlerts([]);
        toast({ type: 'error', title: 'Failed to load Pure alerts' });
      });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const counts = (alerts || []).reduce(
    (acc, a) => {
      const s = String(a.severity || '').toLowerCase();
      if (s === 'critical') acc.critical += 1;
      else if (s === 'warning') acc.warning += 1;
      else acc.info += 1;
      return acc;
    },
    { critical: 0, warning: 0, info: 0 }
  );

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AlertTriangle} title="Pure Alerts" description="Open alerts across all FlashArrays">
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="Critical" value={counts.critical} tone={counts.critical > 0 ? 'crit' : 'ok'} />
        <StatCard icon={AlertTriangle} label="Warning" value={counts.warning} tone={counts.warning > 0 ? 'warn' : 'ok'} />
        <StatCard icon={AlertTriangle} label="Info" value={counts.info} tone="info" />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {alerts == null ? (
          <LoadingPanel label="Loading alerts…" height={160} />
        ) : alerts.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-status-ok py-8 justify-center">
            <CheckCircle2 size={16} /> No open alerts across any array
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Severity</th>
                  <th className="py-2 pr-3">Array</th>
                  <th className="py-2 pr-3">Component</th>
                  <th className="py-2 pr-3">Summary</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3 text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity || 'unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-ink">{a.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.component_name || a.component_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.summary || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.category || '—'}</td>
                    <td className="py-2 pr-3 text-right text-ink-faint">{timeAgo(a.updated_at_ms)}</td>
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
