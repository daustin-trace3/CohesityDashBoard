import { Link } from 'react-router-dom';
import { Panel } from '../../../components/ui/primitives';

const TONE_TEXT = { ok: 'text-status-ok', warn: 'text-status-warn', crit: 'text-status-crit', neutral: 'text-ink' };
const TONE_STROKE = { ok: '#6CB33F', warn: '#D4A24E', crit: '#C75D5D', neutral: '#FF9900' };

function Spark({ data, tone }) {
  const pts = (data || []).map(Number).filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const w = 80;
  const h = 22;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="mt-1 block" aria-hidden="true">
      <path d={d} fill="none" stroke={TONE_STROKE[tone] || TONE_STROKE.neutral} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Tile({ label, value, sub, tone = 'neutral', spark, to, title }) {
  const body = (
    <div className="min-w-0 px-3 py-2.5 h-full" title={title}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint truncate">{label}</p>
      <p className={`text-lg font-bold leading-tight tnum truncate ${TONE_TEXT[tone] || TONE_TEXT.neutral}`}>{value}</p>
      {sub && <p className="text-[11px] text-ink-muted truncate">{sub}</p>}
      <Spark data={spark} tone={tone} />
    </div>
  );
  return to
    ? <Link to={to} className="block rounded-lg hover:bg-surface-overlay/60 transition-colors">{body}</Link>
    : <div className="rounded-lg">{body}</div>;
}

/**
 * One Panel with a responsive grid of up to 10 compact tiles.
 * tiles: [{ label, value, sub?, tone? ok|warn|crit|neutral, spark?: number[], to?: string, title? }]
 */
export default function KpiBand({ tiles = [], loading = false }) {
  return (
    <Panel className="mb-4" bodyClassName="">
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1">
          {Array.from({ length: 10 }).map((_, i) => <div key={i} className="skeleton h-16 m-1.5" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-1 gap-y-1 divide-cohesity-border">
          {tiles.slice(0, 10).map((t) => <Tile key={t.label} {...t} />)}
        </div>
      )}
    </Panel>
  );
}
