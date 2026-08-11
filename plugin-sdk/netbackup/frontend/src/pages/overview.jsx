// NetBackup Overview — ports host frontend/src/pages/netbackup/NbOverviewPage.jsx
// onto the nb- kit. react-chartjs-2 replaced with charts.jsx's Chart.js
// wrappers (window.Chart).
import {
  injectStyles, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo,
  GaugeIcon, ServerIcon, ClipboardIcon, ShieldAlertIcon, CheckCircleIcon, UsersIcon, HardDriveIcon,
  DbIcon, BoxesIcon,
} from '../ui.jsx';
import { LineChart, DoughnutChart, BarChart } from '../charts.jsx';
import { BRAND, fmtNum, fmtBytes, fmtPct, fmtWhen, severityTone, jobStateTone, apiGet } from './helpers.js';

injectStyles();

const NB_COLORS = ['#B1181E', '#0091DA', '#6CB33F', '#D4A24E', '#9B6CD4', '#4ED4B8', '#D46CB3', '#8FA3B0'];
const STATE_COLORS = {
  DONE: '#22C55E', SUCCESSFUL: '#22C55E', SUCCESS: '#22C55E',
  FAILED: '#EF4444', INCOMPLETE: '#EF4444',
  ACTIVE: '#0091DA', RUNNING: '#0091DA',
  QUEUED: '#D4A24E', INITIATED: '#D4A24E', SUSPENDED: '#D4A24E',
};
const stateColor = (state) => STATE_COLORS[String(state).toUpperCase()] || '#8FA3B0';

const asDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : null);

export default function NbOverviewPage() {
  const navigate = ReactRouterDOM.useNavigate();
  const [data, setData] = React.useState(null);
  const [issues, setIssues] = React.useState(null);
  const [trend, setTrend] = React.useState(null);
  const [trendDays, setTrendDays] = React.useState(30);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiGet('/overview').then((d) => setData(d)),
    apiGet('/issues').then((d) => setIssues(d.issues || [])).catch(() => setIssues([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => setData({ sources: [], stats: {}, jobsByState: {}, jobsByPolicyType: {}, recentFailedJobs: [] })),
  []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    apiGet('/trends', { days: trendDays }).then((d) => setTrend(d.trends || [])).catch(() => setTrend([]));
  }, [trendDays]);

  const successTrend = React.useMemo(() => {
    if (!trend) return null;
    const dayset = new Set();
    for (const t of trend) for (const p of t.points || []) dayset.add(String(p.capturedAt).slice(0, 10));
    const days = [...dayset].sort();
    return {
      labels: days,
      series: trend.map((t, i) => {
        const byDay = new Map((t.points || []).map((p) => [String(p.capturedAt).slice(0, 10), p.successRate]));
        return { label: t.sourceName, color: NB_COLORS[i % NB_COLORS.length], points: days.map((d, idx) => ({ x: idx, y: byDay.get(d) ?? null })) };
      }),
    };
  }, [trend]);

  const stats = data?.stats || {};
  const sources = data?.sources || [];
  const recentFailedJobs = data?.recentFailedJobs || [];
  const jobsByState = data?.jobsByState || {};
  const jobsByPolicyType = data?.jobsByPolicyType || {};
  const openIssues = issues || [];
  const critCount = openIssues.filter((i) => i.severity === 'critical').length;
  const storagePct = stats.storageCapacityBytes > 0 ? (stats.storageUsedBytes / stats.storageCapacityBytes) * 100 : null;
  const catalog = data?.catalog || [];

  const stateEntries = Object.entries(jobsByState);
  const policyEntries = Object.entries(jobsByPolicyType);

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={GaugeIcon} title="NetBackup Overview" description="Jobs, policies, storage and appliances across all registered NetBackup sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={!data} />
      </PageHeader>

      {sources.length === 0 && data && (
        <div className="nb-panel" style={{ padding: 16, marginBottom: 16, border: '1px solid rgba(251,191,36,0.4)' }}>
          <p style={{ fontSize: 13, color: 'var(--nb-ink)', margin: 0 }}>
            No NetBackup sources registered yet. Add one under{' '}
            <a onClick={(e) => { e.preventDefault(); navigate('/netbackup/settings'); }} href="/netbackup/settings" style={{ color: 'var(--nb-brand)', textDecoration: 'underline', cursor: 'pointer' }}>
              NetBackup → Settings
            </a> to start polling.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 12 }} className="nb-stat-grid">
        <style>{`@media (min-width: 900px) { .nb-stat-grid { grid-template-columns: repeat(5,1fr) !important; } }`}</style>
        <StatCard icon={ServerIcon} label="Sources" value={sources.length ? `${sources.filter((s) => s.lastPollStatus !== 'error').length} / ${sources.length}` : '—'}
          sub="reachable" tone={sources.some((s) => s.lastPollStatus === 'error') ? 'crit' : 'brand'} onClick={() => navigate('/netbackup/settings')} />
        <StatCard icon={ClipboardIcon} label="Jobs (24h)" value={fmtNum(stats.jobs24h)}
          sub={stats.failed24h ? `${fmtNum(stats.failed24h)} failed` : 'no failures'} tone={stats.failed24h ? 'warn' : 'ok'} onClick={() => navigate('/netbackup/jobs')} />
        <StatCard icon={CheckCircleIcon} label="Success Rate" value={fmtPct(stats.successRate)}
          tone={stats.successRate != null && stats.successRate < 70 ? 'crit' : stats.successRate != null && stats.successRate < 90 ? 'warn' : 'ok'} onClick={() => navigate('/netbackup/jobs')} />
        <StatCard icon={ShieldAlertIcon} label="Active Policies" value={fmtNum(stats.activePolicies)} onClick={() => navigate('/netbackup/policies')} />
        <StatCard icon={UsersIcon} label="Protected Clients" value={fmtNum(stats.protectedClients)} onClick={() => navigate('/netbackup/jobs')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }} className="nb-stat-grid2">
        <style>{`@media (min-width: 900px) { .nb-stat-grid2 { grid-template-columns: repeat(4,1fr) !important; } }`}</style>
        <StatCard icon={HardDriveIcon} label="Storage Used" value={storagePct != null ? `${storagePct.toFixed(1)}%` : '—'}
          sub={stats.storageCapacityBytes ? `${fmtBytes(stats.storageUsedBytes)} of ${fmtBytes(stats.storageCapacityBytes)}` : undefined}
          tone={storagePct > 90 ? 'crit' : storagePct > 80 ? 'warn' : 'default'} onClick={() => navigate('/netbackup/storage')} />
        <StatCard icon={ServerIcon} label="Media Servers" value={fmtNum(stats.mediaServerCount)} onClick={() => navigate('/netbackup/appliances')} />
        <StatCard icon={BoxesIcon} label="Appliances" value={fmtNum(stats.applianceCount)} onClick={() => navigate('/netbackup/appliances')} />
        <StatCard icon={ShieldAlertIcon} label="Open Issues" value={fmtNum(openIssues.length)}
          sub={openIssues.length ? `${critCount} critical` : 'all clear'} tone={critCount ? 'crit' : openIssues.length ? 'warn' : 'ok'} onClick={() => navigate('/netbackup/alerts')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="nb-trend-row">
        <style>{`@media (min-width: 1024px) { .nb-trend-row { grid-template-columns: 2fr 1fr !important; } }`}</style>
        <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', margin: 0, marginRight: 'auto' }}>Success Rate by Source</p>
            <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </div>
          {trend == null ? (
            <LoadingPanel label="Loading trend…" height={200} />
          ) : !successTrend || successTrend.labels.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No trend data yet — snapshots accumulate as sources poll.</div>
          ) : (
            <LineChart series={successTrend.series} xLabels={successTrend.labels} height={220} yFmt={(v) => `${Math.round(v)}%`} />
          )}
        </div>
        <div className="nb-panel" style={{ padding: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Storage Used vs Free</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={200} />
          ) : !stats.storageCapacityBytes ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No storage capacity data yet.</div>
          ) : (
            <DoughnutChart labels={['Used', 'Free']} values={[stats.storageUsedBytes || 0, Math.max(0, (stats.storageCapacityBytes || 0) - (stats.storageUsedBytes || 0))]} colors={['#F59E0B', '#22C55E']} height={200} legend={false} />
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="nb-two-col">
        <style>{`@media (min-width: 1024px) { .nb-two-col { grid-template-columns: 1fr 1fr !important; } }`}</style>
        <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Jobs by State (24h)</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={180} />
          ) : stateEntries.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No jobs in the last 24h.</div>
          ) : (
            <DoughnutChart labels={stateEntries.map(([k]) => k)} values={stateEntries.map(([, v]) => v)} colors={stateEntries.map(([k]) => stateColor(k))} height={200} legend />
          )}
        </div>
        <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Jobs by Policy Type (24h)</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={180} />
          ) : policyEntries.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No jobs in the last 24h.</div>
          ) : (
            <BarChart labels={policyEntries.map(([k]) => k)} values={policyEntries.map(([, v]) => v)} colors={policyEntries.map((_, i) => NB_COLORS[i % NB_COLORS.length])} height={200} />
          )}
        </div>
      </div>

      <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <DbIcon size={15} style={{ color: 'var(--nb-brand)' }} /> NBU Catalog Size
        </p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : catalog.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No catalog data yet.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Domain</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Catalog Size</th>
                <th style={{ padding: '8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Last Run</th>
              </tr></thead>
              <tbody>
                {catalog.map((c) => (
                  <tr key={c.sourceId} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>{c.sourceName}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtBytes(c.catalogBytes)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--nb-ink-faint)', fontSize: 11 }}>{fmtWhen(c.lastRunAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="nb-two-col">
        <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClipboardIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Recent Failed Jobs
          </p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : recentFailedJobs.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ok)', padding: '24px 0', textAlign: 'center' }}>No recent failures.</div>
          ) : (
            <div className="nb-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '45vh', overflowY: 'auto', paddingRight: 4 }}>
              {recentFailedJobs.map((j) => (
                <div key={j.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'var(--nb-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 12, color: 'var(--nb-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.policyName || j.clientName || `Job ${j.jobId}`}</p>
                    <p style={{ fontSize: 10, color: 'var(--nb-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.clientName}{j.sourceName ? ` · ${j.sourceName}` : ''}</p>
                  </div>
                  <Badge tone={jobStateTone(j)}>{j.state}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldAlertIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Issues
          </p>
          <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginBottom: 12 }}>Job failures, low success rate, low storage headroom, media server issues and stale backups.</p>
          {issues == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : openIssues.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ok)', padding: '24px 0', textAlign: 'center' }}>No issues detected.</div>
          ) : (
            <div className="nb-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '45vh', overflowY: 'auto', paddingRight: 4 }}>
              {openIssues.map((i, idx) => (
                <div key={i.issueKey || idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--nb-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 12, color: 'var(--nb-ink)', margin: 0, lineHeight: 1.5 }}>{i.message}</p>
                    <p style={{ fontSize: 10, color: 'var(--nb-ink-faint)', margin: 0 }}>{i.host || i.sourceName}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Sources</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : sources.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>None registered.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sources.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--nb-surface-overlay)', borderRadius: 8, padding: '8px 12px' }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--nb-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</p>
                  <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.sourceType === 'alta' ? 'Alta (SaaS)' : 'Primary server'}</p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                  <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                    {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                  </Badge>
                  {s.lastPollAt && (
                    <span title={fmtWhen(s.lastPollAt)} style={{ fontSize: 10, color: 'var(--nb-ink-faint)', whiteSpace: 'nowrap' }}>contacted {timeAgo(asDate(s.lastPollAt))}</span>
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
