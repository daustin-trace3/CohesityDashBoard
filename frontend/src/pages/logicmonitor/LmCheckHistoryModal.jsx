import { useEffect, useState, useMemo } from 'react';
import { Radar } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { LoadingPanel, Badge } from '../../components/ui/primitives';
import { BRAND, fmtMs, fmtPct, fmtNum, fmtShortTime, toDate, chartOpts, anomalyTone } from './helpers';
import { Modal, chipBtn, headRow } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const RANGES = [{ label: '24h', v: 24 }, { label: '7d', v: 168 }, { label: '30d', v: 720 }];

// Baseline rows are keyed by hour of day. The poller buckets captured_at,
// which SQLite stores in UTC, so the lookup uses the UTC hour of each point.
function bandFor(points, baseline, medKey, madKey, k, floor) {
  const byHour = new Map((baseline || []).map((b) => [Number(b.hour), b]));
  const lower = [];
  const upper = [];
  const median = [];
  for (const p of points) {
    const d = toDate(p.at);
    const b = d ? byHour.get(d.getUTCHours()) : null;
    if (!b || b[medKey] == null) { lower.push(null); upper.push(null); median.push(null); continue; }
    const spread = k * Math.max(Number(b[madKey]) || 0, floor);
    median.push(Number(b[medKey]));
    lower.push(Math.max(0, Number(b[medKey]) - spread));
    upper.push(Number(b[medKey]) + spread);
  }
  return { lower, upper, median };
}

export default function LmCheckHistoryModal({ check, location, onClose }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [thr, setThr] = useState({});

  useEffect(() => {
    client.get('/logicmonitor/config').then(({ data: d }) => setThr(d?.thresholds || d || {})).catch(() => setThr({}));
  }, []);

  useEffect(() => {
    setData(null);
    setError(false);
    client.get(`/logicmonitor/checks/${encodeURIComponent(check.checkId)}/history`, { params: { checkpointId: location.checkpointId, hours } })
      .then(({ data: d }) => setData(d || {}))
      .catch(() => setError(true));
  }, [check.checkId, location.checkpointId, hours]);

  const points = useMemo(() => data?.points || [], [data]);
  const k = Number(thr.lm_check_latency_k) || 3;
  const latFloor = Number(thr.lm_check_latency_floor_ms) || 5;
  const labels = useMemo(() => points.map((p) => fmtShortTime(p.at)), [points]);
  const isWeb = check.kind === 'web';

  const rttChart = useMemo(() => {
    const band = bandFor(points, data?.baseline, 'rttMedian', 'rttMad', k, latFloor);
    return {
      labels,
      datasets: [
        { label: 'Baseline low', data: band.lower, borderColor: 'rgba(76,155,232,0.0)', pointRadius: 0, borderWidth: 0, fill: false },
        { label: `Baseline band (median +/- ${k} x MAD)`, data: band.upper, borderColor: 'rgba(76,155,232,0.0)', backgroundColor: 'rgba(76,155,232,0.15)', pointRadius: 0, borderWidth: 0, fill: '-1' },
        { label: 'Baseline median', data: band.median, borderColor: 'rgba(76,155,232,0.7)', borderDash: [5, 4], pointRadius: 0, borderWidth: 1 },
        { label: isWeb ? 'Response ms' : 'RTT avg ms', data: points.map((p) => (isWeb ? p.responseMs ?? p.rttAvgMs : p.rttAvgMs)), borderColor: BRAND, pointRadius: 0, borderWidth: 2, tension: 0.2 },
        ...(!isWeb ? [{ label: 'RTT max ms', data: points.map((p) => p.rttMaxMs), borderColor: '#D4A24E', pointRadius: 0, borderWidth: 1, tension: 0.2 }] : []),
      ],
    };
  }, [points, data, labels, k, latFloor, isWeb]);

  const lossChart = useMemo(() => {
    const band = bandFor(points, data?.baseline, 'lossMedian', 'lossMad', k, 1);
    return {
      labels,
      datasets: [
        { label: 'Baseline low', data: band.lower, borderColor: 'rgba(76,155,232,0.0)', pointRadius: 0, borderWidth: 0, fill: false },
        { label: 'Baseline band', data: band.upper, borderColor: 'rgba(76,155,232,0.0)', backgroundColor: 'rgba(76,155,232,0.15)', pointRadius: 0, borderWidth: 0, fill: '-1' },
        { label: 'Loss %', data: points.map((p) => p.lossPct), borderColor: '#C75D5D', backgroundColor: 'rgba(199,93,93,0.12)', pointRadius: 0, borderWidth: 2, tension: 0.1 },
      ],
    };
  }, [points, data, labels, k]);

  const opts = useMemo(() => ({
    ...chartOpts,
    plugins: { ...chartOpts.plugins, legend: { labels: { ...chartOpts.plugins.legend.labels, filter: (item) => item.text !== 'Baseline low' } } },
  }), []);

  const daily = data?.daily || [];
  const hasLoss = points.some((p) => p.lossPct != null);

  return (
    <Modal icon={Radar} title={`${check.name} from ${location.label}`} subtitle={`${check.target || ''} - ${check.kind === 'web' ? 'web check' : 'ping check'} - ${check.origin || ''}`} onClose={onClose}>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1">
          {RANGES.map((r) => <button key={r.v} onClick={() => setHours(r.v)} className={chipBtn(hours === r.v)}>{r.label}</button>)}
        </div>
        <Badge tone={anomalyTone(location.anomaly, location.lastStatus)}>{location.anomaly ? `Anomaly: ${location.anomaly}` : (location.lastStatus || 'unknown')}</Badge>
        <span className="text-[11px] text-ink-faint">Now {fmtMs(location.rttAvgMs)}, baseline {fmtMs(location.baselineRttMs)}, loss {fmtPct(location.lossPct, 1)}</span>
      </div>
      {error ? (
        <p className="text-sm text-status-crit py-8 text-center">Failed to load check history.</p>
      ) : data == null ? (
        <LoadingPanel label="Loading check history..." height={160} />
      ) : points.length === 0 ? (
        <p className="text-sm text-ink-muted py-8 text-center">No samples collected for this location yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-semibold text-ink mb-2">{isWeb ? 'Response time' : 'Round trip time'}</p>
            <div className="h-56"><Line data={rttChart} options={opts} /></div>
          </div>
          {hasLoss && (
            <div>
              <p className="text-xs font-semibold text-ink mb-2">Packet loss</p>
              <div className="h-40"><Line data={lossChart} options={opts} /></div>
            </div>
          )}
          <p className="text-[11px] text-ink-faint leading-relaxed">
            The band is the hour-of-day baseline: median plus or minus {k} x max(MAD, floor). A latency anomaly needs the last 3 samples above the top of the band.
          </p>
          {daily.length > 0 && (
            <div className="overflow-x-auto">
              <p className="text-xs font-semibold text-ink mb-2">Daily (last 30)</p>
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <th className="py-1.5 pr-3">Day</th><th className="py-1.5 pr-3 text-right">RTT avg</th><th className="py-1.5 pr-3 text-right">RTT p95</th>
                  <th className="py-1.5 pr-3 text-right">Loss avg</th><th className="py-1.5 pr-3 text-right">Loss max</th><th className="py-1.5 pr-3 text-right">Down samples</th>
                </tr></thead>
                <tbody>
                  {daily.map((d) => (
                    <tr key={d.day} className="border-b border-cohesity-border/40">
                      <td className="py-1.5 pr-3 text-ink tnum">{d.day}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtMs(d.rttAvg)}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtMs(d.rttP95)}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(d.lossAvg, 1)}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(d.lossMax, 1)}</td>
                      <td className={`py-1.5 pr-3 text-right tnum ${d.downSamples ? 'text-status-crit' : 'text-ink-faint'}`}>{fmtNum(d.downSamples)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
