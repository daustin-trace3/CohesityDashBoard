import { useEffect, useState, useCallback } from 'react';
import { Gauge, Server, MonitorSmartphone, Database, ShieldAlert, Boxes } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, severityTone } from './helpers';

export default function VcOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/vcenter/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ vcenters: [], hosts: {}, datastores: {}, issues: [] }); toast({ type: 'error', title: 'Failed to load vCenter overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const vcs = data?.vcenters || [];
  const hosts = data?.hosts || {};
  const ds = data?.datastores || {};
  const issues = data?.issues || [];
  const dsUsedPct = ds.capacity > 0 ? ((ds.capacity - ds.free) / ds.capacity) * 100 : null;
  const critCount = issues.filter(i => i.severity === 'critical').length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="vCenter Overview" description="ESX hosts, clusters, datastores and certificates across all registered vCenters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {vcs.length === 0 && data && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No vCenters registered yet. Add one under{' '}
            <Link to="/vcenter/settings" className="text-brand underline">vCenter → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Server} label="vCenters" value={vcs.length ? `${vcs.filter(v => v.lastPollStatus !== 'error').length} / ${vcs.length}` : '—'}
          sub="reachable" tone={vcs.some(v => v.lastPollStatus === 'error') ? 'crit' : 'brand'}
          onClick={() => navigate('/vcenter/settings')} />
        <StatCard icon={Server} label="ESX Hosts" value={hosts.total != null ? `${fmtNum(hosts.connected)} / ${fmtNum(hosts.total)}` : '—'}
          sub={hosts.maintenance ? `up · ${fmtNum(hosts.maintenance)} in maintenance` : 'up'}
          tone={hosts.total && hosts.connected < hosts.total ? 'warn' : 'ok'}
          onClick={() => navigate('/vcenter/hosts')} />
        <StatCard icon={MonitorSmartphone} label="VMs" value={fmtNum(hosts.vms)} sub="across all hosts"
          onClick={() => navigate('/vcenter/hosts')} />
        <StatCard icon={Database} label="Datastore Usage" value={dsUsedPct != null ? `${dsUsedPct.toFixed(1)}%` : '—'}
          sub={ds.capacity ? `${fmtBytes(ds.capacity - ds.free)} of ${fmtBytes(ds.capacity)}` : undefined}
          tone={dsUsedPct > 80 ? 'crit' : dsUsedPct > 70 ? 'warn' : 'default'}
          onClick={() => navigate('/vcenter/datastores')} />
        <StatCard icon={ShieldAlert} label="Issues" value={fmtNum(issues.length)}
          sub={issues.length ? `${critCount} critical` : 'all clear'}
          tone={critCount ? 'crit' : issues.length ? 'warn' : 'ok'} />
      </div>

      {/* Per-vCenter status */}
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Boxes size={15} className="text-brand" /> vCenters</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : vcs.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {vcs.map(v => (
                <div key={v.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{v.name}</p>
                    <p className="text-[11px] text-ink-faint truncate">{v.host}</p>
                  </div>
                  <Badge tone={v.lastPollStatus === 'error' ? 'crit' : v.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                    {v.lastPollStatus === 'error' ? 'Unreachable' : v.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Issues feed */}
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Issues</p>
          <p className="text-[11px] text-ink-faint mb-3">
            Hosts down, datastores over {data?.thresholds?.dsUsedWarnPct ?? 80}%, clusters under {data?.thresholds?.clusterFreeWarnPct ?? 20}% headroom, certificates within {data?.thresholds?.certWarnDays ?? 60} days of expiry.
          </p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
              {issues.map((i, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{i.message}</p>
                    <p className="text-[10px] text-ink-faint">{i.vcenter}</p>
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
