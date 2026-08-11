import { useEffect, useState, useCallback, useMemo } from 'react';
import { Globe, Activity, MousePointerClick } from 'lucide-react';
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

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

// One tile per WAN (a controller with dual-WAN gets two); clicking a tile
// scopes the trend charts to that WAN's source. With a single WAN this
// behaves exactly like the old fixed layout.
export default function UnifiWanPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);

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
            <p className="text-[11px] text-ink-faint mb-2 flex items-center gap-1.5">
              <MousePointerClick size={12} /> Select a WAN to scope the trend charts below.
            </p>
          )}
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
