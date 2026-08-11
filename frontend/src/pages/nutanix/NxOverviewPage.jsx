import { useEffect, useState, useCallback } from 'react';
import { Gauge, Server, MonitorSmartphone, Database, ShieldAlert, Activity } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, fmtRatio, usageTone, severityTone, ftTone, ftLabel } from './helpers';

export default function NxOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ totals: {}, clusters: [], issues: [] }); toast({ type: 'error', title: 'Failed to load Nutanix overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const totals = data?.totals || {};
  const clusters = data?.clusters || [];
  const issues = data?.issues || [];
  const storagePct = totals.storageCapacityBytes > 0 ? (totals.storageUsageBytes / totals.storageCapacityBytes) * 100 : null;
  const critCount = totals.criticalAlerts || 0;
  const warnCount = totals.warningAlerts || 0;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Nutanix Overview" description="Prism Central and Prism Element clusters registered across the estate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data && totals.sources === 0 && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No Nutanix sources registered yet. Add one under{' '}
            <Link to="/nutanix/settings" className="text-brand underline">Nutanix → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <StatCard icon={Server} label="Sources" value={fmtNum(totals.sources)} onClick={() => navigate('/nutanix/settings')} />
        <StatCard icon={Server} label="Clusters" value={fmtNum(totals.clusters)} onClick={() => navigate('/nutanix/clusters')} />
        <StatCard icon={Server} label="Hosts" value={fmtNum(totals.hosts)} onClick={() => navigate('/nutanix/hosts')} />
        <StatCard icon={MonitorSmartphone} label="VMs" value={fmtNum(totals.vms)} onClick={() => navigate('/nutanix/vms')} />
        <StatCard icon={Database} label="Storage Used" value={storagePct != null ? `${storagePct.toFixed(1)}%` : '—'}
          sub={totals.storageCapacityBytes ? `${fmtBytes(totals.storageUsageBytes)} of ${fmtBytes(totals.storageCapacityBytes)}` : undefined}
          tone={usageTone(storagePct)} onClick={() => navigate('/nutanix/storage')} />
        <StatCard icon={ShieldAlert} label="Alerts" value={fmtNum(critCount + warnCount)}
          sub={critCount ? `${critCount} critical` : warnCount ? `${warnCount} warning` : 'all clear'}
          tone={critCount ? 'crit' : warnCount ? 'warn' : 'ok'}
          onClick={() => navigate('/nutanix/alerts')} />
      </div>

      {totals.unprotectedVms > 0 && (
        <div className="panel p-3 mb-4 border border-status-warn/40 flex items-center gap-2">
          <ShieldAlert size={14} className="text-status-warn flex-shrink-0" />
          <p className="text-sm text-ink">{fmtNum(totals.unprotectedVms)} VM(s) have no protection domain.</p>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Clusters</p>
          {data == null ? (
            <LoadingPanel label="Loading clusters…" height={160} />
          ) : clusters.length === 0 ? (
            <div className="panel p-6 text-sm text-ink-muted text-center">No clusters found.</div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {clusters.map((c) => {
                const usedPct = c.storage_capacity_bytes > 0 ? (c.storage_usage_bytes / c.storage_capacity_bytes) * 100 : null;
                const barColor = usedPct > 90 ? '#C75D5D' : usedPct > 80 ? '#D4A24E' : BRAND;
                return (
                  <div key={c.id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{c.name || c.uuid}</p>
                        <p className="text-[11px] text-ink-faint truncate">{c.source_name}{c.aos_version ? ` · AOS ${c.aos_version}` : ''}</p>
                      </div>
                      <Badge tone={ftTone(c)}>{ftLabel(c)}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-full h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, usedPct || 0)}%`, backgroundColor: barColor }} />
                      </div>
                      <span className="text-xs tnum text-ink-muted whitespace-nowrap">{usedPct != null ? `${usedPct.toFixed(0)}%` : '—'}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint mt-2">
                      <span>{fmtNum(c.num_nodes)} node{c.num_nodes === 1 ? '' : 's'}</span>
                      <span>Reduction {fmtRatio(c.overall_reduction_ratio_ppm ?? c.reduction_ratio_ppm)}</span>
                      {c.runway_days != null && (
                        <Badge tone={c.runway_days < 90 ? 'warn' : 'neutral'}>{c.runway_days}d runway</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Activity size={15} className="text-brand" /> Top Issues</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto pr-1">
              {issues.map((i, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{i.message}</p>
                    <p className="text-[10px] text-ink-faint">{i.source}{i.target ? ` · ${i.target}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
