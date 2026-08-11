import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gauge, Router, Users, Globe, ShieldAlert, Activity, Server } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const HEALTH_TONE = (status) => (status === 'ok' ? 'ok' : status ? 'warn' : 'neutral');

export default function UnifiOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/unifi/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => {
      setData({ sources: [], deviceCounts: {}, clientCounts: {}, wan: null, health: [], issueCounts: {}, spark: [] });
      toast({ type: 'error', title: 'Failed to load UniFi overview' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);

  const sources = data?.sources || [];
  const deviceCounts = data?.deviceCounts || {};
  const clientCounts = data?.clientCounts || {};
  const wan = data?.wan || null;
  const health = data?.health || [];
  const issueCounts = data?.issueCounts || {};
  const spark = data?.spark || [];

  const critCount = issueCounts.critical || 0;
  const warnCount = issueCounts.warning || 0;

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    },
  };

  const clientsTrend = useMemo(() => ({
    labels: spark.map((s) => fmtWhen(s.capturedAt).split(',')[0]),
    datasets: [
      {
        label: 'Clients', data: spark.map((s) => s.clientsTotal),
        borderColor: BRAND, backgroundColor: 'rgba(0,111,255,0.15)',
        pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true,
      },
    ],
  }), [spark]); // eslint-disable-line react-hooks/exhaustive-deps

  const latencyTrend = useMemo(() => ({
    labels: spark.map((s) => fmtWhen(s.capturedAt).split(',')[0]),
    datasets: [
      {
        label: 'WAN Latency (ms)', data: spark.map((s) => s.wanLatencyMs),
        borderColor: '#D4A24E', backgroundColor: 'rgba(212,162,78,0.12)',
        pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true,
      },
    ],
  }), [spark]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="UniFi Overview" description="Ubiquiti UniFi controllers, devices, clients and WAN health across the estate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data && sources.length === 0 && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No UniFi controllers registered yet. Add one under{' '}
            <button onClick={() => navigate('/unifi/settings')} className="text-brand underline cursor-pointer">UniFi → Settings</button> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Router} label="Devices Online" value={`${fmtNum(deviceCounts.online)} / ${fmtNum(deviceCounts.total)}`}
          tone={deviceCounts.offline ? 'warn' : 'ok'} onClick={() => navigate('/unifi/devices')} />
        <StatCard icon={Users} label="Clients" value={fmtNum(clientCounts.total)}
          sub={`${fmtNum(clientCounts.wired)} wired · ${fmtNum(clientCounts.wireless)} wireless${clientCounts.guest ? ` · ${fmtNum(clientCounts.guest)} guest` : ''}`}
          onClick={() => navigate('/unifi/clients')} />
        <StatCard icon={Globe} label="WAN" value={wan ? (wan.ispName || 'Connected') : '—'}
          sub={wan?.latencyMs != null ? `${wan.latencyMs}ms latency` : undefined}
          tone={wan == null ? 'neutral' : wan.latencyMs > 100 ? 'warn' : 'ok'}
          onClick={() => navigate('/unifi/wan')} />
        <StatCard icon={ShieldAlert} label="Open Issues" value={fmtNum(critCount + warnCount)}
          sub={critCount ? `${critCount} critical` : warnCount ? `${warnCount} warning` : 'all clear'}
          tone={critCount ? 'crit' : warnCount ? 'warn' : 'ok'}
          onClick={() => navigate('/unifi/alerts')} />
        <StatCard icon={Server} label="Sources" value={fmtNum(sources.length)} onClick={() => navigate('/unifi/settings')} />
      </div>

      {health.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {health.map((h) => (
            <Badge key={h.subsystem} tone={HEALTH_TONE(h.status)}>
              {h.subsystem.toUpperCase()}: {h.status}{h.numSta != null ? ` (${h.numSta})` : ''}
            </Badge>
          ))}
        </div>
      )}

      {spark.length > 1 && (
        <div className="grid lg:grid-cols-2 gap-4 mb-4">
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <p className="text-sm font-semibold text-ink mb-2 flex items-center gap-2"><Users size={15} className="text-brand" /> Clients</p>
            <div className="h-48"><Line data={clientsTrend} options={chartOpts} /></div>
          </div>
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <p className="text-sm font-semibold text-ink mb-2 flex items-center gap-2"><Activity size={15} className="text-brand" /> WAN Latency</p>
            <div className="h-48"><Line data={latencyTrend} options={chartOpts} /></div>
          </div>
        </div>
      )}

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
                    <p className="text-[11px] text-ink-faint truncate">{s.host}</p>
                  </div>
                  <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                    {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                  </Badge>
                </div>
                <p className="text-[11px] text-ink-faint mt-2">Last poll: {fmtWhen(s.lastPollAt)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
