import { useEffect, useState } from 'react';
import { Eye, Activity, XCircle, Repeat, TrendingUp, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { InfoTip } from '../../components/settings/SettingRow';
import { fmtNum } from './helpers';

const WATCH_DEFAULTS = {
  lm_watch_sustain_minutes: 15, lm_watch_trend_windows: 3, lm_watch_severe_ratio: 2, lm_watch_clear_samples: 3,
  lm_watch_repeat_min: 3, lm_watch_repeat_days: 7, lm_watch_drift_pct: 25, lm_watch_reference_days: 28,
};

// Plain-language legend for the latency watch states, values read live from
// the thresholds (GET /logicmonitor/config) with the defaults as fallback.
export function WatchLegend() {
  const [t, setT] = useState(WATCH_DEFAULTS);
  useEffect(() => {
    client.get('/logicmonitor/config')
      .then(({ data }) => setT({ ...WATCH_DEFAULTS, ...Object.fromEntries(Object.entries(data?.thresholds || {}).filter(([k, v]) => k in WATCH_DEFAULTS && v != null && v !== '')) }))
      .catch(() => {});
  }, []);
  const rows = [
    ['Watching', 'The latest sample on a check location is above its hour-of-day baseline. Nothing is raised.'],
    ['Degrading', `The watch has run ${t.lm_watch_sustain_minutes} minutes, risen for ${t.lm_watch_trend_windows} windows in a row, hit ${t.lm_watch_severe_ratio}x the baseline twice, or packet loss joined it. A warning issue opens and the Ops Agent sees it.`],
    ['Critical', 'The location is down or the severe condition holds. The issue turns critical.'],
    ['Closed', `${t.lm_watch_clear_samples} normal samples in a row. The outcome is kept: one-off (never promoted), sustained (was degrading), escalated (reached critical).`],
    ['Repeating', `${t.lm_watch_repeat_min} one-offs on one location inside ${t.lm_watch_repeat_days} days raise a latency-pattern issue.`],
    ['Drifting', `The baseline itself sits ${t.lm_watch_drift_pct}% above its ${t.lm_watch_reference_days}-day reference (latency-drift issue).`],
  ];
  return (
    <InfoTip label="latency watch states">
      <span className="block space-y-1.5">
        {rows.map(([k, v]) => <span key={k} className="block"><span className="text-ink font-semibold">{k}: </span>{v}</span>)}
      </span>
    </InfoTip>
  );
}

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
        <WatchLegend />
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
