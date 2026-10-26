// Shared date range for history pages: chips 7 / 14 / 30 / 90 plus Custom.
// The range lives in the URL (?days=N or ?from=YYYY-MM-DD&to=YYYY-MM-DD) so a
// page can be linked and reloaded. Day keys use the same local-day algorithm
// as backend/utils/dateRange.js so the grid can draw before the response.
import { useMemo, useState, useCallback } from 'react';

const CHIPS = [7, 14, 30, 90];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, '0');

/** Local YYYY-MM-DD key for a timestamp (ms) or Date. */
export function localDayKey(msOrDate) {
  const d = msOrDate instanceof Date ? msOrDate : new Date(msOrDate);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse YYYY-MM-DD into a UTC day number (ms at UTC midnight), or null. */
function isoToUtcMs(s) {
  const m = ISO_RE.exec(String(s || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms);
  // Reject rollovers such as 2026-02-31.
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

/** Inclusive span in days between two ISO day strings, or null when invalid. */
export function spanDays(from, to) {
  const a = isoToUtcMs(from);
  const b = isoToUtcMs(to);
  if (a == null || b == null || b < a) return null;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** Day keys for a resolved range, newest first. */
export function buildDayKeys(range) {
  const keys = [];
  if (range.mode === 'custom') {
    const end = isoToUtcMs(range.to);
    for (let i = 0; i < range.days; i++) {
      const d = new Date(end - i * DAY_MS);
      keys.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    }
    return keys;
  }
  const now = new Date();
  for (let i = 0; i < range.days; i++) {
    keys.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

/** Timeout ladder (ms) for a span; undefined means the client default. */
export function timeoutForDays(days) {
  if (days >= 365) return 180000;
  if (days >= 90) return 120000;
  if (days >= 30) return 60000;
  return undefined;
}

function shortDay(iso, withYear) {
  const m = ISO_RE.exec(iso);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}${withYear ? `, ${m[1]}` : ''}`;
}

export function rangeLabel(range) {
  if (range.mode === 'days') return `Last ${range.days} days`;
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return sameYear
    ? `${shortDay(range.from, false)} to ${shortDay(range.to, true)}`
    : `${shortDay(range.from, true)} to ${shortDay(range.to, true)}`;
}

/** Checks a custom range; returns an error string or null. */
export function validateCustom(from, to, maxDays = 365) {
  if (!from || !to) return 'Pick both a from and a to date.';
  if (isoToUtcMs(from) == null || isoToUtcMs(to) == null) return 'Dates must be valid.';
  const span = spanDays(from, to);
  if (span == null) return 'From must be on or before To.';
  if (span > maxDays) return `The range is limited to ${maxDays} days.`;
  return null;
}

/** Suggested CSV name, matching the server: <platform>-backup-history-<from>_<to>.csv */
export function csvFilename(platform, dayKeys) {
  if (!dayKeys || dayKeys.length === 0) return `${platform}-backup-history.csv`;
  return `${platform}-backup-history-${dayKeys[dayKeys.length - 1]}_${dayKeys[0]}.csv`;
}

export function useDateRange(searchParams, setSearchParams, { defaultDays = 30, maxDays = 365 } = {}) {
  const spStr = searchParams.toString();

  const range = useMemo(() => {
    const p = new URLSearchParams(spStr);
    const from = p.get('from');
    const to = p.get('to');
    if (from && to && validateCustom(from, to, maxDays) == null) {
      return { mode: 'custom', days: spanDays(from, to), from, to };
    }
    const n = Number(p.get('days'));
    const days = Number.isInteger(n) && n >= 1 && n <= maxDays ? n : defaultDays;
    return { mode: 'days', days, from: null, to: null };
  }, [spStr, defaultDays, maxDays]);

  const write = useCallback((mutate) => {
    const p = new URLSearchParams(spStr);
    mutate(p);
    setSearchParams(p, { replace: true });
  }, [spStr, setSearchParams]);

  const setDays = useCallback((n) => write((p) => { p.set('days', String(n)); p.delete('from'); p.delete('to'); }), [write]);
  const setCustom = useCallback((from, to) => write((p) => { p.set('from', from); p.set('to', to); p.delete('days'); }), [write]);
  const apply = useCallback((next) => {
    if (next.mode === 'custom') setCustom(next.from, next.to);
    else setDays(next.days);
  }, [setDays, setCustom]);

  const params = useMemo(() => {
    const tz = new Date().getTimezoneOffset();
    return range.mode === 'custom' ? { from: range.from, to: range.to, tz } : { days: range.days, tz };
  }, [range]);

  const dayKeys = useMemo(() => buildDayKeys(range), [range]);
  const label = useMemo(() => rangeLabel(range), [range]);

  return {
    range, setDays, setCustom, apply, params,
    days: range.days, label, timeout: timeoutForDays(range.days),
    dayKeys, dayKeyFor: localDayKey,
  };
}

const chipBase = 'px-2.5 py-1.5 text-xs cursor-pointer';
const chipOn = 'bg-surface-overlay text-ink';
const chipOff = 'text-ink-muted hover:text-ink';
const dateInput = 'bg-surface border border-cohesity-border text-[12px] text-ink rounded-lg px-2 py-1 focus:border-brand/60 outline-none';

export function DateRangeControl({ value, onChange, maxDays = 365 }) {
  const [open, setOpen] = useState(value.mode === 'custom');
  const [from, setFrom] = useState(value.from || '');
  const [to, setTo] = useState(value.to || '');
  const [error, setError] = useState(null);

  const pickDays = (n) => { setError(null); setOpen(false); onChange({ mode: 'days', days: n }); };
  const applyCustom = () => {
    const err = validateCustom(from, to, maxDays);
    setError(err);
    if (!err) onChange({ mode: 'custom', from, to });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex rounded-lg border border-cohesity-border overflow-hidden" role="group" aria-label="Date range">
        {CHIPS.map((n) => (
          <button key={n} type="button" onClick={() => pickDays(n)}
            className={`${chipBase} ${value.mode === 'days' && value.days === n ? chipOn : chipOff}`}>
            {n}d
          </button>
        ))}
        <button type="button" onClick={() => setOpen((o) => !o)}
          className={`${chipBase} ${value.mode === 'custom' || open ? chipOn : chipOff}`}>
          Custom
        </button>
      </div>
      {open && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <label className="text-[11px] text-ink-faint" htmlFor="drc-from">From</label>
          <input id="drc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateInput} />
          <label className="text-[11px] text-ink-faint" htmlFor="drc-to">To</label>
          <input id="drc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={dateInput} />
          <button type="button" onClick={applyCustom}
            className="px-3 py-1 rounded-lg text-xs font-semibold bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors cursor-pointer">
            Apply
          </button>
          {error && <span role="alert" className="text-[11px] text-status-crit">{error}</span>}
        </div>
      )}
    </div>
  );
}

export function RangeNote({ historyDays, truncated }) {
  if (!truncated || !historyDays) return null;
  return (
    <p className="text-[11px] text-status-warn mb-3">
      History is kept for {historyDays} days; older days are empty
    </p>
  );
}
