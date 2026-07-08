import { useEffect, useState, useCallback, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ExternalLink } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, timeAgo, severityTone } from './helpers';

export default function PureAlertsPage() {
  const { toast } = useToast();
  const [alerts, setAlerts] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((force = false) => {
    return Promise.allSettled([
      client.get(`/pure1/alerts${force ? '?refresh=1' : ''}`),
      client.get('/pure1/status'),
    ]).then(([a, s]) => {
      if (a.status === 'fulfilled') setAlerts(a.value.data || []);
      else { setAlerts([]); toast({ type: 'error', title: 'Failed to load Pure alerts' }); }
      if (s.status === 'fulfilled') setShowHidden(!!s.value.data.showHiddenAlerts);
    });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  // Pure1 emits low-signal "hidden" severity events; keep them out unless enabled.
  const visible = useMemo(
    () => (alerts || []).filter((a) => showHidden || String(a.severity || '').toLowerCase() !== 'hidden'),
    [alerts, showHidden]);

  const counts = useMemo(() => visible.reduce(
    (acc, a) => {
      const s = String(a.severity || '').toLowerCase();
      if (s === 'critical') acc.critical += 1;
      else if (s === 'warning') acc.warning += 1;
      else acc.info += 1;
      return acc;
    },
    { critical: 0, warning: 0, info: 0 }
  ), [visible]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AlertTriangle} title="Pure Alerts" description="Open alerts across all Pure arrays">
        <button
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
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
        ) : visible.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-status-ok py-8 justify-center">
            <CheckCircle2 size={16} /> No open alerts across your Pure arrays
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Severity</th>
                  <th className="py-2 pr-3">Array</th>
                  <th className="py-2 pr-3">Component</th>
                  <th className="py-2 pr-3">Summary</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3 text-right">Updated</th>
                  <th className="py-2 pr-3">KB</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity || 'unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-ink">{a.arrayName || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.component || a.componentType || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.summary || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.category || '—'}</td>
                    <td className="py-2 pr-3 text-right text-ink-faint tnum">{a.updated ? timeAgo(a.updated) : '—'}</td>
                    <td className="py-2 pr-3">
                      {a.knowledgeBaseUrl
                        ? <a href={a.knowledgeBaseUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline inline-flex items-center gap-1 text-[11px]">KB <ExternalLink size={11} /></a>
                        : <span className="text-ink-faint">—</span>}
                    </td>
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
