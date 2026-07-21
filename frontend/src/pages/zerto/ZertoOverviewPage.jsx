import { useEffect, useState, useMemo, useCallback } from 'react';
import { Gauge, Globe2, ShieldCheck, MonitorSmartphone, Bell, AlertTriangle, HardDrive, Boxes, History } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend,
} from 'chart.js';
import { Link, useNavigate } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtMb, fmtRpo, healthTone } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const TREND_METRICS = [
  { k: 'vpgs', label: 'VPGs by health' },
  { k: 'rpo', label: 'Average RPO (seconds)' },
  { k: 'alerts', label: 'Alert count' },
];

export default function ZertoOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [trend, setTrend] = useState(null);
  const [trendMetric, setTrendMetric] = useState('vpgs');
  const [trendDays, setTrendDays] = useState(30);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => client.get('/zerto/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ snapshot: null, vpgHealth: [], alertSeverity: [], worstRpoVpgs: [] }); toast({ type: 'error', title: 'Failed to load Zerto overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    client.get(`/zerto/trends?days=${trendDays}`).then(({ data }) => setTrend(data)).catch(() => setTrend([]));
  }, [trendDays]);

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      await client.post('/zerto/refresh', {}, { timeout: 180000 });
      await load();
      client.get(`/zerto/trends?days=${trendDays}`).then(({ data }) => setTrend(data)).catch(() => {});
      toast({ type: 'success', title: 'Zerto data refreshed' });
    } catch (err) {
      toast({ type: 'error', title: 'Refresh failed', message: err?.response?.data?.error });
    } finally {
      setRefreshing(false);
    }
  };

  const snap = data?.snapshot;
  const healthOf = (h) => (data?.vpgHealth || []).find(x => x.health === h)?.count || 0;
  const sevOf = (s) => (data?.alertSeverity || []).find(x => x.severity === s)?.count || 0;
  const alertErrors = sevOf('Error');
  const alertWarnings = sevOf('Warning');

  const trendChart = useMemo(() => {
    if (!trend) return null;
    const labels = trend.map(t => String(t.captured_at).slice(5, 16));
    const mk = (label, key, color) => ({
      label, data: trend.map(t => t[key]), borderColor: color, backgroundColor: color,
      pointRadius: 0, borderWidth: 2, tension: 0.25, spanGaps: true,
    });
    if (trendMetric === 'rpo') return { labels, datasets: [mk('Avg RPO (s)', 'avg_actual_rpo', BRAND)] };
    if (trendMetric === 'alerts') return { labels, datasets: [mk('Alerts', 'alerts_count', '#D4A24E')] };
    return {
      labels,
      datasets: [
        mk('Healthy', 'healthy_vpgs', '#6CB33F'),
        mk('Warning', 'warned_vpgs', '#D4A24E'),
        mk('Error', 'erroneous_vpgs', '#C75D5D'),
      ],
    };
  }, [trend, trendMetric]);

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    },
  };

  const selectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Zerto Overview" description="Disaster recovery health across all sites — Zerto Analytics">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={forceRefresh} refreshing={refreshing} />
      </PageHeader>

      {data && !data.configured && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            Zerto Analytics credentials are not configured yet. Add them under{' '}
            <Link to="/zerto/settings" className="text-brand underline">Zerto → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
        <StatCard icon={Globe2} label="Sites" value={snap ? `${fmtNum(snap.connected_sites_count)} / ${fmtNum(snap.sites_count)}` : '—'} sub="connected to Analytics" tone="brand"
          onClick={() => navigate('/zerto/sites')} />
        <StatCard icon={ShieldCheck} label="VPGs" value={fmtNum(snap?.vpgs_count)} sub={data?.zorgCount ? `across ${fmtNum(data.zorgCount)} ZORG${data.zorgCount === 1 ? '' : 's'}` : undefined}
          onClick={() => navigate('/zerto/vpgs')} />
        <StatCard icon={ShieldCheck} label="Healthy VPGs" value={fmtNum(snap?.healthy_vpgs)} tone={snap && snap.healthy_vpgs === snap.vpgs_count ? 'ok' : 'warn'}
          sub={snap && snap.healthy_vpgs !== snap.vpgs_count ? `${fmtNum((snap.vpgs_count || 0) - (snap.healthy_vpgs || 0))} degraded` : 'all healthy'}
          onClick={() => navigate('/zerto/vpgs')} />
        <StatCard icon={MonitorSmartphone} label="Protected VMs" value={fmtNum(snap?.vms_count)} onClick={() => navigate('/zerto/vms')} />
        <StatCard icon={Bell} label="Active Alerts" value={fmtNum(snap?.alerts_count)}
          tone={alertErrors ? 'crit' : snap?.alerts_count ? 'warn' : 'ok'}
          sub={snap?.alerts_count ? `${fmtNum(alertErrors)} error${alertErrors === 1 ? '' : 's'} · ${fmtNum(alertWarnings)} warning${alertWarnings === 1 ? '' : 's'}` : 'none'}
          onClick={() => navigate('/zerto/alerts')} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="RPO SLA Breaches" value={fmtNum(data?.rpoBreaches)}
          tone={data?.rpoBreaches ? 'crit' : 'ok'} sub="VPGs over their configured RPO"
          onClick={() => navigate('/zerto/vpgs')} />
        <StatCard icon={History} label="Journal Breaches" value={fmtNum(data?.journalBreaches)}
          tone={data?.journalBreaches ? 'warn' : 'ok'} sub="VPGs under configured journal history"
          onClick={() => navigate('/zerto/vpgs')} />
        <StatCard icon={HardDrive} label="Protected Storage" value={fmtMb(snap?.used_storage_mb)}
          sub={snap?.provisioned_storage_mb ? `of ${fmtMb(snap.provisioned_storage_mb)} provisioned` : undefined}
          onClick={() => navigate('/zerto/vms')} />
        <StatCard icon={Boxes} label="VRA Appliances" value={fmtNum(data?.vraCount)} sub="virtual replication appliances"
          onClick={() => navigate('/zerto/sites')} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <p className="text-sm font-semibold text-ink mr-auto">Trend</p>
            <select value={trendMetric} onChange={(e) => setTrendMetric(e.target.value)} className={selectCls}>
              {TREND_METRICS.map(m => <option key={m.k} value={m.k}>{m.label}</option>)}
            </select>
            <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))} className={selectCls}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </div>
          {trend == null ? (
            <LoadingPanel label="Loading trend…" height={200} />
          ) : trend.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No trend data yet — snapshots accumulate as the poller runs.</div>
          ) : (
            <div className="h-60"><Line data={trendChart} options={chartOpts} /></div>
          )}
        </div>
        <div className="panel p-4">
          <p className="text-sm font-semibold text-ink mb-3">VPG Health</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={120} />
          ) : (
            <div className="flex flex-col gap-2">
              {['Healthy', 'Warning', 'Error'].map(h => (
                <div key={h} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={healthTone(h)}>{h}</Badge>
                  <span className="text-sm font-semibold text-ink tnum">{fmtNum(healthOf(h))}</span>
                </div>
              ))}
              <p className="text-[11px] text-ink-faint mt-1">Average actual RPO: <span className="tnum text-ink-muted">{snap?.avg_actual_rpo != null ? fmtRpo(Math.round(snap.avg_actual_rpo)) : '—'}</span></p>
            </div>
          )}
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1">Highest RPO VPGs</p>
        <p className="text-[11px] text-ink-faint mb-3">The 10 VPGs currently furthest from their checkpoint — highest actual RPO first.</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={120} />
        ) : (data.worstRpoVpgs || []).length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VPG data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">VPG</th>
                <th className="py-2 pr-3">Protected Site</th>
                <th className="py-2 pr-3">Recovery Site</th>
                <th className="py-2 pr-3">Health</th>
                <th className="py-2 pr-3 text-right">Actual RPO</th>
                <th className="py-2 pr-3 text-right">Configured RPO</th>
              </tr></thead>
              <tbody>
                {data.worstRpoVpgs.map((v) => (
                  <tr key={v.name} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{v.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.protected_site || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.recovery_site || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(v.health)}>{v.health || '—'}</Badge></td>
                    <td className={`py-2 pr-3 text-right tnum ${v.configured_rpo && v.actual_rpo > v.configured_rpo ? 'text-status-crit font-semibold' : 'text-ink'}`}>{fmtRpo(v.actual_rpo)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtRpo(v.configured_rpo)}</td>
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
