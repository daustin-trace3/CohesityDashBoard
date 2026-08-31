import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Gauge, Waypoints, Router, Cable, HardDrive, ShieldAlert, Server, Network, AlertTriangle,
} from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen, statusTone, severityTone, scoreColor } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

export default function BrocadeOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [fabrics, setFabrics] = useState([]);
  const [events, setEvents] = useState([]);
  const [trends, setTrends] = useState([]);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/brocade/overview')
      .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
      .catch(() => {
        setData({ sources: {}, fabrics: {}, switches: {}, ports: {}, devicePorts: {}, enclosures: {}, zoning: {}, events: {}, health: {}, issues: {} });
        toast({ type: 'error', title: 'Failed to load Brocade overview' });
      }),
    client.get('/brocade/fabrics').then(({ data }) => setFabrics(data.fabrics || [])).catch(() => setFabrics([])),
    client.get('/brocade/events', { params: { severity: 'critical', hours: 24, limit: 8 } })
      .then(({ data }) => setEvents(data.events || [])).catch(() => setEvents([])),
    client.get('/brocade/trends', { params: { hours: 24 } }).then(({ data }) => setTrends(data.metrics || [])).catch(() => setTrends([])),
  ]), [toast]);

  useEffect(() => { load(); }, [load]);

  const sources = data?.sources || {};
  const fabricStats = data?.fabrics || {};
  const switches = data?.switches || {};
  const ports = data?.ports || {};
  const devicePorts = data?.devicePorts || {};
  const zoning = data?.zoning || {};
  const health = data?.health || {};
  const issues = data?.issues || {};

  const critCount = issues.critical || 0;
  const warnCount = issues.warning || 0;

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    },
  };

  const portsOnlineTrend = useMemo(() => ({
    labels: trends.map((t) => fmtWhen(t.ts).split(',')[0]),
    datasets: [{
      label: 'Ports online', data: trends.map((t) => t.portsOnline),
      borderColor: BRAND, backgroundColor: 'rgba(204,9,47,0.15)',
      pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true,
    }],
  }), [trends]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Brocade SAN Overview" description="Brocade fabrics, switches and SAN health across SANnav-managed estates">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data && (sources.total || 0) === 0 && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No SANnav servers registered yet. Add one under{' '}
            <button onClick={() => navigate('/brocade/settings')} className="text-brand underline cursor-pointer">Brocade SAN → Settings</button> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Waypoints} label="Fabrics" value={`${fmtNum(fabricStats.healthy)} / ${fmtNum(fabricStats.total)}`}
          sub="healthy" tone={fabricStats.total - (fabricStats.healthy || 0) > 0 ? 'warn' : 'ok'}
          onClick={() => navigate('/brocade/fabrics')} />
        <StatCard icon={Router} label="Switches" value={`${fmtNum(switches.healthy)} / ${fmtNum(switches.total)}`}
          sub={`${fmtNum(switches.critical)} critical · ${fmtNum(switches.unreachable)} unreachable`}
          tone={switches.critical || switches.unreachable ? 'crit' : switches.marginal ? 'warn' : 'ok'}
          onClick={() => navigate('/brocade/switches')} />
        <StatCard icon={Cable} label="Ports Online" value={`${fmtNum(ports.online)} / ${fmtNum(ports.total)}`}
          sub={`${fmtNum(ports.error)} in error`} tone={ports.error ? 'warn' : 'ok'}
          onClick={() => navigate('/brocade/ports')} />
        <StatCard icon={HardDrive} label="Devices" value={fmtNum(devicePorts.total)}
          sub={`${fmtNum(devicePorts.hosts)} hosts · ${fmtNum(devicePorts.storage)} storage`}
          onClick={() => navigate('/brocade/devices')} />
        <StatCard icon={ShieldAlert} label="Open Issues" value={fmtNum(critCount + warnCount)}
          sub={critCount ? `${critCount} critical` : warnCount ? `${warnCount} warning` : 'all clear'}
          tone={critCount ? 'crit' : warnCount ? 'warn' : 'ok'}
          onClick={() => navigate('/brocade/issues')} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Waypoints size={15} className="text-brand" /> Fabric Health</p>
          {data == null ? (
            <LoadingPanel label="Loading fabrics…" height={140} />
          ) : fabrics.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No fabrics discovered yet.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
              {fabrics.map((f) => (
                <button key={f.id} onClick={() => navigate('/brocade/fabrics')}
                  className="flex items-center justify-between gap-3 text-xs bg-surface-overlay rounded-lg px-3 py-2 hover:ring-1 hover:ring-brand/30 transition-all cursor-pointer text-left">
                  <div className="min-w-0 flex items-center gap-2">
                    <Badge tone={statusTone(f.statusLabel)}>{f.statusLabel || 'Unknown'}</Badge>
                    <span className="text-ink truncate">{f.name}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-ink-faint tnum">{f.switchCount ?? '—'} switches</span>
                    {f.score != null && <span className="tnum font-semibold" style={{ color: scoreColor(f.score) }}>{f.score}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Network size={15} className="text-brand" /> Zoning Summary</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint">Zones</p>
              <p className="text-lg font-semibold text-ink tnum">{fmtNum(zoning.zones)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint">Aliases</p>
              <p className="text-lg font-semibold text-ink tnum">{fmtNum(zoning.aliases)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint">Configs</p>
              <p className="text-lg font-semibold text-ink tnum">{fmtNum(zoning.configs)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint">Changes (24h)</p>
              <p className={`text-lg font-semibold tnum ${zoning.recentChanges24h ? 'text-status-warn' : 'text-ink'}`}>{fmtNum(zoning.recentChanges24h)}</p>
            </div>
          </div>
          <button onClick={() => navigate('/brocade/zoning')} className="text-[11px] text-brand underline mt-3 cursor-pointer">Open Zoning →</button>

          <div className="mt-4 pt-3 border-t border-cohesity-border">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Fabric Health Score</p>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold tnum" style={{ color: scoreColor(health.avgFabricScore) }}>{health.avgFabricScore ?? '—'}</span>
              <span className="text-[11px] text-ink-faint">avg · min {health.minFabricScore ?? '—'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><AlertTriangle size={15} className="text-brand" /> Recent Critical Events</p>
          {events.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No critical events in the last 24h.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {events.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 text-xs bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <Badge tone={severityTone(e.severityNorm)}>{e.severity}</Badge>
                    <span className="text-ink truncate">{e.description || e.messageId}</span>
                  </div>
                  <span className="text-ink-faint tnum shrink-0">{fmtWhen(e.lastOccurredMs)}</span>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => navigate('/brocade/events')} className="text-[11px] text-brand underline mt-3 cursor-pointer">Open Events →</button>
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Ports Online (24h)</p>
          {trends.length > 1 ? (
            <div className="h-48"><Line data={portsOnlineTrend} options={chartOpts} /></div>
          ) : (
            <div className="text-sm text-ink-muted py-10 text-center">Not enough history yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
