import { useCallback, useEffect, useState } from 'react';
import {
  ClipboardCheck, FileCheck, ShieldOff, Layers, RefreshCw, Lock, CloudOff, GitCompareArrows,
} from 'lucide-react';
import client from '../api/client';
import { PageHeader, Panel, Badge, StatCard, LoadingPanel } from '../components/ui/primitives';

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

function fmtRetention(days) {
  if (days == null) return '—';
  if (days % 365 === 0 && days >= 365) return `${days / 365}y`;
  if (days % 30 === 0 && days >= 30) return `${days / 30}mo`;
  if (days % 7 === 0 && days >= 7) return `${days / 7}w`;
  return `${days}d`;
}

export default function GovernancePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [policyFilter, setPolicyFilter] = useState('all'); // all | flagged

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await client.get('/governance');
      setData(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary;
  const policies = data?.policies || [];
  const retentionDrift = data?.retentionDrift || [];
  const sources = data?.sources || [];
  const versions = data?.versions || [];

  const driftNames = new Set(retentionDrift.map(d => d.name));
  const visiblePolicies = policyFilter === 'flagged'
    ? policies.filter(p => p.noOffsiteCopy || driftNames.has(p.name))
    : policies;

  const hasAnyData = policies.length > 0 || sources.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={ClipboardCheck}
        title="Governance & Audit"
        description="Policy compliance, unprotected sources, and software version drift across the estate"
      >
        <button
          onClick={load}
          disabled={loading}
          className="text-xs px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </PageHeader>

      {loading && !data ? (
        <div className="panel"><LoadingPanel label="Loading governance data…" height={320} /></div>
      ) : error ? (
        <div className="panel p-6 text-center text-sm text-ink-muted">
          Could not load governance data. <button onClick={load} className="text-brand hover:underline cursor-pointer">Retry</button>
        </div>
      ) : !hasAnyData ? (
        <div className="panel p-10 text-center">
          <ClipboardCheck size={32} className="text-ink-faint mx-auto mb-3" />
          <p className="text-sm font-semibold text-ink mb-1">No governance data collected yet</p>
          <p className="text-xs text-ink-muted max-w-md mx-auto leading-relaxed">
            Policies and source registrations are collected during each poll cycle. Trigger a poll
            from the Dashboard or wait for the next scheduled run, then refresh this page.
          </p>
        </div>
      ) : (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              icon={FileCheck}
              label="Protection Policies"
              value={summary.policyCount}
              sub={`${summary.retentionDriftCount} with retention drift`}
              tone="brand"
            />
            <StatCard
              icon={CloudOff}
              label="No Off-site Copy"
              value={summary.noOffsiteCopyCount}
              sub={summary.noOffsiteCopyCount > 0 ? '3-2-1 rule violations' : 'All policies compliant'}
              tone={summary.noOffsiteCopyCount > 0 ? 'warn' : 'ok'}
            />
            <StatCard
              icon={ShieldOff}
              label="Unprotected Objects"
              value={summary.totalUnprotected}
              sub={`${summary.totalProtected} protected`}
              tone={summary.totalUnprotected > 0 ? 'warn' : 'ok'}
            />
            <StatCard
              icon={Layers}
              label="Software Versions"
              value={summary.versionSpread}
              sub={summary.dominantVersion ? `Dominant: ${String(summary.dominantVersion).split('_')[0]}` : 'No version data'}
              tone={summary.versionSpread > 1 ? 'info' : 'ok'}
            />
          </div>

          {/* Policy audit */}
          <Panel
            title="Policy Audit"
            icon={FileCheck}
            actions={
              <div className="flex items-center gap-1">
                {['all', 'flagged'].map(f => (
                  <button
                    key={f}
                    onClick={() => setPolicyFilter(f)}
                    className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors cursor-pointer capitalize ${
                      policyFilter === f
                        ? 'bg-brand text-cohesity-black border-brand font-semibold'
                        : 'border-cohesity-border text-ink-muted hover:border-brand/50'
                    }`}
                  >
                    {f === 'flagged' ? `Flagged (${policies.filter(p => p.noOffsiteCopy || driftNames.has(p.name)).length})` : 'All'}
                  </button>
                ))}
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-ink-muted">
                <thead>
                  <tr className="text-ink-faint border-b border-cohesity-border text-left">
                    <th className="py-2 pr-4 font-semibold">Policy</th>
                    <th className="py-2 pr-4 font-semibold">Cluster</th>
                    <th className="py-2 pr-4 font-semibold text-right">Retention</th>
                    <th className="py-2 pr-4 font-semibold">Replication</th>
                    <th className="py-2 pr-4 font-semibold">Archival</th>
                    <th className="py-2 pr-4 font-semibold text-center">DataLock</th>
                    <th className="py-2 font-semibold">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePolicies.map((p, i) => (
                    <tr key={`${p.clusterId}-${p.policyId}-${i}`} className="border-b border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors">
                      <td className="py-2 pr-4 text-ink font-medium max-w-[220px] truncate" title={p.name}>{p.name || '—'}</td>
                      <td className="py-2 pr-4">{p.clusterName}</td>
                      <td className="py-2 pr-4 text-right tnum">{fmtRetention(p.retentionDays)}</td>
                      <td className="py-2 pr-4 max-w-[180px] truncate" title={p.replicationTargets.join(', ')}>
                        {p.replicationTargets.length > 0 ? p.replicationTargets.join(', ') : <span className="text-ink-faint">None</span>}
                      </td>
                      <td className="py-2 pr-4 max-w-[180px] truncate" title={p.archivalTargets.join(', ')}>
                        {p.archivalTargets.length > 0 ? p.archivalTargets.join(', ') : <span className="text-ink-faint">None</span>}
                      </td>
                      <td className="py-2 pr-4 text-center">
                        {p.dataLock ? <Lock size={13} className="text-status-ok inline" aria-label="DataLock enabled" /> : <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {p.noOffsiteCopy && <Badge tone="warn">No off-site copy</Badge>}
                          {driftNames.has(p.name) && <Badge tone="info">Retention drift</Badge>}
                          {!p.noOffsiteCopy && !driftNames.has(p.name) && <span className="text-ink-faint">—</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {visiblePolicies.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-6 text-ink-faint">No policies {policyFilter === 'flagged' ? 'flagged' : 'collected'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Retention drift detail */}
            <Panel title="Retention Drift" icon={GitCompareArrows}>
              {retentionDrift.length === 0 ? (
                <p className="text-xs text-status-ok py-4 text-center">No retention drift detected — same-named policies agree across clusters.</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {retentionDrift.map(d => (
                    <div key={d.name} className="rounded-lg border border-cohesity-border bg-surface-overlay/40 px-3.5 py-2.5">
                      <p className="text-xs font-semibold text-ink mb-1.5">{d.name}</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {d.variants.map((v, i) => (
                          <Badge key={i} tone="neutral" className="tnum">
                            {v.clusterName}: {fmtRetention(v.retentionDays)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            {/* Version drift */}
            <Panel title="Software Versions" icon={Layers}>
              {versions.length === 0 ? (
                <p className="text-xs text-ink-faint py-4 text-center">No version data collected yet.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {versions.map(v => (
                    <div key={v.clusterId} className="flex items-center justify-between gap-2 border-b border-cohesity-border/60 last:border-0 py-1.5">
                      <span className="text-xs text-ink truncate">{v.clusterName}</span>
                      {v.softwareVersion ? (
                        <Badge tone={v.isOutlier ? 'warn' : 'ok'} className="tnum">
                          {String(v.softwareVersion).split('_')[0]}
                          {v.isOutlier && ' (outlier)'}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">unknown</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* Unprotected sources */}
          <Panel title="Source Protection Coverage" icon={ShieldOff}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-ink-muted">
                <thead>
                  <tr className="text-ink-faint border-b border-cohesity-border text-left">
                    <th className="py-2 pr-4 font-semibold">Source</th>
                    <th className="py-2 pr-4 font-semibold">Cluster</th>
                    <th className="py-2 pr-4 font-semibold">Environment</th>
                    <th className="py-2 pr-4 font-semibold text-right">Protected</th>
                    <th className="py-2 pr-4 font-semibold text-right">Unprotected</th>
                    <th className="py-2 pr-4 font-semibold text-right">Unprotected Size</th>
                    <th className="py-2 font-semibold w-[140px]">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s, i) => {
                    const total = (s.protectedCount || 0) + (s.unprotectedCount || 0);
                    const pct = total > 0 ? ((s.protectedCount || 0) / total) * 100 : null;
                    const barColor = pct == null ? 'bg-cohesity-border' : pct >= 95 ? 'bg-status-ok' : pct >= 75 ? 'bg-status-warn' : 'bg-status-crit';
                    return (
                      <tr key={`${s.clusterId}-${s.sourceId}-${i}`} className="border-b border-cohesity-border/60 hover:bg-surface-overlay/50 transition-colors">
                        <td className="py-2 pr-4 text-ink font-medium max-w-[220px] truncate" title={s.sourceName}>{s.sourceName || '—'}</td>
                        <td className="py-2 pr-4">{s.clusterName}</td>
                        <td className="py-2 pr-4">{s.environment || '—'}</td>
                        <td className="py-2 pr-4 text-right tnum">{s.protectedCount ?? '—'}</td>
                        <td className={`py-2 pr-4 text-right tnum font-semibold ${(s.unprotectedCount || 0) > 0 ? 'text-status-warn' : 'text-status-ok'}`}>
                          {s.unprotectedCount ?? '—'}
                        </td>
                        <td className="py-2 pr-4 text-right tnum">{fmtBytes(s.unprotectedBytes)}</td>
                        <td className="py-2">
                          {pct != null ? (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-surface-base rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-[10px] tnum text-ink-muted w-9 text-right">{pct.toFixed(0)}%</span>
                            </div>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {sources.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-6 text-ink-faint">No source registration data collected yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
