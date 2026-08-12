import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gauge, Router, Users, Globe, ShieldAlert, Activity, Server, Zap, Cable, Shield, Wifi, RotateCcw, UserPlus, Clock, ArrowDownUp, Thermometer, Cctv } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CameraSnapshot } from './UnifiProtectPage';
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

const GRADE_COLOR = { A: '#6CB33F', B: '#8FBF4F', C: '#D4A24E', D: '#D4784E', F: '#C75D5D' };

function InsightCard({ icon: Icon, title, onClick, children, tone }) {
  const border = tone === 'warn' ? '#D4A24E' : tone === 'crit' ? '#C75D5D' : BRAND;
  return (
    <div className={`panel p-4 ${onClick ? 'cursor-pointer hover:ring-1 hover:ring-brand/30 transition-all' : ''}`}
      style={{ borderTop: `3px solid ${border}` }} onClick={onClick}>
      <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5">
        <Icon size={13} className="text-brand" /> {title}
      </p>
      {children}
    </div>
  );
}

const Line11 = ({ children, warn }) => (
  <p className={`text-[11px] ${warn ? 'text-status-warn' : 'text-ink-muted'}`}>{children}</p>
);

// Insights band — every card is derived server-side in /unifi/insights from
// data the poller already collects.
function InsightsBand({ insights, navigate, chartOpts }) {
  const { poe, portHealth, wanScores, security24h, wifiCongestion, reboots, newDevices, busiestHour, topTalkers, uplinks, tempTrend } = insights;
  const fmtBytes = (b) => {
    const n = Number(b) || 0;
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
    return `${Math.round(n / 1e3)} KB`;
  };
  const fmtHour = (ts) => { try { return new Date(ts.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ts; } };
  const busiestUplink = (uplinks || []).slice().sort((a, b) => b.utilizationPct - a.utilizationPct)[0] || null;
  const worstWan = (wanScores || []).slice().sort((a, b) => a.score - b.score)[0] || null;
  const congested = (wifiCongestion?.radios24 || []).filter((r) => (r.utilization ?? 0) >= 40);
  const rec = wifiCongestion?.recommendedChannel || null;
  const onRecommended = rec && (wifiCongestion?.radios24 || []).every((r) => r.channel === rec.channel);
  const bands = wifiCongestion?.bandCounts || {};
  const poeTrendData = {
    labels: (poe?.trend || []).map((t) => t.bucket.slice(5)),
    datasets: [{ label: 'PoE W', data: (poe?.trend || []).map((t) => t.watts), borderColor: '#2f81f7', backgroundColor: 'rgba(47,129,247,0.12)', pointRadius: 0, borderWidth: 1.5, tension: 0.3, fill: true }],
  };
  const belowCap = portHealth?.belowCapability || [];
  return (
    <div className="mb-4">
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Gauge size={15} className="text-brand" /> Insights</p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <InsightCard icon={Cable} title="Port Health" onClick={() => navigate('/unifi/ports')}
          tone={portHealth?.errorGrowth24h || portHealth?.flapping24h ? 'warn' : undefined}>
          <p className="text-lg font-semibold text-ink tnum">{portHealth?.up}/{portHealth?.total} <span className="text-xs font-normal text-ink-faint">ports up</span></p>
          <Line11 warn={portHealth?.errorGrowth24h > 0}>{portHealth?.errorGrowth24h || 0} with error growth (24h) · {portHealth?.flapping24h || 0} flapping</Line11>
          {belowCap.length > 0 ? (
            <Line11>{belowCap.length} link{belowCap.length > 1 ? 's' : ''} at 10/100: {belowCap.slice(0, 2).map((p) => `${p.device_name || p.device_mac} p${p.port_idx} @ ${p.speed}Mb`).join(', ')}{belowCap.length > 2 ? '…' : ''} (device limit or cabling)</Line11>
          ) : (
            <Line11>All active GE links at full speed</Line11>
          )}
        </InsightCard>

        <InsightCard icon={Activity} title="WAN Quality (7d)" onClick={() => navigate('/unifi/wan')}
          tone={worstWan && worstWan.score < 70 ? 'warn' : undefined}>
          {worstWan ? (
            <>
              <div className="flex items-center gap-2.5">
                <span className="text-xl font-bold tnum" style={{ color: GRADE_COLOR[worstWan.grade] }}>{worstWan.grade}</span>
                <span className="text-lg font-semibold text-ink tnum">{worstWan.score}<span className="text-xs font-normal text-ink-faint">/100</span></span>
                {wanScores.length > 1 && <span className="text-[10px] text-ink-faint">worst of {wanScores.length} WANs</span>}
              </div>
              <Line11>{worstWan.sourceName}: p95 {worstWan.latencyP95}ms · jitter {worstWan.jitterMs}ms · min avail {worstWan.availabilityMin ?? '—'}%</Line11>
              {busiestUplink && (
                <Line11 warn={busiestUplink.utilizationPct >= 70}>
                  Uplink: {busiestUplink.utilizationPct}% of {busiestUplink.maxMbps >= 1000 ? `${busiestUplink.maxMbps / 1000}G` : `${busiestUplink.maxMbps}M`} pipe in use
                </Line11>
              )}
            </>
          ) : <Line11>Not enough history yet.</Line11>}
        </InsightCard>

        <InsightCard icon={Clock} title="Busiest Hour (24h)" onClick={() => navigate('/unifi/clients')}>
          {busiestHour ? (
            <>
              <p className="text-lg font-semibold text-ink tnum">{busiestHour.peakClients} <span className="text-xs font-normal text-ink-faint">clients at {fmtHour(busiestHour.peakAt)}</span></p>
              <Line11>Now: {busiestHour.clientsNow ?? '—'}{busiestHour.clientsSameTimeYesterday != null ? ` · same time yesterday: ${busiestHour.clientsSameTimeYesterday}` : ''}</Line11>
            </>
          ) : <Line11>Not enough history yet.</Line11>}
        </InsightCard>

        <InsightCard icon={ArrowDownUp} title="Top Talkers" onClick={() => navigate('/unifi/clients')}>
          {(topTalkers || []).length ? (
            <div className="flex flex-col gap-0.5">
              {topTalkers.slice(0, 4).map((t) => (
                <Line11 key={t.label + t.ip}>
                  <span className="text-ink">{t.label}</span> · {fmtBytes(t.bytes)} · {t.is_wired ? 'wired' : 'wifi'}
                </Line11>
              ))}
            </div>
          ) : <Line11>No traffic data.</Line11>}
          <p className="text-[10px] text-ink-faint mt-1">Traffic since each client connected</p>
        </InsightCard>

        <InsightCard icon={Thermometer} title="Temperatures"
          tone={tempTrend?.deltaC != null && tempTrend.deltaC >= 3 ? 'warn' : undefined}>
          {tempTrend ? (
            <>
              <p className="text-lg font-semibold text-ink tnum">{tempTrend.hottestDevice ? `${tempTrend.hottestDevice.tempC.toFixed(0)}°C` : (tempTrend.currentMaxC != null ? `${tempTrend.currentMaxC.toFixed(0)}°C` : '—')}
                <span className="text-xs font-normal text-ink-faint"> hottest{tempTrend.hottestDevice ? ` (${tempTrend.hottestDevice.name} ${tempTrend.hottestDevice.sensor})` : ''}</span></p>
              {tempTrend.deltaC != null ? (
                <Line11 warn={tempTrend.deltaC >= 3}>
                  24h avg {tempTrend.avg24hC}°C — {tempTrend.deltaC > 0 ? `${tempTrend.deltaC}°C hotter` : tempTrend.deltaC < 0 ? `${Math.abs(tempTrend.deltaC)}°C cooler` : 'level'} vs prior week
                </Line11>
              ) : (
                <Line11>Trend accrues as temperature history builds.</Line11>
              )}
            </>
          ) : <Line11>No temperature sensors reported.</Line11>}
        </InsightCard>

        <InsightCard icon={Shield} title="Security (24h)" onClick={() => navigate('/unifi/security')}
          tone={security24h?.ipsDetections ? 'warn' : undefined}>
          <p className="text-lg font-semibold text-ink tnum">{(security24h?.firewallBlocks || 0) + (security24h?.ipsDetections || 0)} <span className="text-xs font-normal text-ink-faint">events</span></p>
          <Line11 warn={security24h?.ipsDetections > 0}>{security24h?.firewallBlocks || 0} firewall blocks · {security24h?.ipsDetections || 0} IPS detections · {security24h?.rogueFlagged || 0} rogue AP{security24h?.rogueFlagged === 1 ? '' : 's'}</Line11>
          {(security24h?.topBlockedSources || []).length > 0 && (
            <Line11>Noisiest: {security24h.topBlockedSources.map((t) => `${t.source} (${t.count})`).join(', ')}</Line11>
          )}
        </InsightCard>

        <InsightCard icon={Wifi} title="WiFi Congestion" onClick={() => navigate('/unifi/wifi')}
          tone={congested.length ? 'warn' : undefined}>
          {congested.length > 0 ? (
            <Line11 warn>2.4 GHz busy: {congested.map((r) => `${r.deviceName} ch${r.channel} @ ${r.utilization}%`).join(', ')}</Line11>
          ) : (
            <Line11>2.4 GHz utilization normal</Line11>
          )}
          {rec && !onRecommended && (
            <Line11>Least-crowded 2.4 channel: <span className="text-ink">ch {rec.channel}</span> ({rec.neighbors} neighboring APs)</Line11>
          )}
          <Line11>Bands: {['2.4 GHz', '5 GHz', '6 GHz'].filter((b) => bands[b]).map((b) => `${bands[b]} on ${b}`).join(' · ') || '—'}</Line11>
        </InsightCard>

        <InsightCard icon={Zap} title="PoE Power" onClick={() => navigate('/unifi/ports')}>
          <p className="text-lg font-semibold text-ink tnum">{poe?.totalWatts ?? 0}W <span className="text-xs font-normal text-ink-faint">delivered now</span></p>
          {(poe?.topPorts || []).length > 0 && (
            <Line11>Top: {poe.topPorts.slice(0, 3).map((p) => `${p.device_name || p.device_mac} p${p.port_idx} ${Number(p.poe_power).toFixed(1)}W`).join(' · ')}</Line11>
          )}
          {(poe?.trend || []).length > 1 && <div className="h-12 mt-1.5"><Line data={poeTrendData} options={{ ...chartOpts, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }} /></div>}
        </InsightCard>

        <InsightCard icon={RotateCcw} title="Recent Reboots & New Devices"
          tone={(reboots || []).length ? 'warn' : undefined}>
          {(reboots || []).length > 0 ? (
            <Line11 warn>Rebooted &lt;30m ago: {reboots.slice(0, 3).map((r) => r.name || r.mac).join(', ')}</Line11>
          ) : (
            <Line11>No recent device reboots</Line11>
          )}
          <div className="flex items-center gap-1.5 mt-1.5">
            <UserPlus size={11} className="text-ink-faint" />
            {(newDevices || []).length > 0 ? (
              <Line11>{newDevices.length} new client{newDevices.length > 1 ? 's' : ''} this week: {newDevices.slice(0, 3).map((n) => n.name || n.mac).join(', ')}{newDevices.length > 3 ? '…' : ''}</Line11>
            ) : (
              <Line11>No new clients this week</Line11>
            )}
          </div>
        </InsightCard>
      </div>
    </div>
  );
}

export default function UnifiOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [cameras, setCameras] = useState([]);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/unifi/overview')
      .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
      .catch(() => {
        setData({ sources: [], deviceCounts: {}, clientCounts: {}, wan: null, health: [], issueCounts: {}, spark: [] });
        toast({ type: 'error', title: 'Failed to load UniFi overview' });
      }),
    client.get('/unifi/insights')
      .then(({ data }) => setInsights(data))
      .catch(() => setInsights(null)),
    client.get('/unifi/protect')
      .then(({ data }) => setCameras((data?.cameras || []).filter((c) => c.model_key !== 'chime')))
      .catch(() => setCameras([])),
  ]), [toast]);

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

      {insights && <InsightsBand insights={insights} navigate={navigate} chartOpts={chartOpts} />}

      {cameras.length > 0 && (
        <div className="mb-4">
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2">
            <Cctv size={15} className="text-brand" /> Cameras
            <Link to="/unifi/protect" className="text-[11px] text-brand font-normal underline ml-auto">View all</Link>
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {cameras.slice(0, 5).map((c) => (
              <div key={c.id} className="min-w-0">
                <CameraSnapshot cameraId={c.camera_id} state={c.state} />
                <p className="text-[10px] text-ink-faint truncate mt-1">{c.name || c.mac}</p>
              </div>
            ))}
          </div>
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
