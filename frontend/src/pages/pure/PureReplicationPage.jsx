import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftRight, RefreshCw, ShieldCheck, Link2, Boxes } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum, statusTone } from './helpers';

function freq(ms) {
  if (!ms) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export default function PureReplicationPage() {
  const { toast } = useToast();
  const [conns, setConns] = useState(null);
  const [pgs, setPgs] = useState(null);
  const [pods, setPods] = useState(null);

  const load = useCallback(() => {
    return Promise.allSettled([
      client.get('/pure/replication'),
      client.get('/pure/protection-groups'),
      client.get('/pure/pods'),
    ]).then(([c, p, d]) => {
      setConns(c.status === 'fulfilled' ? c.value.data : []);
      setPgs(p.status === 'fulfilled' ? p.value.data : []);
      setPods(d.status === 'fulfilled' ? d.value.data : []);
      if (c.status === 'rejected' || p.status === 'rejected') {
        toast({ type: 'error', title: 'Failed to load some replication data' });
      }
    });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const sync = (conns || []).filter((c) => String(c.type || '').includes('sync')).length;
  const async_ = (conns || []).filter((c) => String(c.type || '').includes('async')).length;
  const replicatingPgs = (pgs || []).filter((p) => p.replication_enabled).length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ArrowLeftRight} title="Pure Replication & DR" description="Replication partners and protection group policies across all FlashArrays">
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Link2} label="Replication Partners" value={fmtNum((conns || []).length)} tone="brand" />
        <StatCard icon={ArrowLeftRight} label="Sync" value={sync} />
        <StatCard icon={ArrowLeftRight} label="Async" value={async_} />
        <StatCard icon={ShieldCheck} label="Protection Groups" value={fmtNum((pgs || []).length)} sub={`${replicatingPgs} replicating`} />
      </div>

      {/* ActiveCluster pods */}
      {(pods == null || pods.length > 0) && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-center gap-2 mb-3"><Boxes size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">ActiveCluster Pods</p></div>
          {pods == null ? (
            <LoadingPanel label="Loading pods…" height={100} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Pod</th><th className="py-2 pr-3">Array</th><th className="py-2 pr-3">Promotion</th><th className="py-2 pr-3">Mediator</th><th className="py-2 pr-3">Members</th><th className="py-2 pr-3 text-right">Physical</th>
                </tr></thead>
                <tbody>
                  {pods.map((p) => (
                    <tr key={p.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{p.name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{p.array_name}</td>
                      <td className="py-2 pr-3"><Badge tone={p.promotion_status === 'promoted' ? 'ok' : 'neutral'}>{p.promotion_status || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted">{p.mediator || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{p.member_arrays || '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(p.total_physical_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Replication partners */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Replication Partners</p>
        {conns == null ? (
          <LoadingPanel label="Loading partners…" height={120} />
        ) : conns.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No replication partners configured.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Array</th>
                  <th className="py-2 pr-3">Partner</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Transport</th>
                  <th className="py-2 pr-3">Purity</th>
                  <th className="py-2 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {conns.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.remote_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted uppercase">{c.transport || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{c.version || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(c.status)}>{c.status || 'unknown'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Protection groups */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Protection Groups</p>
        {pgs == null ? (
          <LoadingPanel label="Loading protection groups…" height={120} />
        ) : pgs.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No protection groups found.</div>
        ) : (
          <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Group</th>
                  <th className="py-2 pr-3">Array</th>
                  <th className="py-2 pr-3 text-right">Volumes</th>
                  <th className="py-2 pr-3">Snapshot</th>
                  <th className="py-2 pr-3">Replication</th>
                  <th className="py-2 pr-3 text-right">Retention</th>
                  <th className="py-2 pr-3 text-right">Snap Space</th>
                </tr>
              </thead>
              <tbody>
                {pgs.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink truncate max-w-[240px]">{p.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.array_name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.volume_count)}</td>
                    <td className="py-2 pr-3">
                      {p.snapshot_enabled
                        ? <Badge tone="ok">every {freq(p.snapshot_frequency_ms)}</Badge>
                        : <span className="text-ink-faint">off</span>}
                    </td>
                    <td className="py-2 pr-3">
                      {p.replication_enabled
                        ? <Badge tone="brand">every {freq(p.replication_frequency_ms)}</Badge>
                        : <span className="text-ink-faint">off</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">
                      {p.source_retention_days != null ? `${p.source_retention_days}d` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(p.snapshots_bytes)}</td>
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
