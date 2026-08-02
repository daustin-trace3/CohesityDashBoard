import { useEffect, useState, useCallback } from 'react';
import { Container } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

const isDegraded = (s) => s.status === 'ACTIVE' && (s.runningCount ?? 0) < (s.desiredCount ?? 0);

export default function AwsEcsPage() {
  const { toast } = useToast();
  const [clusters, setClusters] = useState(null);
  const [services, setServices] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/aws/ecs')
    .then(({ data }) => { setClusters(data?.clusters || []); setServices(data?.services || []); setLastRefreshed(new Date()); })
    .catch(() => { setClusters([]); setServices([]); toast({ type: 'error', title: 'Failed to load ECS data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const clusterList = clusters || [];
  const clusterCtl = useTableControls(clusterList, {
    searchKeys: ['clusterName', 'account'],
    defaultSortKey: 'clusterName', defaultSortDir: 'asc',
    paginate: true,
  });

  const serviceList = services || [];
  const serviceCtl = useTableControls(serviceList, {
    searchKeys: ['clusterName', 'serviceName', 'launchType', 'account'],
    defaultSortKey: 'serviceName', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Container} title="ECS" description="ECS clusters and services across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Clusters</p>
        <TableControls ctl={clusterCtl} rows={clusterList} searchPlaceholder="Filter by cluster or account…"
          filters={[{ k: 'status', label: 'Statuses' }, { k: 'account', label: 'Accounts' }]} />
        {clusters == null ? (
          <LoadingPanel label="Loading clusters…" height={140} />
        ) : clusterList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ECS clusters found.</div>
        ) : clusterCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No clusters match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="clusterName" label="Cluster" ctl={clusterCtl} />
                <SortTh k="status" label="Status" ctl={clusterCtl} />
                <SortTh k="runningTasks" label="Running Tasks" ctl={clusterCtl} align="right" />
                <SortTh k="pendingTasks" label="Pending Tasks" ctl={clusterCtl} align="right" />
                <SortTh k="serviceCount" label="Services" ctl={clusterCtl} align="right" />
                <SortTh k="containerInstances" label="Container Instances" ctl={clusterCtl} align="right" />
                <SortTh k="account" label="Account" ctl={clusterCtl} />
              </tr></thead>
              <tbody>
                {clusterCtl.pageRows.map((c) => (
                  <tr key={`${c.account}|${c.clusterName}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.clusterName}</td>
                    <td className="py-2 pr-3"><Badge tone={c.status === 'ACTIVE' ? 'ok' : 'neutral'}>{c.status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.runningTasks)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.pendingTasks)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.serviceCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.containerInstances)}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{c.account}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={clusterCtl} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Services</p>
        <TableControls ctl={serviceCtl} rows={serviceList} searchPlaceholder="Filter by service, cluster or account…"
          filters={[{ k: 'status', label: 'Statuses' }, { k: 'launchType', label: 'Launch Types' }, { k: 'account', label: 'Accounts' }]} />
        {services == null ? (
          <LoadingPanel label="Loading services…" height={140} />
        ) : serviceList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ECS services found.</div>
        ) : serviceCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No services match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="serviceName" label="Service" ctl={serviceCtl} />
                <SortTh k="clusterName" label="Cluster" ctl={serviceCtl} />
                <SortTh k="status" label="Status" ctl={serviceCtl} />
                <SortTh k="desiredCount" label="Desired" ctl={serviceCtl} align="right" />
                <SortTh k="runningCount" label="Running" ctl={serviceCtl} align="right" />
                <SortTh k="pendingCount" label="Pending" ctl={serviceCtl} align="right" />
                <SortTh k="launchType" label="Launch Type" ctl={serviceCtl} />
                <SortTh k="cpuUtil" label="CPU" ctl={serviceCtl} align="right" />
                <SortTh k="memoryUtil" label="Memory" ctl={serviceCtl} align="right" />
                <SortTh k="account" label="Account" ctl={serviceCtl} />
              </tr></thead>
              <tbody>
                {serviceCtl.pageRows.map((s) => (
                  <tr key={`${s.account}|${s.clusterName}|${s.serviceName}`}
                    className={`border-b border-cohesity-border/50 ${isDegraded(s) ? 'bg-status-crit/10' : ''}`}>
                    <td className="py-2 pr-3 text-ink">{s.serviceName}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.clusterName}</td>
                    <td className="py-2 pr-3"><Badge tone={isDegraded(s) ? 'crit' : s.status === 'ACTIVE' ? 'ok' : 'neutral'}>{s.status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(s.desiredCount)}</td>
                    <td className={`py-2 pr-3 text-right tnum ${isDegraded(s) ? 'text-status-crit font-semibold' : 'text-ink-muted'}`}>{fmtNum(s.runningCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(s.pendingCount)}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.launchType || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.cpuUtil != null ? `${Number(s.cpuUtil).toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.memoryUtil != null ? `${Number(s.memoryUtil).toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{s.account}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={serviceCtl} />
      </div>
    </div>
  );
}
