import { fmtNum } from '../helpers';
import { COLORS } from './layout';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toneColor = (tone) => (tone === 'crit' ? COLORS.crit : tone === 'warn' ? COLORS.warn : tone === 'ok' ? COLORS.ok : '#94A3B3');

// TenGigabitEthernet1/0/1 -> Te1/0/1 and so on; longest prefixes first.
export function shortPort(port) {
  return String(port || '')
    .replace(/^TenGigabitEthernet/i, 'Te').replace(/^FortyGigabitEthernet/i, 'Fo')
    .replace(/^HundredGigE/i, 'Hu').replace(/^GigabitEthernet/i, 'Gi').replace(/^Ethernet/i, 'Eth');
}

const R = 42;
const CIRC = 2 * Math.PI * R;

function Ring({ score, tone, formula }) {
  const has = score != null && Number.isFinite(Number(score));
  const v = has ? Math.max(0, Math.min(100, Number(score))) : 0;
  const col = toneColor(tone);
  return (
    <div className="flex flex-col items-center min-w-0" title={formula || ''}>
      <div className="relative w-[110px] h-[110px] flex-none">
        <svg width="110" height="110" viewBox="0 0 110 110" aria-hidden="true">
          <circle cx="55" cy="55" r={R} fill="none" stroke="#1F2B37" strokeWidth="10" />
          {has && v > 0 && (
            <circle
              cx="55" cy="55" r={R} fill="none" stroke={col} strokeWidth="10" strokeLinecap="round" data-testid="health-arc"
              strokeDasharray={`${(CIRC * v) / 100} ${CIRC}`} transform="rotate(-90 55 55)" style={{ filter: `drop-shadow(0 0 5px ${col}66)` }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-3xl font-extrabold tracking-tight leading-none tnum" style={{ color: col, fontSize: 30 }} data-testid="health-score">{has ? Math.round(Number(score)) : '-'}</span>
        </div>
      </div>
      <p className="text-[10px] font-semibold tracking-widest uppercase text-ink-muted mt-2">Estate health</p>
      <p className="text-[10px] text-ink-faint mt-1 text-center">Derived, not a LogicMonitor score</p>
    </div>
  );
}

function Figure({ value, label, sub, tone, onClick }) {
  return (
    <button onClick={onClick} className="text-left min-w-0 pl-4 py-1 cursor-pointer hover:opacity-80 transition-opacity" style={{ borderLeft: `3px solid ${toneColor(tone)}` }}>
      <span className="block text-3xl lg:text-4xl font-extrabold tracking-tight leading-none tnum" style={{ color: toneColor(tone) }}>{value}</span>
      <span className="block text-[11px] uppercase tracking-wider text-ink-muted mt-1.5 truncate" title={label}>{label}</span>
      {sub && <span className="block text-xs text-ink-faint mt-1 line-clamp-2" title={sub}>{sub}</span>}
    </button>
  );
}

function MonRow({ label, value, tone, onClick }) {
  return (
    <button onClick={onClick} className="flex w-full justify-between gap-6 py-1 text-[13px] text-ink-muted cursor-pointer hover:text-ink transition-colors">
      <span>{label}</span>
      <b className="font-semibold tnum" style={{ color: tone ? toneColor(tone) : '#E8EDF2' }}>{value}</b>
    </button>
  );
}

export default function HealthBand({ health, counters, circuits, go }) {
  const c = counters || {};
  const h = health || {};
  const hasScore = h.score != null && Number.isFinite(Number(h.score));
  const tone = !hasScore ? 'neutral' : Number(h.score) >= 80 ? 'ok' : Number(h.score) >= 50 ? 'warn' : 'crit';
  const first = Array.isArray(circuits) && circuits.length ? circuits[0] : null;
  const p95 = first ? Math.round(Math.max(num(first.p95InPct), num(first.p95OutPct))) : null;
  const circSub = first && (first.deviceName || first.port)
    ? `of ${fmtNum(num(c.circuits))}, ${[first.deviceName, shortPort(first.port)].filter(Boolean).join(' ')} ${p95}%`
    : `of ${fmtNum(num(c.circuits))}`;
  const colDown = num(c.collectorsDown);
  return (
    <div className="panel grid gap-4 px-6 py-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:gap-x-8">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-5 items-center min-w-0">
        <Ring score={h.score} tone={tone} formula={h.formula} />
        <Figure
          value={fmtNum(num(c.devicesDead))} label="Dead devices" tone={num(c.devicesDead) > 0 ? 'crit' : 'ok'}
          sub={num(c.devicesDeadCollector) > 0 ? `+${fmtNum(num(c.devicesDeadCollector))} behind a down collector` : undefined}
          onClick={go('/logicmonitor/devices')}
        />
        <Figure
          value={fmtNum(num(c.interfacesDown))} label="Down ports" tone={num(c.interfacesDown) > 0 ? 'crit' : 'ok'}
          sub={`of ${fmtNum(num(c.interfaces))} interfaces`} onClick={go('/logicmonitor/interfaces?preset=down')}
        />
        <Figure
          value={fmtNum(num(c.linksDegraded))} label="Degraded links" tone={num(c.linksDegraded) > 0 ? 'warn' : 'ok'}
          sub={`${fmtNum(num(c.checksDown))} ${num(c.checksDown) === 1 ? 'check' : 'checks'} down, ${fmtNum(num(c.checksDegraded))} slow or lossy`} onClick={go('/logicmonitor/reachability')}
        />
        <Figure
          value={fmtNum(num(c.circuitsSaturated))} label="Saturated circuits" tone={num(c.circuitsSaturated) > 0 ? 'crit' : 'ok'}
          sub={circSub} onClick={go('/logicmonitor/circuits')}
        />
      </div>
      <div className="border-t border-cohesity-border pt-3 xl:border-t-0 xl:pt-0 xl:border-l xl:pl-7 xl:w-[250px]">
        <p className="text-[11px] font-semibold tracking-widest uppercase text-ink-muted mb-1.5">Monitoring health</p>
        <MonRow label="Collectors up" value={`${fmtNum(num(c.collectors) - colDown)} / ${fmtNum(num(c.collectors))}`} tone={colDown > 0 ? 'warn' : null} onClick={go('/logicmonitor/collectors')} />
        <MonRow label="Coverage score" value={c.coverageScore == null ? '-' : fmtNum(c.coverageScore)} onClick={go('/logicmonitor/coverage')} />
        <MonRow label="Shadowed devices" value={fmtNum(num(c.shadowed))} onClick={go('/logicmonitor/alerts')} />
      </div>
    </div>
  );
}
