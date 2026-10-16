import { useEffect, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { LoadingPanel, Badge } from '../../components/ui/primitives';
import { BRAND, fmtMs, fmtPct, fmtNum, fmtWhen, fmtShortTime, toDate, chartOpts, EPISODE_STATE_TONE, EPISODE_OUTCOME_LABEL } from './helpers';
import { Modal, Fact } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

// Vertical marks for opened / promoted / closed, drawn on the chart canvas.
const marksPlugin = {
  id: 'episodeMarks',
  afterDatasetsDraw(chart, _args, opts) {
    const marks = (opts && opts.marks) || [];
    const { ctx, chartArea, scales } = chart;
    if (!scales.x || !chartArea) return;
    ctx.save();
    ctx.font = '10px sans-serif';
    for (const m of marks) {
      if (m.index == null || m.index < 0) continue;
      const x = scales.x.getPixelForValue(m.index);
      ctx.strokeStyle = m.color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.textAlign = x > chartArea.right - 50 ? 'right' : 'left';
      ctx.fillText(m.label, x + (ctx.textAlign === 'left' ? 3 : -3), chartArea.top + 10 + (m.row || 0) * 11);
    }
    ctx.restore();
  },
};

export default function LmEpisodeModal({ id, onClose }) {
  const [ep, setEp] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setEp(null); setError(false);
    client.get(`/logicmonitor/watch/episodes/${encodeURIComponent(id)}`)
      .then(({ data }) => setEp(data || {}))
      .catch(() => setError(true));
  }, [id]);

  const samples = useMemo(() => (ep && ep.samples) || [], [ep]);
  const isLoss = ep && ep.kind === 'loss';

  const chart = useMemo(() => {
    if (!ep) return null;
    const labels = samples.map((p) => fmtShortTime(p.at));
    const base = ep.baselineMedian;
    const datasets = isLoss
      ? [{ label: 'Loss %', data: samples.map((p) => p.lossPct), borderColor: '#C75D5D', backgroundColor: 'rgba(199,93,93,0.12)', pointRadius: 0, borderWidth: 2, tension: 0.1 }]
      : [
        { label: 'RTT avg ms', data: samples.map((p) => p.rttAvgMs), borderColor: BRAND, pointRadius: 0, borderWidth: 2, tension: 0.2 },
        ...(base != null ? [{ label: 'Baseline median', data: samples.map(() => base), borderColor: 'rgba(76,155,232,0.8)', borderDash: [5, 4], pointRadius: 0, borderWidth: 1 }] : []),
      ];
    const idxAt = (iso) => {
      const d = toDate(iso);
      if (!d) return -1;
      const t = d.getTime();
      return samples.findIndex((p) => { const x = toDate(p.at); return x && x.getTime() >= t; });
    };
    const marks = [
      { index: idxAt(ep.openedAt), label: 'opened', color: '#D4A24E', row: 0 },
      ep.promotedAt ? { index: idxAt(ep.promotedAt), label: 'promoted', color: '#E8794C', row: 1 } : null,
      ep.closedAt ? { index: idxAt(ep.closedAt), label: 'closed', color: '#3FB950', row: 2 } : null,
    ].filter(Boolean);
    const options = { ...chartOpts, plugins: { ...chartOpts.plugins, episodeMarks: { marks } } };
    return { data: { labels, datasets }, options };
  }, [ep, samples, isLoss]);

  const title = ep ? `${ep.checkName || ep.subjectLabel || 'Episode'}${ep.label ? ` from ${ep.label}` : ''}` : 'Latency episode';
  return (
    <Modal icon={Eye} title={title} subtitle={ep ? `${isLoss ? 'Packet loss' : 'Latency'} episode, ${ep.state === 'closed' ? 'closed' : 'open'}` : ''} onClose={onClose}>
      {error ? <p className="text-sm text-status-crit py-8 text-center">Failed to load the episode.</p>
        : ep == null ? <LoadingPanel label="Loading episode..." height={160} /> : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge tone={EPISODE_STATE_TONE[ep.state] || 'neutral'}>{ep.state}</Badge>
              {ep.outcome && <Badge tone="neutral">{EPISODE_OUTCOME_LABEL[ep.outcome] || ep.outcome}</Badge>}
              {ep.promoteReason && <span className="text-[11px] text-ink-muted">Promoted: {ep.promoteReason}</span>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Fact label="Opened">{fmtWhen(ep.openedAt)}</Fact>
              <Fact label="Promoted">{ep.promotedAt ? fmtWhen(ep.promotedAt) : '-'}</Fact>
              <Fact label="Closed">{ep.closedAt ? fmtWhen(ep.closedAt) : 'Still open'}</Fact>
              <Fact label="Duration">{ep.durationMin == null ? '-' : `${fmtNum(ep.durationMin)} min`}</Fact>
              <Fact label="Peak">{fmtMs(ep.peakMs)}{ep.peakRatio != null ? ` (${ep.peakRatio}x)` : ''}</Fact>
              <Fact label="Baseline median">{fmtMs(ep.baselineMedian)}</Fact>
              <Fact label="Max loss">{fmtPct(ep.lossMaxPct, 1)}</Fact>
              <Fact label="Likely hop">{ep.likelyHop || '-'}</Fact>
            </div>
            {samples.length === 0 ? <p className="text-sm text-ink-muted py-6 text-center">No samples are stored for this episode.</p> : (
              <div>
                <p className="text-xs font-semibold text-ink mb-2">{isLoss ? 'Packet loss' : 'Round trip time'}, from 30 minutes before the episode opened</p>
                <div className="h-60"><Line data={chart.data} options={chart.options} plugins={[marksPlugin]} /></div>
              </div>
            )}
          </div>
        )}
    </Modal>
  );
}
