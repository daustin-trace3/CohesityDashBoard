import { useEffect, useState, useMemo, useCallback } from 'react';
import { Gauge, Server, ClipboardList, ShieldAlert, CheckCircle2, Users, HardDrive, Database, Server as ServerIcon, Box } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, ArcElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, fmtPct, fmtWhen, severityTone, jobStateTone } from './helpers';

const asDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : null);

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Legend);

const NB_COLORS = ['#B1181E', '#0091DA', '#6CB33F', '#D4A24E', '#9B6CD4', '#4ED4B8', '#D46CB3', '#8FA3B0'];

const STATE_COLORS = {
  DONE: '#22C55E', SUCCESSFUL: '#22C55E', SUCCESS: '#22C55E',
  FAILED: '#EF4444', INCOMPLETE: '#EF4444',
  ACTIVE: '#0091DA', RUNNING: '#0091DA',
  QUEUED: '#D4A24E', INITIATED: '#D4A24E', SUSPENDED: '#D4A24E',
};
const stateColor = (state, idx) => STATE_COLORS[String(state).toUpperCase()] || '#8FA3B0';

export default function NbOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState(null);
  const [trend, setTrend] = useState(null);
  const [trendDays, setTrendDays] = useState(30);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/netbackup/overview').then(({ data }) => setData(data)),
    client.get('/netbackup/issues').then(({ data }) => setIssues(data.issues || [])).catch(() => setIssues([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => {
      setData({ sources: [], stats: {}, jobsByState: {}, jobsByPolicyType: {}, recentFailedJobs: [] });
      toast({ type: 'error', title: 'Failed to load NetBackup overview' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    client.get(`/netbackup/trends?days=${trendDays}`).then(({ data }) => setTrend(data.trends || [])).catch(() => setTrend([]));
  }, [trendDays]);

  const successTrend = useMemo(() => {
    if (!trend) return null;
    const names = trend.map(t => t.sourceName);
    const dayset = new Set();
    for (const t of trend) for (const p of t.points || []) dayset.add(String(p.capturedAt).slice(0, 10));
    const days = [...dayset].sort();
    return {
      labels: days,
      datasets: trend.map((t, i) => {
        const byDay = new Map((t.points || []).map(p => [String(p.capturedAt).slice(0, 10), p.successRate]));
        return {
          label: t.sourceName,
          data: days.map(d => byDay.get(d) ?? null),
          borderColor: NB_COLORS[i % NB_COLORS.length],
          backgroundColor: NB_COLORS[i % NB_COLORS.length],
          pointRadius: days.length > 45 ? 0 : 2,
          borderWidth: 2, tension: 0.25, spanGaps: true,
        };
      }),
      names,
    };
  }, [trend]);

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    },
  };

  const stats = data?.stats || {};
  const sources = data?.sources || [];
  const recentFailedJobs = data?.recentFailedJobs || [];
  const jobsByState = data?.jobsByState || {};
  const jobsByPolicyType = data?.jobsByPolicyType || {};
  const openIssues = issues || [];
  const critCount = openIssues.filter(i => i.severity === 'critical').length;
  const storagePct = stats.storageCapacityBytes > 0 ? (stats.storageUsedBytes / stats.storageCapacityBytes) * 100 : null;

  const stateDoughnut = useMemo(() => {
    const entries = Object.entries(jobsByState);
    return {
      labels: entries.map(([k]) => k),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map(([k], i) => stateColor(k, i)),
        borderWidth: 0,
      }],
    };
  }, [jobsByState]);

  const storageDoughnut = useMemo(() => ({
    labels: ['Used', 'Free'],
    datasets: [{
      data: [stats.storageUsedBytes || 0, Math.max(0, (stats.storageCapacityBytes || 0) - (stats.storageUsedBytes || 0))],
      backgroundColor: ['#F59E0B', '#22C55E'],
      borderWidth: 0,
    }],
  }), [stats.storageUsedBytes, stats.storageCapacityBytes]);

  const catalog = data?.catalog || [];

  const policyTypeBar = useMemo(() => {
    const entries = Object.entries(jobsByPolicyType);
    return {
      labels: entries.map(([k]) => k),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map((_, i) => NB_COLORS[i % NB_COLORS.length]),
        borderRadius: 3, barThickness: 16,
      }],
    };
  }, [jobsByPolicyType]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="NetBackup Overview" description="Jobs, policies, storage and appliances across all registered NetBackup sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {sources.length === 0 && data && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No NetBackup sources registered yet. Add one under{' '}
            <Link to="/netbackup/settings" className="text-brand underline">NetBackup → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Server} label="Sources" value={sources.length ? `${sources.filter(s => s.lastPollStatus !== 'error').length} / ${sources.length}` : '—'}
          sub="reachable" tone={sources.some(s => s.lastPollStatus === 'error') ? 'crit' : 'brand'}
          onClick={() => navigate('/netbackup/settings')} />
        <StatCard icon={ClipboardList} label="Jobs (24h)" value={fmtNum(stats.jobs24h)}
          sub={stats.failed24h ? `${fmtNum(stats.failed24h)} failed` : 'no failures'}
          tone={stats.failed24h ? 'warn' : 'ok'}
          onClick={() => navigate('/netbackup/jobs')} />
        <StatCard icon={CheckCircle2} label="Success Rate" value={fmtPct(stats.successRate)}
          tone={stats.successRate != null && stats.successRate < 70 ? 'crit' : stats.successRate != null && stats.successRate < 90 ? 'warn' : 'ok'}
          onClick={() => navigate('/netbackup/jobs')} />
        <StatCard icon={ShieldAlert} label="Active Policies" value={fmtNum(stats.activePolicies)}
          onClick={() => navigate('/netbackup/policies')} />
        <StatCard icon={Users} label="Protected Clients" value={fmtNum(stats.protectedClients)}
          onClick={() => navigate('/netbackup/jobs')} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={HardDrive} label="Storage Used" value={storagePct != null ? `${storagePct.toFixed(1)}%` : '—'}
          sub={stats.storageCapacityBytes ? `${fmtBytes(stats.storageUsedBytes)} of ${fmtBytes(stats.storageCapacityBytes)}` : undefined}
          tone={storagePct > 90 ? 'crit' : storagePct > 80 ? 'warn' : 'default'}
          onClick={() => navigate('/netbackup/storage')} />
        <StatCard icon={ServerIcon} label="Media Servers" value={fmtNum(stats.mediaServerCount)}
          onClick={() => navigate('/netbackup/appliances')} />
        <StatCard icon={Box} label="Appliances" value={fmtNum(stats.applianceCount)}
          onClick={() => navigate('/netbackup/appliances')} />
        <StatCard icon={ShieldAlert} label="Open Issues" value={fmtNum(openIssues.length)}
          sub={openIssues.length ? `${critCount} critical` : 'all clear'}
          tone={critCount ? 'crit' : openIssues.length ? 'warn' : 'ok'}
          onClick={() => navigate('/netbackup/alerts')} />
      </div>

      {/* Trends */}
      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <p className="text-sm font-semibold text-ink mr-auto">Success Rate by Source</p>
            <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))}
              className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </div>
          {trend == null ? (
            <LoadingPanel label="Loading trend…" height={200} />
          ) : !successTrend || successTrend.labels.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No trend data yet — snapshots accumulate as sources poll.</div>
          ) : (
            <div className="h-60"><Line data={successTrend} options={chartOpts} /></div>
          )}
        </div>
        <div className="panel p-4">
          <p className="text-sm font-semibold text-ink mb-3">Storage Used vs Free</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={200} />
          ) : !stats.storageCapacityBytes ? (
            <div className="text-sm text-ink-muted py-8 text-center">No storage capacity data yet.</div>
          ) : (
            <div className="h-52 flex items-center justify-center"><Doughnut data={storageDoughnut} options={{ ...chartOpts, scales: undefined }} /></div>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Jobs by State (24h)</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={180} />
          ) : Object.keys(jobsByState).length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No jobs in the last 24h.</div>
          ) : (
            <div className="h-52 flex items-center justify-center"><Doughnut data={stateDoughnut} options={{ ...chartOpts, scales: undefined }} /></div>
          )}
        </div>
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Jobs by Policy Type (24h)</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={180} />
          ) : Object.keys(jobsByPolicyType).length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No jobs in the last 24h.</div>
          ) : (
            <div className="h-52">
              <Bar data={policyTypeBar} options={{ ...chartOpts, plugins: { legend: { display: false } } }} />
            </div>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Database size={15} className="text-brand" /> NBU Catalog Size</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : catalog.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No catalog data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Domain</th>
                <th className="py-2 pr-3 text-right">Catalog Size</th>
                <th className="py-2 pr-3 text-right">Last Run</th>
              </tr></thead>
              <tbody>
                {catalog.map((c) => (
                  <tr key={c.sourceId} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.sourceName}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(c.catalogBytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint text-[11px]">{fmtWhen(c.lastRunAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent failed jobs + issues */}
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><ClipboardList size={15} className="text-brand" /> Recent Failed Jobs</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : recentFailedJobs.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No recent failures.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
              {recentFailedJobs.map((j) => (
                <div key={j.id} className="flex items-center justify-between gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed truncate">{j.policyName || j.clientName || `Job ${j.jobId}`}</p>
                    <p className="text-[10px] text-ink-faint truncate">{j.clientName}{j.sourceName ? ` · ${j.sourceName}` : ''}</p>
                  </div>
                  <Badge tone={jobStateTone(j)}>{j.state}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Issues</p>
          <p className="text-[11px] text-ink-faint mb-3">
            Job failures, low success rate, low storage headroom, media server issues and stale backups.
          </p>
          {issues == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : openIssues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
              {openIssues.map((i, idx) => (
                <div key={i.issueKey || idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{i.message}</p>
                    <p className="text-[10px] text-ink-faint">{i.host || i.sourceName}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Per-source status */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Sources</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : sources.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {sources.map(s => (
              <div key={s.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{s.name}</p>
                  <p className="text-[11px] text-ink-faint truncate">{s.sourceType === 'alta' ? 'Alta (SaaS)' : 'Primary server'}</p>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                    {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                  </Badge>
                  {s.lastPollAt && (
                    <span className="text-[10px] text-ink-faint whitespace-nowrap" title={asDate(s.lastPollAt).toLocaleString()}>
                      contacted {timeAgo(asDate(s.lastPollAt))}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
