import { useEffect, useState, useCallback, useMemo } from 'react';
import { Globe, Activity, MousePointerClick, LayoutGrid, List } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtWhen, secsToHuman } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const Fact = ({ label, value }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
    <p className="text-sm text-ink tnum">{value ?? '—'}</p>
  </div>
);

function durationLabel(startedAt, endedAt) {
  try {
    const ms = new Date(endedAt.replace(' ', 'T') + 'Z') - new Date(startedAt.replace(' ', 'T') + 'Z');
    const min = Math.max(1, Math.round(ms / 60000));
    return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
  } catch { return '—'; }
}

// Derived from metrics history server-side: consecutive degraded samples
// grouped into episodes — the ISP accountability log.
function OutageLog({ outages, multiWan }) {
  if (!outages.length) return null;
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: '3px solid #D4A24E' }}>
      <p className="text-sm font-semibold text-ink mb-2">Outage / Degradation Log (90d)</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            {multiWan && <th className="py-1.5 pr-3">Site</th>}
            <th className="py-1.5 pr-3">Started</th>
            <th className="py-1.5 pr-3">Duration</th>
            <th className="py-1.5 pr-3">Kind</th>
            <th className="py-1.5 pr-3 text-right">Min Availability</th>
            <th className="py-1.5 pr-3 text-right">Max Latency</th>
          </tr></thead>
          <tbody>
            {outages.map((o, i) => (
              <tr key={i} className="border-b border-cohesity-border/40">
                {multiWan && <td className="py-1.5 pr-3 text-ink-muted">{o.sourceName}</td>}
                <td className="py-1.5 pr-3 text-ink tnum">{fmtWhen(o.startedAt)}</td>
                <td className="py-1.5 pr-3 text-ink-muted tnum">{durationLabel(o.startedAt, o.endedAt)}</td>
                <td className="py-1.5 pr-3"><Badge tone={o.kind === 'outage' ? 'crit' : 'warn'}>{o.kind}</Badge></td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{o.minAvailabilityPct != null ? `${o.minAvailabilityPct}%` : '—'}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{o.maxLatencyMs != null ? `${o.maxLatencyMs}ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

// One tile per WAN (a controller with dual-WAN gets two); clicking a tile or
// table row scopes the trend charts to that WAN's source. Density toggle:
// tiles up to TABLE_THRESHOLD WANs, a compact selectable table beyond that
// (12-site fleets stay scannable); the user can switch views either way.
const TABLE_THRESHOLD = 4;

export default function UnifiWanPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [viewPref, setViewPref] = useState(null); // null = auto by count

  const load = useCallback(() => client.get('/unifi/wan')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ wans: [], history: [] }); toast({ type: 'error', title: 'Failed to load WAN data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const wans = data?.wans || [];
  const wanKey = (w) => `${w.source_id}:${w.wan_name || w.id}`;
  const selected = wans.find((w) => wanKey(w) === selectedKey) || wans[0] || null;

  const history = useMemo(() => {
    const all = data?.history || [];
    if (!selected) return all;
    return all.filter((h) => h.sourceId === selected.source_id);
  }, [data, selected]);

  const labels = useMemo(() => history.map((h) => fmtWhen(h.capturedAt)), [history]);
  const latencyChart = useMemo(() => ({
    labels,
    datasets: [{ label: 'Latency (ms)', data: history.map((h) => h.wanLatencyMs), borderColor: '#D4A24E', backgroundColor: 'rgba(212,162,78,0.12)', pointRadius: 0, borderWidth: 2, tension: 0.2, fill: true }],
  }), [history, labels]);
  const availChart = useMemo(() => ({
    labels,
    datasets: [{ label: 'Availability (%)', data: history.map((h) => h.wanAvailabilityPct), borderColor: BRAND, backgroundColor: 'rgba(0,111,255,0.12)', pointRadius: 0, borderWidth: 2, tension: 0.2, fill: true }],
  }), [history, labels]);
  const throughputChart = useMemo(() => ({
    labels,
    datasets: [
      { label: 'RX', data: history.map((h) => h.wanRxRate), borderColor: BRAND, pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      { label: 'TX', data: history.map((h) => h.wanTxRate), borderColor: '#6CB33F', pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
    ],
  }), [history, labels]);

  const chartScope = selected ? `${selected.isp_name || selected.wan_name} — ${selected.source_name}` : '';
  const view = viewPref || (wans.length > TABLE_THRESHOLD ? 'table' : 'tiles');

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Globe} title="WAN / ISP" description="Internet uplink status, ISP identity and throughput trends">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading WAN data…" height={160} />
      ) : wans.length === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">No WAN data collected yet.</div>
      ) : (
        <>
          {wans.length > 1 && (
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-ink-faint flex items-center gap-1.5">
                <MousePointerClick size={12} /> Select a WAN to scope the trend charts below.
              </p>
              <div className="flex items-center gap-1">
                <button onClick={() => setViewPref('tiles')} title="Tile view"
                  className={`flex items-center justify-center h-7 w-7 rounded-md border cursor-pointer ${view === 'tiles' ? 'border-brand/50 text-brand bg-brand/10' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}>
                  <LayoutGrid size={13} />
                </button>
                <button onClick={() => setViewPref('table')} title="Table view"
                  className={`flex items-center justify-center h-7 w-7 rounded-md border cursor-pointer ${view === 'table' ? 'border-brand/50 text-brand bg-brand/10' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}>
                  <List size={13} />
                </button>
              </div>
            </div>
          )}

          {view === 'tiles' ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {wans.map((w) => {
                const isSel = selected && wanKey(w) === wanKey(selected);
                return (
                  <button key={wanKey(w)} onClick={() => setSelectedKey(wanKey(w))}
                    className={`panel p-4 text-left transition-all cursor-pointer ${isSel ? 'ring-2 ring-brand/70' : 'hover:ring-1 hover:ring-brand/30'}`}
                    style={{ borderTop: `3px solid ${isSel ? BRAND : '#3a4048'}` }}>
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{w.isp_name || w.wan_name}</p>
                        <p className="text-[11px] text-ink-faint truncate">{w.source_name}{w.isp_organization ? ` · ${w.isp_organization}` : ''}</p>
                      </div>
                      <Badge tone={w.latency_ms > 75 ? 'warn' : 'ok'}>{w.latency_ms != null ? `${w.latency_ms}ms` : '—'}</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Fact label="ASN" value={w.asn} />
                      <Fact label="WAN IP" value={w.wan_ip} />
                      <Fact label="Gateway" value={w.gateway_ip} />
                      <Fact label="Availability" value={w.availability_pct != null ? `${w.availability_pct}%` : null} />
                      <Fact label="Uptime" value={secsToHuman(w.uptime_sec)} />
                      <Fact label="Uplink" value={[w.uplink_media, w.uplink_speed ? `${w.uplink_speed} Mbps` : null].filter(Boolean).join(' · ') || null} />
                      {w.speedtest_down != null && <Fact label="Speedtest ↓/↑" value={`${w.speedtest_down} / ${w.speedtest_up} Mbps`} />}
                      {w.speedtest_ping != null && <Fact label="Speedtest Ping" value={`${w.speedtest_ping}ms`} />}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Site</th>
                      <th className="py-2 pr-3">ISP</th>
                      <th className="py-2 pr-3">WAN IP</th>
                      <th className="py-2 pr-3 text-right">Latency</th>
                      <th className="py-2 pr-3 text-right">Availability</th>
                      <th className="py-2 pr-3 text-right">Uptime</th>
                      <th className="py-2 pr-3">Uplink</th>
                    </tr></thead>
                    <tbody>
                      {wans.map((w) => {
                        const isSel = selected && wanKey(w) === wanKey(selected);
                        return (
                          <tr key={wanKey(w)} onClick={() => setSelectedKey(wanKey(w))}
                            className={`border-b border-cohesity-border/50 cursor-pointer transition-colors ${isSel ? 'bg-brand/10' : 'hover:bg-surface-overlay'}`}>
                            <td className="py-2 pr-3 text-ink font-medium">{isSel ? <span className="text-brand mr-1.5">›</span> : null}{w.source_name}{w.wan_name && w.wan_name !== 'WAN' ? ` · ${w.wan_name}` : ''}</td>
                            <td className="py-2 pr-3 text-ink-muted">{w.isp_name || '—'}</td>
                            <td className="py-2 pr-3 text-ink-muted tnum">{w.wan_ip || '—'}</td>
                            <td className={`py-2 pr-3 text-right tnum ${w.latency_ms > 75 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{w.latency_ms != null ? `${w.latency_ms}ms` : '—'}</td>
                            <td className={`py-2 pr-3 text-right tnum ${w.availability_pct != null && w.availability_pct < 99 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{w.availability_pct != null ? `${w.availability_pct}%` : '—'}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{secsToHuman(w.uptime_sec) || '—'}</td>
                            <td className="py-2 pr-3 text-ink-faint text-[11px]">{[w.uplink_media, w.uplink_speed ? `${w.uplink_speed} Mbps` : null].filter(Boolean).join(' · ') || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              {selected && (
                <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink truncate">{selected.isp_name || selected.wan_name}</p>
                      <p className="text-[11px] text-ink-faint truncate">{selected.source_name}{selected.isp_organization ? ` · ${selected.isp_organization}` : ''}</p>
                    </div>
                    <Badge tone={selected.latency_ms > 75 ? 'warn' : 'ok'}>{selected.latency_ms != null ? `${selected.latency_ms}ms` : '—'}</Badge>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Fact label="ASN" value={selected.asn} />
                    <Fact label="WAN IP" value={selected.wan_ip} />
                    <Fact label="Gateway" value={selected.gateway_ip} />
                    <Fact label="Availability" value={selected.availability_pct != null ? `${selected.availability_pct}%` : null} />
                    <Fact label="Uptime" value={secsToHuman(selected.uptime_sec)} />
                    <Fact label="Uplink" value={[selected.uplink_media, selected.uplink_speed ? `${selected.uplink_speed} Mbps` : null].filter(Boolean).join(' · ') || null} />
                    {selected.speedtest_down != null && <Fact label="Speedtest ↓/↑" value={`${selected.speedtest_down} / ${selected.speedtest_up} Mbps`} />}
                    {selected.speedtest_ping != null && <Fact label="Speedtest Ping" value={`${selected.speedtest_ping}ms`} />}
                  </div>
                </div>
              )}
            </>
          )}

          <OutageLog outages={(data?.outages || []).filter((o) => !selected || o.sourceId === selected.source_id)} multiWan={wans.length > 1} />

          {history.length > 1 ? (
            <>
              {wans.length > 1 && (
                <p className="text-sm font-semibold text-ink mb-2">Trends — <span className="text-brand">{chartScope}</span></p>
              )}
              <div className="grid lg:grid-cols-3 gap-4">
                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-2 flex items-center gap-2"><Activity size={15} className="text-brand" /> Latency</p>
                  <div className="h-44"><Line data={latencyChart} options={chartOpts} /></div>
                </div>
                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-2">Availability</p>
                  <div className="h-44"><Line data={availChart} options={chartOpts} /></div>
                </div>
                <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-2">Throughput</p>
                  <div className="h-44"><Line data={throughputChart} options={chartOpts} /></div>
                </div>
              </div>
            </>
          ) : (
            <div className="panel p-4 text-sm text-ink-muted text-center">
              {selected ? `No trend history yet for ${chartScope} — charts appear after a few poll cycles.` : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
