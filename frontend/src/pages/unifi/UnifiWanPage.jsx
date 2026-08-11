import { useEffect, useState, useCallback, useMemo } from 'react';
import { Globe, Activity } from 'lucide-react';
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

export default function UnifiWanPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/unifi/wan')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ wans: [], history: [] }); toast({ type: 'error', title: 'Failed to load WAN data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const wans = data?.wans || [];
  const history = data?.history || [];

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
          <div className="grid sm:grid-cols-2 gap-3 mb-4">
            {wans.map((w) => (
              <div key={w.id || w.wan_name} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
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
              </div>
            ))}
          </div>

          {history.length > 1 && (
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
          )}
        </>
      )}
    </div>
  );
}
