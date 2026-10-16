import { Eye, Activity, XCircle, Repeat, TrendingUp, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fmtNum } from './helpers';

// Chip filters for the episodes table, fed by GET /logicmonitor/watch/summary.
// `active` is a key from CHIPS or ''. Drifting has no episodes; it links to the
// Issues page where the latency-drift rows live.
export const CHIPS = [
  { key: 'watching', label: 'Watching', icon: Eye, tone: '#4C9BE8', count: (s) => s.open.watching },
  { key: 'degrading', label: 'Degrading', icon: Activity, tone: '#D4A24E', count: (s) => s.open.degrading },
  { key: 'critical', label: 'Critical', icon: XCircle, tone: '#C75D5D', count: (s) => s.open.critical },
  { key: 'oneoff', label: 'One-offs 7d', icon: CheckCircle2, tone: '#3FB950', count: (s) => s.closed.oneOff },
  { key: 'repeating', label: 'Repeating', icon: Repeat, tone: '#E8794C', count: (s) => s.repeating },
];

const box = 'flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors min-w-[120px]';

export default function LmWatchBand({ summary, active, onPick }) {
  const s = summary ? { open: summary.open || {}, closed: summary.closed || {}, repeating: summary.repeating || 0, drifting: summary.drifting || 0 } : null;
  const driftOn = s && s.drifting > 0;
  return (
    <div className="mb-4" data-testid="watch-band">
      <div className="flex items-baseline gap-2 mb-2 mx-1">
        <b className="text-[13px] font-bold text-ink">Latency watch</b>
        <span className="text-[11px] text-ink-muted">Click a count to filter the episodes below.</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {CHIPS.map((c) => {
          const n = s ? Number(c.count(s)) || 0 : 0;
          const on = active === c.key;
          const Icon = c.icon;
          return (
            <button key={c.key} type="button" onClick={() => onPick(on ? '' : c.key)}
              className={`${box} cursor-pointer ${on ? 'bg-brand/10 border-brand/40' : 'bg-surface border-cohesity-border hover:border-brand/30'}`}>
              <Icon size={15} style={{ color: n > 0 ? c.tone : '#5F7081' }} />
              <span>
                <b className="block text-[16px] font-bold tnum leading-none" style={{ color: n > 0 ? c.tone : '#5F7081' }}>{s ? fmtNum(n) : '-'}</b>
                <span className="text-[11px] text-ink-muted">{c.label}</span>
              </span>
            </button>
          );
        })}
        <Link to="/logicmonitor/issues?q=latency-drift" title="latency-drift issues: the baseline itself has moved up against its long-term reference"
          className={`${box} bg-surface border-cohesity-border hover:border-brand/30`}>
          <TrendingUp size={15} style={{ color: driftOn ? '#D4A24E' : '#5F7081' }} />
          <span>
            <b className="block text-[16px] font-bold tnum leading-none" style={{ color: driftOn ? '#D4A24E' : '#5F7081' }}>{s ? fmtNum(s.drifting) : '-'}</b>
            <span className="text-[11px] text-ink-muted">Drifting</span>
          </span>
        </Link>
      </div>
    </div>
  );
}
