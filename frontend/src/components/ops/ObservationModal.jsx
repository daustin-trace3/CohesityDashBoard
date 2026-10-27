import { useEffect, useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend } from 'chart.js';
import { Activity } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { Badge, LoadingPanel, timeAgo } from '../ui/primitives';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

// Observation state -> Badge tone. Closed rows carry the outcome as text.
export const OBS_STATE_TONE = { watching: 'info', degrading: 'warn', critical: 'crit', closed: 'neutral' };

export const fmtObs = (v, unit) => {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return `${(Math.round(Number(v) * 10) / 10).toLocaleString()}${unit || ''}`;
};

export const fmtMinutes = (m) => {
  if (m == null || !Number.isFinite(Number(m))) return '-';
  const n = Math.round(Number(m));
  if (n < 60) return `${n} min`;
  return `${(n / 60).toFixed(n % 60 === 0 ? 0 : 1)} h`;
};

const fmtWhen = (t) => (t ? new Date(t).toLocaleString() : '-');

/**
 * One sentence for an observation that opened (or sits behind) an incident: the
 * value now, the peak and when, the sample that first crossed the line.
 * `d` is the alert's stored detail or an episode from the evidence block.
 */
export const obsDetailLine = (d, label = '') => {
  if (!d) return '';
  const u = d.unit || '';
  const warn = d.warn != null ? d.warn : d.thresholdWarn;
  const parts = [
    `${label ? `${label} ` : ''}${fmtObs(d.value, u)}`,
    `peak ${fmtObs(d.peak, u)}${d.peakAt ? ` at ${fmtWhen(d.peakAt)}` : ''}`,
    `first over ${warn != null ? fmtObs(warn, u) : 'the line'}${d.openedValue != null ? ` at ${fmtObs(d.openedValue, u)}` : ''}${d.openedAt ? ` on ${fmtWhen(d.openedAt)}` : ''}`,
    `${d.elevatedSamples ?? '-'} of ${d.samples ?? '-'} samples`,
  ];
  return parts.join(', ') + (d.promoteReason ? `, promoted: ${d.promoteReason}` : '');
};

const CTX_LABEL = {
  cluster: 'Cluster', esxHost: 'ESX host', cpuCount: 'vCPUs', cpuCores: 'Cores', memoryMb: 'Memory (MB)', vcenter: 'vCenter',
};

function Fact({ label, children }) {
  return (<><dt className="text-ink-faint">{label}</dt><dd className="text-ink min-w-0 break-words">{children}</dd></>);
}

const Block = ({ title, children }) => (
  <div className="rounded-lg border border-cohesity-border p-4 mb-4">
    <p className="text-[11px] uppercase tracking-wide text-ink-faint pb-1.5 mb-2.5 border-b border-cohesity-border">{title}</p>
    {children}
  </div>
);

function SeriesChart({ series, warn, crit, unit }) {
  const data = useMemo(() => {
    const pts = Array.isArray(series) ? series : [];
    const labels = pts.map((p) => String(p.t || '').slice(5, 16).replace('T', ' '));
    const flat = (v, label, color) => ({ label, data: pts.map(() => v), borderColor: color, borderWidth: 1, borderDash: [5, 4], pointRadius: 0, fill: false });
    const sets = [{
      label: 'Value', data: pts.map((p) => p.v), borderColor: '#38BDF8', backgroundColor: '#38BDF8', borderWidth: 2, tension: 0.25, pointRadius: 2, fill: false,
    }];
    if (warn != null) sets.push(flat(warn, 'Warn', '#F59E0B'));
    if (crit != null) sets.push(flat(crit, 'Critical', '#EF4444'));
    return { labels, datasets: sets };
  }, [series, warn, crit]);
  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { boxWidth: 18, boxHeight: 2, font: { size: 10 } } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtObs(c.parsed.y, unit)}` } },
    },
    scales: {
      x: { ticks: { maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
      y: { ticks: { font: { size: 10 }, callback: (v) => `${v}${unit || ''}` } },
    },
  }), [unit]);
  if (!data.labels.length) return <p className="text-xs text-ink-muted py-6 text-center">No samples recorded yet.</p>;
  return <div style={{ height: 160 }}><Line data={data} options={options} /></div>;
}

/**
 * One observation episode: series chart with the warn and critical lines, facts,
 * context and the subject's recent history. `Shell` is the page's ModalShell
 * (it lives in OpsAgentPage.jsx, which imports this file, so it is passed in).
 */
export default function ObservationModal({ id, onClose, Shell }) {
  const [obs, setObs] = useState(null);
  const [failed, setFailed] = useState(null);

  useEffect(() => {
    let live = true;
    setObs(null);
    setFailed(null);
    client.get(`/ops-agent/observations/${id}`)
      .then(({ data }) => { if (live) setObs(data); })
      .catch((e) => { if (live) setFailed(e?.response?.data?.error || 'Failed to load observation.'); });
    return () => { live = false; };
  }, [id]);

  const o = obs;
  const badges = o && (
    <>
      <Badge tone={OBS_STATE_TONE[o.state] || 'neutral'}>{o.state}</Badge>
      {o.state === 'closed' && o.outcome && <Badge tone="neutral">{o.outcome}</Badge>}
      {o.inPattern && <Badge tone="warn">pattern: {o.patternCount} one-offs</Badge>}
    </>
  );
  const ctx = o?.context && typeof o.context === 'object' ? Object.entries(o.context).filter(([, v]) => v != null && v !== '') : [];
  const history = Array.isArray(o?.history) ? o.history : [];

  return (
    <Shell size="md" icon={Activity} onClose={onClose}
      title={o ? `${o.label}: ${o.subject}` : 'Observation'}
      subtitle={o ? `${o.platform}${o.sourceName ? `, ${o.sourceName}` : ''}, opened ${timeAgo(o.openedAt)}, id ${o.id}` : null}
      badges={badges}>
      {failed ? <p className="text-sm text-status-crit py-6 text-center">{failed}</p>
        : !o ? <LoadingPanel label="Loading observation..." height={120} />
        : (
          <>
            <Block title="Trend">
              <SeriesChart series={o.series} warn={o.thresholdWarn} crit={o.thresholdCrit} unit={o.unit} />
            </Block>
            <Block title="Facts">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <Fact label="State">{o.state}{o.state === 'closed' && o.outcome ? ` (${o.outcome})` : ''}</Fact>
                <Fact label="Now">{fmtObs(o.value, o.unit)}</Fact>
                <Fact label="Peak">{fmtObs(o.peak, o.unit)}{o.peakAt ? ` at ${new Date(o.peakAt).toLocaleString()}` : ''}</Fact>
                <Fact label="Warn / critical">{fmtObs(o.thresholdWarn, o.unit)} / {fmtObs(o.thresholdCrit, o.unit)}</Fact>
                <Fact label="Elevated">{fmtMinutes(o.minutes)} ({o.elevatedSamples} of {o.samples} samples)</Fact>
                <Fact label="Opened">{new Date(o.openedAt).toLocaleString()}</Fact>
                {o.promotedAt && <Fact label="Promoted">{new Date(o.promotedAt).toLocaleString()}{o.promoteReason ? `: ${o.promoteReason}` : ''}</Fact>}
                {o.closedAt && <Fact label="Closed">{new Date(o.closedAt).toLocaleString()}</Fact>}
                <Fact label="Last sample">{o.lastSampleAt ? new Date(o.lastSampleAt).toLocaleString() : '-'}</Fact>
                <Fact label="Incident">{o.incidentId ? <Link to={`/ops/agent?incident=${o.incidentId}`} className="text-brand hover:underline" onClick={onClose}>#{o.incidentId}</Link> : 'none yet'}</Fact>
              </dl>
            </Block>
            {ctx.length > 0 && (
              <Block title="Context">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  {ctx.map(([k, v]) => <Fact key={k} label={CTX_LABEL[k] || k}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</Fact>)}
                </dl>
              </Block>
            )}
            <Block title="History for this subject (30 days)">
              {history.length === 0 ? <p className="text-xs text-ink-muted">No earlier episodes.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-1.5 pr-3">Closed</th><th className="py-1.5 pr-3">Observer</th><th className="py-1.5 pr-3">Outcome</th><th className="py-1.5 pr-3">Lasted</th><th className="py-1.5">Peak</th>
                    </tr></thead>
                    <tbody>
                      {history.map((h, i) => (
                        <tr key={i} className="border-b border-cohesity-border/40">
                          <td className="py-1.5 pr-3 text-ink-muted whitespace-nowrap">{h.closedAt ? new Date(h.closedAt).toLocaleString() : '-'}</td>
                          <td className="py-1.5 pr-3 text-ink-muted">{h.label || h.observerId}</td>
                          <td className="py-1.5 pr-3 text-ink-muted">{h.outcome || '-'}</td>
                          <td className="py-1.5 pr-3 text-ink-muted tnum">{fmtMinutes(h.minutes)}</td>
                          <td className="py-1.5 text-ink-muted tnum">{fmtObs(h.peak, o.unit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Block>
          </>
        )}
    </Shell>
  );
}
