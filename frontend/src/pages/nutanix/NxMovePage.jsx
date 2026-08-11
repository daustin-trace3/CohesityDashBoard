import { useEffect, useState, useCallback } from 'react';
import { ArrowRightLeft, AlertOctagon } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen } from './helpers';

function ProgressBar({ pct }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <div className="flex items-center gap-2">
      <div className="w-32 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${p}%`, backgroundColor: BRAND }} />
      </div>
      <span className="tnum text-xs text-ink-muted">{p.toFixed(0)}%</span>
    </div>
  );
}

const planStateTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v.includes('fail') || v.includes('error')) return 'crit';
  if (v.includes('complet') || v.includes('done') || v.includes('cutover')) return 'ok';
  return 'info';
};

export default function NxMovePage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/move/summary')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ configured: false, plans: [], workloads: [], events: [] }); toast({ type: 'error', title: 'Failed to load Move summary' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  if (data && data.configured === false) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={ArrowRightLeft} title="Move" description="VM migration plans via Nutanix Move appliances">
          <LastUpdated date={lastRefreshed} prefix="Updated" />
          <RefreshButton onClick={load} />
        </PageHeader>
        <div className="panel p-6 text-center">
          <p className="text-sm text-ink-muted">
            Move is not configured — add a Move appliance under{' '}
            <Link to="/nutanix/settings" className="text-brand underline">Settings</Link>.
          </p>
        </div>
      </div>
    );
  }

  const plans = data?.plans || [];
  const workloads = data?.workloads || [];
  const events = data?.events || [];
  const failedEvents = events.filter(e => e.failure_notes);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ArrowRightLeft} title="Move" description="VM migration plans via Nutanix Move appliances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Migration Plans</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : plans.length === 0 ? (
          <div className="text-sm text-status-ok py-6 text-center">No migration plans — healthy.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Plan</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3">Progress</th>
                <th className="py-2 pr-3">Source → Target</th>
                <th className="py-2 pr-3 text-right">VMs</th>
              </tr></thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{p.name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={planStateTone(p.migration_status || p.state)}>{p.migration_status || p.state || '—'}</Badge></td>
                    <td className="py-2 pr-3"><ProgressBar pct={p.progress} /></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{p.source_provider || '—'} → {p.target_provider || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.vm_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">VM Workloads</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : workloads.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VM workloads found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">VM</th>
                <th className="py-2 pr-3">Plan</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3">Progress</th>
              </tr></thead>
              <tbody>
                {workloads.map((w) => (
                  <tr key={w.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{w.vm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{w.plan_name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={String(w.state_label || '').toLowerCase().includes('cutover') ? 'ok' : 'info'}>{w.state_label || `State ${w.state_code}`}</Badge></td>
                    <td className="py-2 pr-3"><ProgressBar pct={w.progress} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          <AlertOctagon size={15} className={failedEvents.length ? 'text-status-crit' : 'text-brand'} /> Failure Events
        </p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : failedEvents.length === 0 ? (
          <div className="text-sm text-status-ok py-6 text-center">No failures reported.</div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[40vh] overflow-y-auto pr-1">
            {failedEvents.map((e) => (
              <div key={e.id} className="bg-surface-overlay rounded-lg px-3 py-2">
                <p className="text-xs text-ink">{e.event_name || '—'} · {e.vm_name || '—'} · {e.plan_name || '—'}</p>
                <p className="text-[11px] text-status-crit mt-0.5">{e.failure_notes}</p>
                <p className="text-[10px] text-ink-faint mt-0.5">{fmtWhen(e.created_at)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
