import { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, GitCompare, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { LoadingPanel, Badge } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const HOURS_OPTIONS = [{ label: '1h', v: 1 }, { label: '6h', v: 6 }, { label: '24h', v: 24 }, { label: '7d', v: 168 }];

const PALETTE = ['#CC092F', '#3FB950', '#D4A24E', '#8A63D2', '#4C9BE8', '#E8794C', '#5FC9C9', '#C75D5D'];

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 10 } } } },
  scales: {
    x: { ticks: { color: '#E5E5E5', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

function fmtRate(n) {
  return n == null ? '—' : Math.round(Number(n)).toLocaleString();
}

function fmtMb(n) {
  return n == null ? '—' : Number(n).toFixed(1);
}

function latestOf(series, wwn) {
  const arr = series?.[wwn] || [];
  return arr.length ? arr[arr.length - 1] : null;
}

export default function BrocadePortCompareModal({ wwns, onClose }) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null);
    setError(false);
    client.get('/brocade/port-stats', { params: { wwns: wwns.join(','), hours } })
      .then(({ data: d }) => setData(d))
      .catch(() => setError(true));
  }, [wwns, hours]);

  const series = data?.series || {};
  const ports = data?.ports || {};

  const hasData = useMemo(() => wwns.some((w) => (series[w] || []).some((pt) =>
    pt.inFramesPerSec != null || pt.outFramesPerSec != null || pt.inMbPerSec != null || pt.outMbPerSec != null
  )), [series, wwns]);

  const labels = useMemo(() => {
    const longest = wwns.reduce((acc, w) => ((series[w]?.length || 0) > acc.length ? series[w] : acc), []);
    return longest.map((pt) => fmtWhen(pt.ts));
  }, [series, wwns]);

  const framesChart = {
    labels,
    datasets: wwns.flatMap((w, i) => {
      const color = PALETTE[i % PALETTE.length];
      const name = ports[w]?.name || w.slice(-8);
      return [
        { label: `${name} in`, data: (series[w] || []).map((pt) => pt.inFramesPerSec), borderColor: color, pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
        { label: `${name} out`, data: (series[w] || []).map((pt) => pt.outFramesPerSec), borderColor: color, borderDash: [6, 3], pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      ];
    }),
  };

  const mbChart = {
    labels,
    datasets: wwns.flatMap((w, i) => {
      const color = PALETTE[i % PALETTE.length];
      const name = ports[w]?.name || w.slice(-8);
      return [
        { label: `${name} in`, data: (series[w] || []).map((pt) => pt.inMbPerSec), borderColor: color, pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
        { label: `${name} out`, data: (series[w] || []).map((pt) => pt.outMbPerSec), borderColor: color, borderDash: [6, 3], pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      ];
    }),
  };

  // Imbalance banner — only meaningful for a pair. Share of summed in+out frames/s each port carries.
  let imbalance = null;
  if (wwns.length === 2) {
    const [wA, wB] = wwns;
    const latestA = latestOf(series, wA);
    const latestB = latestOf(series, wB);
    const totalA = (latestA?.inFramesPerSec || 0) + (latestA?.outFramesPerSec || 0);
    const totalB = (latestB?.inFramesPerSec || 0) + (latestB?.outFramesPerSec || 0);
    const sum = totalA + totalB;
    if (sum > 0) {
      const shareA = (totalA / sum) * 100;
      const shareB = 100 - shareA;
      const maxShare = Math.max(shareA, shareB);
      let tone = 'ok';
      let label = 'Balanced';
      if (maxShare > 80) { tone = 'crit'; label = 'Imbalanced'; }
      else if (maxShare > 65) { tone = 'warn'; label = 'Imbalanced'; }
      imbalance = {
        tone, label,
        nameA: ports[wA]?.name || wA.slice(-8), nameB: ports[wB]?.name || wB.slice(-8),
        shareA, shareB,
      };
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-5xl max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            <GitCompare size={17} className="text-brand shrink-0" />
            <p className="text-sm font-semibold text-ink truncate">Compare Ports ({wwns.length})</p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto">
          {error ? (
            <div className="text-sm text-status-crit py-8 text-center">Failed to load port statistics.</div>
          ) : data == null ? (
            <LoadingPanel label="Loading port statistics…" height={160} />
          ) : (
            <div className="flex flex-col gap-4">
              {imbalance && (
                <div className={`rounded-lg border px-3 py-2.5 flex items-center gap-2.5 ${
                  imbalance.tone === 'crit' ? 'bg-status-crit/10 border-status-crit/25' :
                  imbalance.tone === 'warn' ? 'bg-status-warn/10 border-status-warn/25' :
                  'bg-status-ok/10 border-status-ok/25'
                }`}>
                  {imbalance.tone === 'ok' ? <CheckCircle2 size={15} className="text-status-ok shrink-0" /> : <AlertTriangle size={15} className={imbalance.tone === 'crit' ? 'text-status-crit shrink-0' : 'text-status-warn shrink-0'} />}
                  <p className={`text-xs font-semibold ${imbalance.tone === 'crit' ? 'text-status-crit' : imbalance.tone === 'warn' ? 'text-status-warn' : 'text-status-ok'}`}>
                    {imbalance.label} — {imbalance.nameA} {imbalance.shareA.toFixed(0)}% / {imbalance.nameB} {imbalance.shareB.toFixed(0)}% of combined frames/s
                  </p>
                </div>
              )}

              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(wwns.length, 4)}, minmax(0, 1fr))` }}>
                {wwns.map((w, i) => {
                  const meta = ports[w] || {};
                  const latest = latestOf(series, w);
                  return (
                    <div key={w} className="rounded-lg border border-cohesity-border p-3">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                        <p className="text-xs font-semibold text-ink truncate" title={meta.name}>{meta.name || w.slice(-8)}</p>
                      </div>
                      <p className="text-[10px] text-ink-faint truncate mb-2">{meta.switchName || '—'}</p>
                      <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                        <div><span className="text-ink-faint">In fr/s</span><p className="text-ink tnum">{fmtRate(latest?.inFramesPerSec)}</p></div>
                        <div><span className="text-ink-faint">Out fr/s</span><p className="text-ink tnum">{fmtRate(latest?.outFramesPerSec)}</p></div>
                        <div><span className="text-ink-faint">In MB/s</span><p className="text-ink tnum">{fmtMb(latest?.inMbPerSec)}</p></div>
                        <div><span className="text-ink-faint">Out MB/s</span><p className="text-ink tnum">{fmtMb(latest?.outMbPerSec)}</p></div>
                      </div>
                      {latest?.crcErrorsDelta > 0 && (
                        <Badge tone="warn" className="mt-2">CRC +{latest.crcErrorsDelta}</Badge>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-1">
                {HOURS_OPTIONS.map((h) => (
                  <button key={h.v} onClick={() => setHours(h.v)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${hours === h.v ? 'bg-brand/10 text-brand border border-brand/30' : 'text-ink-muted border border-transparent hover:text-ink'}`}>
                    {h.label}
                  </button>
                ))}
              </div>

              {!hasData ? (
                <div className="text-sm text-ink-muted py-8 text-center max-w-md mx-auto">
                  No IO stats yet — port stats poller hasn&apos;t sampled twice, or the SanNav FOS proxy doesn&apos;t relay fibrechannel-statistics; check Settings → Probe → portstats
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-xs font-semibold text-ink mb-2">Frames/s</p>
                    <div className="h-56"><Line data={framesChart} options={chartOpts} /></div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-ink mb-2">MB/s</p>
                    <div className="h-56"><Line data={mbChart} options={chartOpts} /></div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
