import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftRight, ShieldCheck, HeartPulse } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum } from './helpers';

function fmtLag(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export default function NetAppReplicationPage() {
  const { toast } = useToast();
  const [rels, setRels] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netapp/replication')
    .then(({ data }) => { setRels(data); setLastRefreshed(new Date()); })
    .catch(() => { setRels([]); toast({ type: 'error', title: 'Failed to load SnapMirror relationships' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const healthy = (rels || []).filter((r) => r.healthy).length;
  const unhealthy = (rels || []).length - healthy;
  const maxLag = (rels || []).reduce((m, r) => Math.max(m, r.lag_seconds || 0), 0);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ArrowLeftRight} title="NetApp Replication (SnapMirror)" description="SnapMirror DR relationships, health and lag across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={ShieldCheck} label="Relationships" value={fmtNum((rels || []).length)} tone="brand" />
        <StatCard icon={HeartPulse} label="Healthy" value={healthy} tone="ok" />
        <StatCard icon={HeartPulse} label="Unhealthy" value={unhealthy} tone={unhealthy > 0 ? 'crit' : 'ok'} />
        <StatCard icon={ArrowLeftRight} label="Max Lag" value={fmtLag(maxLag || null)} tone={maxLag > 86400 ? 'warn' : 'default'} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {rels == null ? (
          <LoadingPanel label="Loading relationships…" />
        ) : rels.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No SnapMirror relationships found on the registered cluster(s).</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Source</th><th className="py-2 pr-3">Destination</th><th className="py-2 pr-3">State</th>
                  <th className="py-2 pr-3">Health</th><th className="py-2 pr-3 text-right">Lag</th><th className="py-2 pr-3">Last Transfer</th><th className="py-2 pr-3 text-right">Bytes</th>
                </tr>
              </thead>
              <tbody>
                {rels.map((r) => (
                  <tr key={r.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink truncate max-w-[240px]">{r.source_path}{r.source_cluster ? <span className="text-ink-faint"> @{r.source_cluster}</span> : ''}</td>
                    <td className="py-2 pr-3 text-ink-muted truncate max-w-[240px]">{r.destination_path}{r.destination_cluster ? <span className="text-ink-faint"> @{r.destination_cluster}</span> : ''}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.state || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={r.healthy ? 'ok' : 'crit'}>{r.healthy ? 'healthy' : 'unhealthy'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum"><span className={r.lag_seconds > 86400 ? 'text-status-warn' : 'text-ink-muted'}>{fmtLag(r.lag_seconds)}</span></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.transfer_state || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.last_transfer_bytes)}</td>
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
