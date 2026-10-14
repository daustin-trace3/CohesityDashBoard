import { useEffect, useState, useMemo } from 'react';
import { GitCompare } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { LoadingPanel } from '../../components/ui/primitives';
import { fmtPct, fmtMbps, fmtNum, fmtShortTime, chartOpts, PALETTE } from './helpers';
import { Modal, chipBtn } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const RANGES = [{ label: '6h', v: 6 }, { label: '24h', v: 24 }, { label: '7d', v: 168 }];

const lastOf = (pts, key) => {
  for (let i = pts.length - 1; i >= 0; i -= 1) if (pts[i][key] != null) return pts[i][key];
  return null;
};

export default function LmInterfaceCompareModal({ ids, onClose }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null);
    setError(false);
    client.get('/logicmonitor/interfaces/compare', { params: { ids: ids.join(','), hours } })
      .then(({ data: d }) => setData(d || {}))
      .catch(() => setError(true));
  }, [ids, hours]);

  const series = useMemo(() => data?.series || [], [data]);
  // Series can sample at different instants; label the x axis from the
  // longest one and plot the others by index (Brocade compare convention).
  const labels = useMemo(() => {
    const longest = series.reduce((acc, s) => ((s.points?.length || 0) > acc.length ? s.points : acc), []);
    return longest.map((p) => fmtShortTime(p.at));
  }, [series]);

  const build = (inKey, outKey) => ({
    labels,
    datasets: series.flatMap((s, i) => {
      const color = PALETTE[i % PALETTE.length];
      const name = `${s.deviceName || ''} ${s.displayName || s.instanceId}`.trim();
      return [
        { label: `${name} in`, data: (s.points || []).map((p) => p[inKey]), borderColor: color, pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
        { label: `${name} out`, data: (s.points || []).map((p) => p[outKey]), borderColor: color, borderDash: [6, 3], pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      ];
    }),
  });

  const hasPoints = series.some((s) => (s.points || []).length > 0);

  return (
    <Modal icon={GitCompare} title={`Compare Interfaces (${ids.length})`} onClose={onClose} width="max-w-6xl">
      <div className="flex items-center gap-1 mb-3">
        {RANGES.map((r) => <button key={r.v} onClick={() => setHours(r.v)} className={chipBtn(hours === r.v)}>{r.label}</button>)}
      </div>
      {error ? <p className="text-sm text-status-crit py-8 text-center">Failed to load interface history.</p>
        : data == null ? <LoadingPanel label="Loading interface history..." height={160} />
        : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(series.length, 1), 4)}, minmax(0, 1fr))` }}>
              {series.map((s, i) => {
                const pts = s.points || [];
                return (
                  <div key={s.instanceId} className="rounded-lg border border-cohesity-border p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <p className="text-xs font-semibold text-ink truncate" title={s.displayName}>{s.displayName || s.instanceId}</p>
                    </div>
                    <p className="text-[10px] text-ink-faint truncate mb-2">{s.deviceName || '-'}</p>
                    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                      <div><span className="text-ink-faint">In</span><p className="text-ink tnum">{fmtPct(lastOf(pts, 'inUtilPct'))}</p></div>
                      <div><span className="text-ink-faint">Out</span><p className="text-ink tnum">{fmtPct(lastOf(pts, 'outUtilPct'))}</p></div>
                      <div><span className="text-ink-faint">In rate</span><p className="text-ink tnum">{fmtMbps(lastOf(pts, 'inMbps'))}</p></div>
                      <div><span className="text-ink-faint">Out rate</span><p className="text-ink tnum">{fmtMbps(lastOf(pts, 'outMbps'))}</p></div>
                      <div className="col-span-2"><span className="text-ink-faint">Errors (last)</span><p className="text-ink tnum">{fmtNum((lastOf(pts, 'inErrors') || 0) + (lastOf(pts, 'outErrors') || 0))}</p></div>
                    </div>
                  </div>
                );
              })}
            </div>
            {!hasPoints ? <p className="text-sm text-ink-muted py-8 text-center">No history in this window yet.</p> : (
              <>
                <div><p className="text-xs font-semibold text-ink mb-2">Utilization %</p><div className="h-56"><Line data={build('inUtilPct', 'outUtilPct')} options={chartOpts} /></div></div>
                <div><p className="text-xs font-semibold text-ink mb-2">Traffic Mbps</p><div className="h-56"><Line data={build('inMbps', 'outMbps')} options={chartOpts} /></div></div>
                <div><p className="text-xs font-semibold text-ink mb-2">Errors</p><div className="h-44"><Line data={build('inErrors', 'outErrors')} options={chartOpts} /></div></div>
              </>
            )}
          </div>
        )}
    </Modal>
  );
}
