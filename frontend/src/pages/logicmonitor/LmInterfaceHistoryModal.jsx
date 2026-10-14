import { useEffect, useState, useMemo } from 'react';
import { Activity } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtPct, fmtShortTime, chartOpts } from './helpers';
import { Modal, chipBtn, headRow } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const RANGES = [{ label: '24h', v: 24 }, { label: '7d', v: 168 }, { label: '30d', v: 720 }];

// IF-MIB status codes: 1 is up, anything else plots as down; null is a gap.
const upOf = (s) => (s == null ? null : Number(s) === 1 ? 1 : 0);

const stateOpts = {
  ...chartOpts,
  scales: {
    x: chartOpts.scales.x,
    y: { ...chartOpts.scales.y, min: -0.1, max: 1.1, ticks: { ...chartOpts.scales.y.ticks, callback: (v) => (v === 1 ? 'Up' : v === 0 ? 'Down' : '') } },
  },
};
const pctOpts = { ...chartOpts, scales: { x: chartOpts.scales.x, y: { ...chartOpts.scales.y, min: 0, suggestedMax: 100 } } };

export default function LmInterfaceHistoryModal({ deviceId, sourceId, iface, deviceName, onClose }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null);
    setError(false);
    const params = { hours };
    if (sourceId) params.sourceId = sourceId;
    client.get(`/logicmonitor/devices/${deviceId}/interfaces/${iface.instanceId}/history`, { params })
      .then(({ data: d }) => setData(d || {}))
      .catch(() => setError(true));
  }, [deviceId, sourceId, iface.instanceId, hours]);

  const points = useMemo(() => data?.points || [], [data]);
  const labels = useMemo(() => points.map((p) => fmtShortTime(p.at)), [points]);

  const stateChart = { labels, datasets: [{ label: 'Oper status', data: points.map((p) => upOf(p.status)), borderColor: BRAND, backgroundColor: 'rgba(26,115,232,0.15)', stepped: true, pointRadius: 0, borderWidth: 2, fill: true }] };
  const utilChart = {
    labels,
    datasets: [
      { label: 'In %', data: points.map((p) => p.inUtilPct), borderColor: BRAND, pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      { label: 'Out %', data: points.map((p) => p.outUtilPct), borderColor: '#3FB950', pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
    ],
  };
  const trafficChart = {
    labels,
    datasets: [
      { label: 'In Mbps', data: points.map((p) => p.inMbps), borderColor: BRAND, pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      { label: 'Out Mbps', data: points.map((p) => p.outMbps), borderColor: '#3FB950', pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
    ],
  };
  const errChart = {
    labels,
    datasets: [
      { label: 'In errors', data: points.map((p) => p.inErrors), borderColor: '#C75D5D', pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      { label: 'Out errors', data: points.map((p) => p.outErrors), borderColor: '#E8794C', pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      { label: 'In discards', data: points.map((p) => p.inDiscards), borderColor: '#D4A24E', borderDash: [5, 3], pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      { label: 'Out discards', data: points.map((p) => p.outDiscards), borderColor: '#8A63D2', borderDash: [5, 3], pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
    ],
  };

  const daily = data?.daily || [];

  return (
    <Modal icon={Activity} title={iface.displayName || iface.instanceName || `Instance ${iface.instanceId}`}
      subtitle={[deviceName, iface.description].filter(Boolean).join(' - ')} onClose={onClose}>
      <div className="flex items-center gap-1 mb-3">
        {RANGES.map((r) => <button key={r.v} onClick={() => setHours(r.v)} className={chipBtn(hours === r.v)}>{r.label}</button>)}
      </div>
      {error ? <p className="text-sm text-status-crit py-8 text-center">Failed to load interface history.</p>
        : data == null ? <LoadingPanel label="Loading interface history..." height={160} />
        : points.length === 0 ? <p className="text-sm text-ink-muted py-8 text-center">No history collected for this interface yet.</p>
        : (
          <div className="flex flex-col gap-4">
            <div><p className="text-xs font-semibold text-ink mb-2">Status</p><div className="h-24"><Line data={stateChart} options={stateOpts} /></div></div>
            <div><p className="text-xs font-semibold text-ink mb-2">Utilization</p><div className="h-36"><Line data={utilChart} options={pctOpts} /></div></div>
            <div><p className="text-xs font-semibold text-ink mb-2">Traffic</p><div className="h-36"><Line data={trafficChart} options={chartOpts} /></div></div>
            <div><p className="text-xs font-semibold text-ink mb-2">Errors and discards</p><div className="h-36"><Line data={errChart} options={chartOpts} /></div></div>
            {daily.length > 0 && (
              <div className="overflow-x-auto">
                <p className="text-xs font-semibold text-ink mb-2">Daily (last 30)</p>
                <table className="w-full text-sm">
                  <thead><tr className={headRow}>
                    <th className="py-1.5 pr-3">Day</th><th className="py-1.5 pr-3 text-right">Max in</th><th className="py-1.5 pr-3 text-right">Max out</th>
                    <th className="py-1.5 pr-3 text-right">Flaps</th><th className="py-1.5 pr-3 text-right">Errors</th>
                  </tr></thead>
                  <tbody>
                    {daily.map((d) => (
                      <tr key={d.day} className="border-b border-cohesity-border/40">
                        <td className="py-1.5 pr-3 tnum text-ink">{d.day}</td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(d.maxInUtilPct)}</td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtPct(d.maxOutUtilPct)}</td>
                        <td className={`py-1.5 pr-3 text-right tnum ${d.flaps ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(d.flaps)}</td>
                        <td className={`py-1.5 pr-3 text-right tnum ${d.errorsSum ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(d.errorsSum)}</td>
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
