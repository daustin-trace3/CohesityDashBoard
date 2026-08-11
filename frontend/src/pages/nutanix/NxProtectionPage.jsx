import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, RefreshCw, Globe, ClipboardList, AlertTriangle } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, fmtWhen, secsToHuman } from './helpers';

function ProgressBar({ pct, paused }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <div className="flex items-center gap-2">
      <div className="w-32 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${p}%`, backgroundColor: paused ? '#D4A24E' : BRAND }} />
      </div>
      <span className="tnum text-xs text-ink-muted">{p.toFixed(0)}%</span>
    </div>
  );
}

export default function NxProtectionPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/protection')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ pds: [], replications: [], remoteSites: [], policies: [], rpoCompliance: [] }); toast({ type: 'error', title: 'Failed to load protection data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const pds = data?.pds || [];
  const replications = data?.replications || [];
  const remoteSites = data?.remoteSites || [];
  const policies = data?.policies || [];
  const rpoCompliance = data?.rpoCompliance || [];
  const nonCompliant = rpoCompliance.filter(r => !r.compliant).length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Protection & Replication" description="Protection domains, in-flight replications, remote sites and policies">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Protection Domains</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : pds.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No protection domains found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Active</th>
                <th className="py-2 pr-3 text-right">VMs</th>
                <th className="py-2 pr-3">Next Snapshot</th>
                <th className="py-2 pr-3 text-right">Pending</th>
                <th className="py-2 pr-3 text-right">Ongoing</th>
              </tr></thead>
              <tbody>
                {pds.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{p.name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.vm_count)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{p.next_snapshot_usecs ? new Date(Number(p.next_snapshot_usecs) / 1000).toLocaleString() : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.pending_replications)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.ongoing_replications)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><RefreshCw size={15} className="text-brand" /> In-flight Replications</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : replications.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No replications in progress.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Protection Domain</th>
                <th className="py-2 pr-3">Remote Site</th>
                <th className="py-2 pr-3">Progress</th>
                <th className="py-2 pr-3 text-right">Transferred</th>
                <th className="py-2 pr-3 text-right">ETA</th>
                <th className="py-2 pr-3">Status</th>
              </tr></thead>
              <tbody>
                {replications.map((r) => (
                  <tr key={r.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{r.pd_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.remote_site || '—'}</td>
                    <td className="py-2 pr-3"><ProgressBar pct={r.completed_percentage} paused={r.paused} /></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.completed_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{secsToHuman(r.eta_secs)}</td>
                    <td className="py-2 pr-3">
                      {r.paused ? <Badge tone="warn">Paused</Badge> : r.eta_secs > 86400 ? <Badge tone="warn">Slow</Badge> : <Badge tone="ok">Running</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Globe size={15} className="text-brand" /> Remote Sites</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : remoteSites.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No remote sites configured.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {remoteSites.map((s) => (
                <div key={s.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-ink truncate">{s.name}</p>
                    <p className="text-[11px] text-ink-faint">{s.latency_usecs != null ? `${(s.latency_usecs / 1000).toFixed(1)} ms latency` : 'latency unknown'}</p>
                  </div>
                  <Badge tone={/^(kUseSSHTunnel|connected|Complete|kEnabled)$/i.test(s.status || '') ? 'ok' : 'warn'}>{s.status || 'unknown'}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ClipboardList size={15} className="text-brand" /> Policies</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : policies.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No protection policies found.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {policies.map((p) => (
                <div key={p.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                  <p className="text-sm text-ink truncate">{p.name}</p>
                  <span className="text-[11px] text-ink-faint tnum">RPO {secsToHuman(p.rpo_secs)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          <AlertTriangle size={15} className={nonCompliant ? 'text-status-warn' : 'text-brand'} /> RPO Compliance
        </p>
        <p className="text-[11px] text-ink-faint mb-3">VMs whose latest recovery point is older than their policy's RPO (with grace factor) are flagged non-compliant.</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : rpoCompliance.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No RPO-policy-bound VMs found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">VM</th>
                <th className="py-2 pr-3">Policy</th>
                <th className="py-2 pr-3 text-right">RPO</th>
                <th className="py-2 pr-3">Latest Recovery Point</th>
                <th className="py-2 pr-3 text-right">Age</th>
                <th className="py-2 pr-3">Status</th>
              </tr></thead>
              <tbody>
                {rpoCompliance.map((r, i) => (
                  <tr key={i} className={`border-b border-cohesity-border/50 ${!r.compliant ? 'bg-status-warn/5' : ''}`}>
                    <td className="py-2 pr-3 text-ink">{r.vmName || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.policyName || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{secsToHuman(r.rpoSecs)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{fmtWhen(r.latestRecoveryPoint)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{secsToHuman(r.ageSecs)}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={r.compliant ? 'ok' : 'crit'}>{r.compliant ? 'Compliant' : 'Violation'}</Badge>
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
