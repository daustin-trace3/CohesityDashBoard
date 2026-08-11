import { useEffect, useState, useCallback } from 'react';
import { Server, Database } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtWhen } from './helpers';

function UsageBar({ pct }) {
  if (pct == null) return <span className="text-ink-faint">—</span>;
  const color = pct > 90 ? '#C75D5D' : pct > 80 ? '#D4A24E' : '#6CB33F';
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="w-24 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
      </div>
      <span className="tnum text-xs" style={{ color: pct > 80 ? color : undefined }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

const jobResultTone = (r) => {
  const v = String(r || '').toLowerCase();
  if (v === 'success') return 'ok';
  if (v === 'warning') return 'warn';
  if (v === 'failed') return 'crit';
  return 'neutral';
};

export default function NxMinePage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/mine/summary')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ configured: false, clusters: [], veeam: { connections: [], jobs: [], repos: [] } }); toast({ type: 'error', title: 'Failed to load Mine summary' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  if (data && data.configured === false) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={Server} title="Mine" description="Nutanix Mine backup-target clusters and their Veeam integration">
          <LastUpdated date={lastRefreshed} prefix="Updated" />
          <RefreshButton onClick={load} />
        </PageHeader>
        <div className="panel p-6 text-center">
          <p className="text-sm text-ink-muted">
            Mine is not configured — mark a source as a Mine cluster under{' '}
            <Link to="/nutanix/settings" className="text-brand underline">Settings</Link>.
          </p>
        </div>
      </div>
    );
  }

  const clusters = data?.clusters || [];
  const veeam = data?.veeam || { connections: [], jobs: [], repos: [] };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Mine" description="Nutanix Mine backup-target clusters and their Veeam integration">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Mine Cluster Capacity</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : clusters.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Mine clusters found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Cluster</th>
                <th className="py-2 pr-3 text-right">Capacity</th>
                <th className="py-2 pr-3">Used</th>
              </tr></thead>
              <tbody>
                {clusters.map((c) => {
                  const pct = c.storage_capacity_bytes > 0 ? (c.storage_usage_bytes / c.storage_capacity_bytes) * 100 : null;
                  return (
                    <tr key={c.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{c.name || c.uuid}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(c.storage_capacity_bytes)}</td>
                      <td className="py-2 pr-3"><UsageBar pct={pct} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Veeam Jobs</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : veeam.jobs.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Veeam jobs found — configure a Veeam connection under Settings.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Job</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Last Result</th>
                <th className="py-2 pr-3">Last Run</th>
              </tr></thead>
              <tbody>
                {veeam.jobs.map((j) => (
                  <tr key={j.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{j.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{j.type || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={jobResultTone(j.last_result)}>{j.last_result || 'Unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(j.last_run_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Database size={15} className="text-brand" /> Veeam Repositories</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : veeam.repos.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Veeam repositories found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Repository</th>
                <th className="py-2 pr-3 text-right">Capacity</th>
                <th className="py-2 pr-3">Used</th>
              </tr></thead>
              <tbody>
                {veeam.repos.map((r) => {
                  const pct = r.capacity_bytes > 0 ? (r.used_bytes / r.capacity_bytes) * 100 : null;
                  return (
                    <tr key={r.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{r.name || '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.capacity_bytes)}</td>
                      <td className="py-2 pr-3"><UsageBar pct={pct} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
