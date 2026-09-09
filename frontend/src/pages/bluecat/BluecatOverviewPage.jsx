import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gauge, Network, Globe, HardDrive, Server, ShieldAlert, Layers, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtPct, fmtWhen, freeStaticTone } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

export default function BluecatOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/bluecat/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => {
      setData({ sources: [], counts: {}, issues: {}, lowSpace: [], trends: [], features: {} });
      toast({ type: 'error', title: 'Failed to load BlueCat overview' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);

  const sources = data?.sources || [];
  const counts = data?.counts || {};
  const issues = data?.issues || {};
  const lowSpace = data?.lowSpace || [];
  const trends = data?.trends || [];

  const critCount = issues.critical || 0;
  const warnCount = issues.warning || 0;
  const infoCount = issues.info || 0;

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    },
  };

  const lowSpaceTrend = useMemo(() => ({
    labels: trends.map((t) => fmtWhen(t.capturedAt).split(',')[0]),
    datasets: [
      {
        label: 'Networks low on space', data: trends.map((t) => t.networksLowSpace),
        borderColor: BRAND, backgroundColor: 'rgba(0,87,184,0.15)',
        pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true,
      },
    ],
  }), [trends]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="BlueCat Overview" description="BlueCat Address Manager IPAM and DNS health across the estate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data && sources.length === 0 && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No Address Managers registered yet. Add one under{' '}
            <button onClick={() => navigate('/bluecat/settings')} className="text-brand underline cursor-pointer">BlueCat → Settings</button> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Layers} label="Views / Zones" value={`${fmtNum(counts.views)} / ${fmtNum(counts.zones)}`} onClick={() => navigate('/bluecat/dns')} />
        <StatCard icon={FileText} label="Records" value={fmtNum(counts.records)} onClick={() => navigate('/bluecat/dns')} />
        <StatCard icon={Network} label="Networks" value={fmtNum(counts.networks)}
          sub={counts.networksLowSpace ? `${fmtNum(counts.networksLowSpace)} low on space` : undefined}
          tone={counts.networksLowSpace ? 'warn' : 'ok'}
          onClick={() => navigate('/bluecat/ipspaces')} />
        <StatCard icon={HardDrive} label="Devices" value={fmtNum(counts.devices)} onClick={() => navigate('/bluecat/devices')} />
        <StatCard icon={Server} label="Servers" value={fmtNum(counts.servers)}
          sub={counts.serversDown ? `${fmtNum(counts.serversDown)} disconnected` : undefined}
          tone={counts.serversDown ? 'crit' : 'ok'}
          onClick={() => navigate('/bluecat/servers')} />
        <StatCard icon={Globe} label="DHCP Ranges Low" value={fmtNum(counts.rangesLowSpace)} onClick={() => navigate('/bluecat/ipspaces')} />
        <StatCard icon={ShieldAlert} label="Open Issues" value={fmtNum(critCount + warnCount + infoCount)}
          sub={critCount ? `${critCount} critical` : warnCount ? `${warnCount} warning` : 'all clear'}
          tone={critCount ? 'crit' : warnCount ? 'warn' : 'ok'}
          onClick={() => navigate('/bluecat/alerts')} />
        <StatCard icon={Server} label="Sources" value={fmtNum(sources.length)}
          sub={counts.sourcesUnreachable ? `${fmtNum(counts.sourcesUnreachable)} unreachable` : undefined}
          tone={counts.sourcesUnreachable ? 'crit' : 'ok'}
          onClick={() => navigate('/bluecat/settings')} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Network size={15} className="text-brand" /> Lowest Free Space</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={160} />
          ) : lowSpace.length === 0 ? (
            <div className="panel p-6 text-sm text-ink-muted text-center">No low-space networks.</div>
          ) : (
            <div className="panel p-3" style={{ borderTop: `3px solid ${BRAND}` }}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-1.5 pr-3">Source</th>
                    <th className="py-1.5 pr-3">Range</th>
                    <th className="py-1.5 pr-3">Name</th>
                    <th className="py-1.5 pr-3 text-right">Free</th>
                    <th className="py-1.5 pr-3 text-right">Free %</th>
                  </tr></thead>
                  <tbody>
                    {lowSpace.map((n) => (
                      <tr key={n.id} className="border-b border-cohesity-border/40 cursor-pointer hover:bg-surface-overlay" onClick={() => navigate('/bluecat/ipspaces')}>
                        <td className="py-1.5 pr-3 text-ink-faint">{n.sourceName}</td>
                        <td className="py-1.5 pr-3 text-ink tnum">{n.range}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{n.name || '—'}</td>
                        <td className="py-1.5 pr-3 text-right tnum"><Badge tone={freeStaticTone(n.freeStatic)}>{fmtNum(n.freeStatic)}</Badge></td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(n.freePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {trends.length > 1 && (
          <div>
            <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Low-space Trend</p>
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <div className="h-48"><Line data={lowSpaceTrend} options={chartOpts} /></div>
            </div>
          </div>
        )}
      </div>

      <div>
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Sources</p>
        {data == null ? (
          <LoadingPanel label="Loading sources…" height={100} />
        ) : sources.length === 0 ? (
          <div className="panel p-6 text-sm text-ink-muted text-center">No sources registered.</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {sources.map((s) => (
              <div key={s.id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{s.name}</p>
                    <p className="text-[11px] text-ink-faint truncate">{s.host}{s.bamVersion ? ` · v${s.bamVersion}` : ''}</p>
                  </div>
                  <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                    {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                  </Badge>
                </div>
                <p className="text-[11px] text-ink-faint mt-2">Last poll: {fmtWhen(s.lastPollAt)}</p>
                <p className="text-[11px] text-ink-faint">Last enumerate: {fmtWhen(s.lastEnumerateAt)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
