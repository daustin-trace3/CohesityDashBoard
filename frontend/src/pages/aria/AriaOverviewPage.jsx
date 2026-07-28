import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Gauge, Boxes, Server, Package, CheckSquare, ShieldAlert, AlertTriangle } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend } from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import ArrangeableSections from '../../components/ui/ArrangeableSections';
import { BRAND, fmtNum, fmtWhen, asDate, severityTone, certTone } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const tickStyle = { color: '#9CA3AF', font: { size: 10 } };
const gridStyle = { color: 'rgba(255,255,255,0.06)' };
const PALETTE = ['#00A2C7', '#6CB33F', '#D4A24E', '#9B6CD4', '#C75D5D'];

export default function AriaOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState(null);
  const [history, setHistory] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/aria/overview').then(({ data }) => setData(data)),
    client.get('/aria/issues').then(({ data }) => setIssues(data)).catch(() => setIssues([])),
    client.get('/aria/metrics-history', { params: { hours: 168 } }).then(({ data }) => setHistory(data)).catch(() => setHistory([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setData({ instances: [], totals: {} }); toast({ type: 'error', title: 'Failed to load Aria overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const instances = data?.instances || [];
  const totals = data?.totals || {};
  const recentVms = data?.recentVms || [];

  const histRows = history || [];
  const times = [...new Set(histRows.map(h => h.captured_at))].sort();
  const instanceIds = [...new Set(histRows.map(h => h.instance_id))];
  const nameFor = (id) => instances.find(i => i.id === id)?.name || `#${id}`;
  const trendData = {
    labels: times.map(t => fmtWhen(t).split(',')[0]),
    datasets: instanceIds.flatMap((id, i) => {
      const color = PALETTE[i % PALETTE.length];
      const rows = histRows.filter(h => h.instance_id === id);
      const at = (t) => rows.find(r => r.captured_at === t);
      return [
        {
          label: `${nameFor(id)} — deployments`, data: times.map(t => at(t)?.deployments_total ?? null),
          borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true,
        },
        {
          label: `${nameFor(id)} — failed requests`, data: times.map(t => at(t)?.requests_24h_failed ?? null),
          borderColor: color, backgroundColor: color, borderDash: [4, 3], borderWidth: 1.5, pointRadius: 0, tension: 0.3, spanGaps: true,
        },
      ];
    }),
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Aria Overview" description="Deployment, request and endpoint health across all registered Aria Automation instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data != null && instances.length === 0 && (
        <div className="panel p-4 mb-4 text-sm text-ink-muted">
          No Aria instances registered yet. Add one under{' '}
          <Link to="/aria/settings" className="text-brand hover:underline">Settings</Link>.
        </div>
      )}

      <ArrangeableSections storageKey="aria-overview-layout" sections={[
        { id: 'stats', label: 'Stat cards', el: (
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Package} label="Deployments" value={fmtNum(totals.deployments)}
          sub={`${fmtNum(totals.deploymentsFailed)} failed · ${fmtNum(totals.leaseExpiring7d)} lease ≤7d`}
          tone={(totals.deploymentsFailed || 0) > 0 ? 'crit' : (totals.leaseExpiring7d || 0) > 0 ? 'warn' : 'ok'} />
        <StatCard icon={Gauge} label="Requests (24h)" value={fmtNum(totals.requests24h)}
          sub={`${fmtNum(totals.requests24hFailed)} failed`}
          tone={(totals.requests24hFailed || 0) > 0 ? 'warn' : 'ok'} />
        <StatCard icon={Server} label="Endpoints" value={fmtNum(totals.endpoints)}
          sub={`${fmtNum(totals.endpointsUnhealthy)} unhealthy`}
          tone={(totals.endpointsUnhealthy || 0) > 0 ? 'crit' : 'ok'} />
        <StatCard icon={CheckSquare} label="Approvals Pending" value={fmtNum(totals.approvalsPending)}
          sub={`${fmtNum(totals.projects)} projects · ${fmtNum(totals.runs24hFailed)} failed runs`}
          tone={(totals.approvalsPending || 0) > 0 ? 'warn' : 'ok'} />
      </div>
        ) },
        { id: 'recent-vms', label: 'Recently Provisioned VMs', el: (
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> Recently Provisioned VMs</p>
        <p className="text-[11px] text-ink-faint mb-3">10 most recent successful builds — VM identity from deployment resources, owning vCenter matched from the vCenter platform inventory.</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={120} />
        ) : recentVms.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No successful deployments with collected machine resources yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">VM Name</th>
                <th className="py-2 pr-3">IP</th>
                <th className="py-2 pr-3">Created By</th>
                <th className="py-2 pr-3">Created</th>
                <th className="py-2 pr-3">Lease</th>
                <th className="py-2 pr-3">vCenter</th>
                <th className="py-2 pr-3">Deployment</th>
              </tr></thead>
              <tbody>
                {recentVms.map((v, i) => (
                  <tr key={`${v.vm_name}|${i}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <Link to={`/ops/server360?name=${encodeURIComponent(v.vm_name)}`} className="text-ink font-medium hover:text-brand" title="Open Server 360">{v.vm_name}</Link>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{(v.ip_addresses || []).join(', ') || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.created_by || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(v.created_at_src)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{v.lease_expire_at ? fmtWhen(v.lease_expire_at) : 'no lease'}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.vcenter || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] max-w-[240px] truncate" title={v.deployment_name || ''}>{v.deployment_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        ) },
        { id: 'inst-attn', label: 'Instances & Attention', el: (
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Boxes size={15} className="text-brand" /> Aria Instances</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : instances.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {instances.map((o) => (
                <div key={o.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${o.reachable ? 'bg-status-ok' : 'bg-status-crit'}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{o.name}</p>
                      <p className="text-[11px] text-ink-faint truncate">{o.host}{o.version ? ` · v${o.version}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <div className="flex items-center gap-1">
                      <Badge tone={o.lastPollStatus === 'error' ? 'crit' : o.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {o.lastPollStatus === 'error' ? 'Unreachable' : o.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {o.certValidTo && <Badge tone={certTone(o.certValidTo)}>Cert</Badge>}
                    </div>
                    {o.lastPollAt && (
                      <span className="text-[10px] text-ink-faint whitespace-nowrap" title={asDate(o.lastPollAt)?.toLocaleString()}>
                        polled {timeAgo(asDate(o.lastPollAt))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Attention</p>
          <p className="text-[11px] text-ink-faint mb-3">Unreachable instances, unhealthy endpoints, failing deployments, expiring leases/certs and pending approvals.</p>
          {issues == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : issues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[300px] overflow-y-auto pr-1">
              {issues.slice(0, 60).map((i, idx) => (
                <button key={idx} onClick={() => navigate('/aria/deployments')}
                  className="flex items-start gap-2 text-left bg-surface-overlay rounded-lg px-3 py-2 hover:bg-surface-overlay/70 cursor-pointer">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <span className="text-xs text-ink-muted leading-relaxed min-w-0">{i.message}<span className="text-ink-faint"> · {i.instance}</span></span>
                </button>
              ))}
              {issues.length > 60 && <p className="text-[11px] text-ink-faint text-center">…and {issues.length - 60} more</p>}
            </div>
          )}
        </div>
      </div>
        ) },
        { id: 'trend', label: 'Deployments & Requests trend', el: (
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><AlertTriangle size={15} className="text-brand" /> Deployments &amp; Failed Requests (7d)</p>
        <p className="text-[11px] text-ink-faint mb-3">Per-instance deployment count (solid) and failed-request count (dashed) over the trailing week.</p>
        {history == null ? <LoadingPanel label="Loading…" height={190} /> : trendData.datasets.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No metrics history yet — appears after the first few polls.</div>
        ) : (
          <div className="h-[220px]">
            <Line data={trendData} options={{
              maintainAspectRatio: false, animation: false,
              plugins: { legend: { position: 'bottom', labels: { color: '#E5E5E5', boxWidth: 10, font: { size: 10 } } } },
              scales: { x: { ticks: tickStyle, grid: { display: false } }, y: { ticks: tickStyle, grid: gridStyle, beginAtZero: true } },
            }} />
          </div>
        )}
      </div>
        ) },
      ]} />
    </div>
  );
}
