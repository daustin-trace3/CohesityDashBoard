import { useEffect, useMemo } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

// Designer mockup "Ops Overview Options" turn 2 (2026-09-03): two fluid
// re-expressions of the Ops Monitor overview on the same /ops/summary data.
//   2a Drift    - light ground, floating cards, curve-first sparks
//   2b Nocturne - dark ground, estate health ring, glowing streams
// Both keep the page's information architecture: the platforms with critical
// findings get the space, the quiet ones compress to a ledger, and staleness
// is a first-class verdict that overrides health.

const FONT_ID = 'ops-overview-archivo';
const FONT = "Archivo, Inter, -apple-system, 'Segoe UI', sans-serif";

function useArchivo() {
  useEffect(() => {
    if (document.getElementById(FONT_ID)) return;
    const l = document.createElement('link');
    l.id = FONT_ID;
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(l);
  }, []);
}

const STYLE_CSS = `
@keyframes ov-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes ov-blink{0%,100%{opacity:1}50%{opacity:.25}}
.ovd-card{transition:transform .2s ease}
.ovd-card:hover{transform:translateY(-3px)}
.ovd-row{transition:background .15s ease}
.ovd-row:hover{background:#f4f2ef}
.ovd-feed{transition:background .15s ease}
.ovd-feed:hover{background:rgba(240,237,233,.07)}
.ovn-card{transition:border-color .2s ease}
.ovn-card:hover{border-color:rgba(108,179,63,.4)!important}
.ovn-row{transition:background .15s ease}
.ovn-row:hover{background:rgba(232,237,242,.05)}
.ov-btn{background:transparent;border:0;padding:0;margin:0;text-align:left;font:inherit;color:inherit;cursor:pointer}
`;

const num = (v) => Number(v) || 0;
const fmt = (v) => (v == null ? '-' : typeof v === 'string' ? v : Number(v).toLocaleString());

function ageText(min) {
  if (min == null || Number.isNaN(min)) return null;
  if (min < 1) return 'now';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

const minutesSince = (iso) => {
  if (!iso) return null;
  const t = Date.parse(String(iso).replace(' ', 'T'));
  return Number.isNaN(t) ? null : (Date.now() - t) / 60000;
};

// Same verdict logic as the classic page, with a fallback to the last data
// capture timestamp so the demo (no in-memory poller state) still shows an age.
function freshness(status, id) {
  const p = status?.[id];
  if (!p) return null;
  if (p.entities) {
    if (!p.entities.length) return null;
    const ages = p.entities.map((e) => e.ageMinutes ?? minutesSince(e.lastDataCapture)).filter((v) => v != null);
    return {
      age: ages.length ? Math.max(...ages) : null,
      stale: p.entities.some((e) => e.isStale),
      error: p.entities.some((e) => e.lastPollStatus === 'error'),
    };
  }
  return {
    age: p.ageMinutes ?? minutesSince(p.lastDataCapture),
    stale: !!p.isStale,
    error: !!(p.failedSources?.length),
  };
}

// Smooth area + line path through the spark values (mockup's curve-first sparks).
function smooth(vals, w, h, pad = 3) {
  if (!Array.isArray(vals) || vals.length < 2) return null;
  const max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - pad - (num(v) / max) * (h - 2 * pad)]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const cx = ((p0[0] + p1[0]) / 2).toFixed(1);
    d += ` C${cx},${p0[1].toFixed(1)} ${cx},${p1[1].toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
  }
  return { ln: d, ar: `${d} L${w},${h} L0,${h} Z` };
}

function Flow({ values, w, h, line, fill, stroke = 2, style }) {
  const c = smooth(values, w, h);
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block', ...style }} aria-hidden="true">
      {c && <path d={c.ar} fill={fill} />}
      {c && <path d={c.ln} fill="none" stroke={line} strokeWidth={stroke} strokeLinecap="round" />}
    </svg>
  );
}

function sumSev(card, sev) {
  return (card.exceptions || []).filter((e) => e.severity === sev).reduce((s, e) => s + (e.count ?? 1), 0);
}

// Shared row model for both variants.
export function deriveRows(cards, pollerStatus) {
  const rows = (cards || []).map((c) => {
    const fresh = freshness(pollerStatus, c.id);
    const crit = sumSev(c, 'critical');
    const warn = sumSev(c, 'warning');
    const staleTag = !!(fresh?.stale || fresh?.error);
    const age = ageText(fresh?.age);
    const head = c.headline?.[0];
    return {
      ...c,
      crit,
      warn,
      staleTag,
      age,
      freshTxt: staleTag ? `STALE${age ? ` ${age}` : ''}` : age === 'now' ? 'just now' : age ? `${age} ago` : 'no poll data',
      count: fmt(head?.value),
      unit: String(head?.label || 'objects').toLowerCase(),
      exc: (c.exceptions || []).slice(0, 3),
      lead: c.error ? 'summary unavailable'
        : c.exceptions?.[0]?.text
        || (c.health === 'unknown' ? 'no source connected' : 'healthy'),
      sev: crit * 3 + warn,
    };
  });
  rows.sort((a, b) => b.crit - a.crit || b.warn - a.warn || a.label.localeCompare(b.label));
  const maxSev = Math.max(1, ...rows.map((r) => r.sev));
  rows.forEach((r) => { r.sevPct = Math.min(100, (r.sev / maxSev) * 100); });
  const burning = rows.filter((r) => r.health === 'critical').slice(0, 4);
  const burningIds = new Set(burning.map((r) => r.id));
  const steady = rows.filter((r) => !burningIds.has(r.id));
  // Estate health: 100 minus the mean severity index across platforms. A
  // derived figure for the ring, not a vendor-defined score.
  const health = rows.length ? Math.round(100 - rows.reduce((s, r) => s + r.sevPct, 0) / rows.length) : null;
  const staleCount = rows.filter((r) => r.staleTag).length;
  return { rows, burning, steady, health, staleCount };
}

// Segmented switch between the classic page and the two mockups.
export function StyleToggle({ value, onChange, dark }) {
  const opts = [
    { id: 'classic', label: 'Classic' },
    { id: 'drift', label: 'Drift' },
    { id: 'nocturne', label: 'Nocturne' },
  ];
  const fg = dark ? '#E8EDF2' : '#201e1d';
  const muted = dark ? '#5F7081' : '#98928b';
  const bg = dark ? 'rgba(232,237,242,.06)' : 'rgba(32,30,29,.06)';
  const onBg = dark ? '#E8EDF2' : '#201e1d';
  const onFg = dark ? '#0B1015' : '#f4f2ef';
  return (
    <span title="Overview style (review)" style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 999, background: bg }}>
      {opts.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            className="ov-btn"
            onClick={() => onChange(o.id)}
            style={{
              padding: '4px 11px', borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: '.04em',
              background: on ? onBg : 'transparent', color: on ? onFg : muted, fontFamily: FONT,
            }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.color = fg; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.color = muted; }}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

export function TvButton({ tv, onToggle, dark }) {
  const col = dark ? '#94A3B3' : '#98928b';
  const border = dark ? '#1F2B37' : 'rgba(32,30,29,.12)';
  return (
    <button
      type="button"
      className="ov-btn"
      onClick={onToggle}
      title={tv ? 'Exit TV mode' : 'TV mode (fullscreen)'}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 999, border: `1px solid ${border}`, color: col }}
    >
      {tv ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
    </button>
  );
}

const Live = ({ countdown, color, dot }) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, animation: 'ov-blink 2.2s ease-in-out infinite' }} />
    live / refresh {countdown}s
  </span>
);

/* ---------------------------------------------------------------------- */
/* 2a Drift                                                               */
/* ---------------------------------------------------------------------- */

const D = {
  bg: '#f4f2ef', ink: '#201e1d', muted: '#98928b', body: '#5c5751', stale: '#b7b1a9',
  red: '#ec3013', redText: '#c81f04', redPill: '#fdeae6',
  amber: '#D99A3D', amberText: '#8f6400', amberPill: '#faf1df',
  grayPill: '#f0ede9',
  shadow: '0 12px 32px rgba(32,30,29,.07)',
};

const dPill = (bg, fg) => ({ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', padding: '4px 10px', borderRadius: 999, background: bg, color: fg, whiteSpace: 'nowrap' });
const dHeadPill = { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: '#fff', borderRadius: 999, boxShadow: '0 2px 10px rgba(32,30,29,.06)', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' };

function DriftCard({ p, onNavigate }) {
  const tag = p.error ? { t: 'UNAVAILABLE', bg: D.grayPill, fg: '#7c766e' }
    : p.staleTag ? { t: `STALE${p.age ? ` / ${p.age.toUpperCase()}` : ''}`, bg: D.grayPill, fg: '#7c766e' }
    : { t: 'CRITICAL', bg: D.redPill, fg: D.redText };
  return (
    <button type="button" className="ov-btn ovd-card" onClick={() => onNavigate(p.route)}
      style={{ background: '#fff', borderRadius: 20, boxShadow: D.shadow, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ padding: '20px 22px 0', display: 'flex', flexDirection: 'column', gap: 12, flex: 1, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: p.color, flex: 'none' }} />
          <span style={{ fontSize: 14, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
          <span style={dPill(tag.bg, tag.fg)}>{tag.t}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span style={{ fontSize: 42, fontWeight: 800, lineHeight: 1, letterSpacing: '-.03em', fontVariantNumeric: 'tabular-nums' }}>{p.count}</span>
          <span style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: '.08em' }}>{p.unit}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingBottom: 6 }}>
          {p.exc.map((e, i) => (
            <span key={i} role="link" tabIndex={0}
              onClick={(ev) => { ev.stopPropagation(); onNavigate(e.link); }}
              onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); onNavigate(e.link); } }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: D.body, minWidth: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: e.severity === 'critical' ? D.redText : D.amberText }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.text}</span>
            </span>
          ))}
          {p.staleTag && p.age && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: D.body }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: D.amberText }} />
              no data for {p.age}, poller stale
            </span>
          )}
        </div>
      </div>
      <Flow values={p.spark} w={150} h={44} line={D.red} fill="url(#ovd-red)" />
    </button>
  );
}

export function DriftOverview({ data, pollerStatus, countdown, onNavigate, controls }) {
  useArchivo();
  const cards = data?.platforms || [];
  const totals = data?.totals || {};
  const attention = data?.attention || [];
  const model = useMemo(() => deriveRows(cards, pollerStatus), [cards, pollerStatus]);
  const { burning, steady, staleCount } = model;
  const cols = Math.max(1, Math.min(4, burning.length));
  const maxN = Math.max(1, ...attention.map((a) => num(a.count)));

  return (
    <div style={{ background: D.bg, color: D.ink, borderRadius: 24, padding: '28px 32px 32px', fontFamily: FONT, minHeight: '100%' }}>
      <style>{STYLE_CSS}</style>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id="ovd-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ec3013" stopOpacity=".22" /><stop offset="100%" stopColor="#ec3013" stopOpacity="0" /></linearGradient>
          <linearGradient id="ovd-ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#201e1d" stopOpacity=".14" /><stop offset="100%" stopColor="#201e1d" stopOpacity="0" /></linearGradient>
        </defs>
      </svg>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', color: D.muted, textTransform: 'uppercase' }}>Infrastructure Command Center</div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.02em', marginTop: 2 }}>Ops Monitor</div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginLeft: 24, flexWrap: 'wrap' }}>
          <span style={dHeadPill}><span style={{ width: 8, height: 8, borderRadius: '50%', background: D.red, animation: num(totals.critical) ? 'ov-pulse 1.8s ease-in-out infinite' : 'none' }} />{fmt(totals.critical ?? 0)} critical</span>
          <span style={dHeadPill}><span style={{ width: 8, height: 8, borderRadius: '50%', background: D.amber }} />{fmt(totals.warning ?? 0)} warning</span>
          <span style={dHeadPill}><span style={{ width: 8, height: 8, borderRadius: '50%', background: D.stale }} />{staleCount} stale feed{staleCount === 1 ? '' : 's'}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', fontSize: 13, color: D.muted, whiteSpace: 'nowrap' }}>{fmt(totals.objects)} objects / {totals.platforms ?? 0} platforms</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          <Live countdown={countdown} color={D.muted} dot={D.ink} />
          {controls}
        </div>
      </div>

      {data == null ? (
        <div style={{ background: '#fff', borderRadius: 20, boxShadow: D.shadow, padding: 32, textAlign: 'center', fontSize: 13, color: D.muted }}>Loading estate...</div>
      ) : cards.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 20, boxShadow: D.shadow, padding: 32, textAlign: 'center', fontSize: 13, color: D.muted }}>No platforms enabled yet. Connect one under its Settings page.</div>
      ) : (
        <>
          {burning.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 16, marginBottom: 16 }}>
              {burning.map((p) => <DriftCard key={p.id} p={p} onNavigate={onNavigate} />)}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 372px', gap: 16 }}>
            {/* Steady ledger */}
            <div style={{ background: '#fff', borderRadius: 20, boxShadow: D.shadow, padding: '8px 0 6px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 24px 10px' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{burning.length ? 'Steady' : 'All platforms'}, {steady.length} platform{steady.length === 1 ? '' : 's'}</span>
                <span style={{ fontSize: 11, color: D.muted }}>crit / warn, 7d, freshness</span>
              </div>
              {steady.length === 0 && (
                <div style={{ padding: '10px 24px 16px', fontSize: 13, color: D.muted }}>Every enabled platform has critical findings.</div>
              )}
              {steady.map((p) => (
                <button type="button" key={p.id} className="ov-btn ovd-row" onClick={() => onNavigate(p.route)}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) 130px 96px minmax(60px, 1fr) 104px', alignItems: 'center', columnGap: 14, padding: '9px 24px', borderRadius: 14, margin: '0 8px', width: 'calc(100% - 16px)', opacity: p.staleTag ? 0.55 : 1 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: p.color }} />
                    <span style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                    <span style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{p.count}</span>
                    <span style={{ fontSize: 10, color: D.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.unit}</span>
                  </span>
                  <span style={{ display: 'flex', gap: 5 }}>
                    <span style={{ ...dPill(p.crit ? D.redPill : D.bg, p.crit ? D.redText : D.muted), fontSize: 11.5, padding: '3px 9px', letterSpacing: 0, fontVariantNumeric: 'tabular-nums' }}>{p.crit}</span>
                    <span style={{ ...dPill(p.warn ? D.amberPill : D.bg, p.warn ? D.amberText : D.muted), fontSize: 11.5, padding: '3px 9px', letterSpacing: 0, fontVariantNumeric: 'tabular-nums' }}>{p.warn}</span>
                  </span>
                  <span style={{ width: 90 }}><Flow values={p.spark} w={90} h={26} line={D.muted} fill="url(#ovd-ink)" stroke={1.5} /></span>
                  <span style={{ fontSize: 11, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: p.staleTag ? D.amberText : D.muted, whiteSpace: 'nowrap' }}>{p.freshTxt}</span>
                </button>
              ))}
            </div>

            {/* Needs attention */}
            <div style={{ background: '#201e1d', color: '#f0ede9', borderRadius: 20, boxShadow: '0 12px 32px rgba(32,30,29,.18)', padding: '8px 0 14px', minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 22px 10px' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Needs attention</span>
                <span style={{ fontSize: 11, color: '#8d877f' }}>top {attention.length}</span>
              </div>
              {attention.length === 0 && (
                <div style={{ padding: '6px 22px 12px', fontSize: 12, color: '#8d877f' }}>Nothing needs attention. All platforms healthy.</div>
              )}
              {attention.map((f, i) => (
                <button type="button" key={i} className="ov-btn ovd-feed" onClick={() => onNavigate(f.link)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 22px', borderRadius: 12, margin: '0 8px', width: 'calc(100% - 16px)' }}>
                  <span style={{ fontSize: num(f.count) >= 10000 ? 15 : num(f.count) >= 1000 ? 17 : 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: f.severity === 'critical' ? '#F0512F' : D.amber, minWidth: 34, textAlign: 'right', flex: 'none', whiteSpace: 'nowrap' }}>{fmt(f.count)}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 700 }}>{f.platform}</span>
                    <span style={{ display: 'block', fontSize: 11, color: '#8d877f', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.text}</span>
                    <span style={{ display: 'block', height: 3, borderRadius: 2, background: 'rgba(240,237,233,.12)', marginTop: 5 }}>
                      <span style={{ display: 'block', height: 3, borderRadius: 2, background: f.severity === 'critical' ? '#F0512F' : D.amber, width: `${Math.min(100, (num(f.count) / maxN) * 100)}%` }} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* 2b Nocturne                                                            */
/* ---------------------------------------------------------------------- */

// Nocturne reads the dashboard's own tokens (tailwind.config.js: surface,
// ink, status, brand) so it sits with the rest of the app; only the Archivo
// face and the ring/stream treatment stay from the mockup.
const N = {
  bg: '#0B1015', card: '#131B23', border: '1px solid #1F2B37', ink: '#E8EDF2', muted: '#5F7081', body: '#94A3B3', dim: '#3B4D5E',
  red: '#F87171', amber: '#FBBF24', ok: '#6CB33F',
  radius: 12, shadow: '0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.02) inset',
};

function NocturneCard({ p, onNavigate }) {
  const glow = p.staleTag ? N.muted : N.red;
  return (
    <button type="button" className="ov-btn ovn-card" onClick={() => onNavigate(p.route)}
      style={{ background: N.card, border: N.border, borderRadius: N.radius, boxShadow: N.shadow, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ padding: '16px 20px 0', display: 'flex', flexDirection: 'column', gap: 8, flex: 1, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none', background: glow, boxShadow: `0 0 10px ${glow}` }} />
          <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
          <span style={{ fontSize: 12, color: p.staleTag ? N.amber : N.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{p.staleTag ? p.freshTxt : (p.age || '')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>{p.count}</span>
          <span style={{ fontSize: 10, color: N.muted, textTransform: 'uppercase', letterSpacing: '.08em' }}>{p.unit}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: N.red }}>{p.crit}</span><span style={{ color: N.dim }}> / </span><span style={{ color: N.amber }}>{p.warn}</span>
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: N.body, paddingBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.lead}</div>
      </div>
      <Flow values={p.spark} w={150} h={36} line={N.red} fill="url(#ovn-red)" />
    </button>
  );
}

export function NocturneOverview({ data, pollerStatus, countdown, onNavigate, controls }) {
  useArchivo();
  const cards = data?.platforms || [];
  const totals = data?.totals || {};
  const model = useMemo(() => deriveRows(cards, pollerStatus), [cards, pollerStatus]);
  const { rows, burning, health, staleCount } = model;
  const C = 2 * Math.PI * 74;
  const on = health == null ? 0 : (C * health) / 100;
  const cols = burning.length <= 1 ? 1 : 2;

  return (
    <div style={{ background: N.bg, color: N.ink, borderRadius: 16, padding: '28px 32px 32px', fontFamily: FONT, minHeight: '100%' }}>
      <style>{STYLE_CSS}</style>
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id="ovn-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F87171" stopOpacity=".32" /><stop offset="100%" stopColor="#F87171" stopOpacity="0" /></linearGradient>
          <linearGradient id="ovn-mut" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#E8EDF2" stopOpacity=".16" /><stop offset="100%" stopColor="#E8EDF2" stopOpacity="0" /></linearGradient>
          <linearGradient id="ovn-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#FBBF24" /><stop offset="100%" stopColor="#6CB33F" /></linearGradient>
        </defs>
      </svg>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 26, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', color: N.muted, textTransform: 'uppercase' }}>Infrastructure Command Center</div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.02em', marginTop: 2 }}>Ops Monitor</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          <Live countdown={countdown} color={N.muted} dot={N.ink} />
          {controls}
        </div>
      </div>

      {data == null ? (
        <div style={{ background: N.card, border: N.border, borderRadius: N.radius, boxShadow: N.shadow, padding: 32, textAlign: 'center', fontSize: 13, color: N.muted }}>Loading estate...</div>
      ) : cards.length === 0 ? (
        <div style={{ background: N.card, border: N.border, borderRadius: N.radius, boxShadow: N.shadow, padding: 32, textAlign: 'center', fontSize: 13, color: N.muted }}>No platforms enabled yet. Connect one under its Settings page.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '400px minmax(0, 1fr)', gap: 16, marginBottom: 16 }}>
            {/* Health ring */}
            <div style={{ background: N.card, border: N.border, borderRadius: N.radius, boxShadow: N.shadow, padding: 24, display: 'flex', alignItems: 'center', gap: 26 }}>
              <div style={{ position: 'relative', width: 168, height: 168, flex: 'none' }}>
                <svg width="168" height="168" viewBox="0 0 168 168" aria-hidden="true">
                  <circle cx="84" cy="84" r="74" fill="none" stroke="rgba(232,237,242,.08)" strokeWidth="12" />
                  <circle cx="84" cy="84" r="74" fill="none" stroke="url(#ovn-ring)" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${on.toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 84 84)" />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, letterSpacing: '-.03em', fontVariantNumeric: 'tabular-nums' }}>{health == null ? '-' : health}</span>
                  <span style={{ fontSize: 10, letterSpacing: '.12em', color: N.muted, textTransform: 'uppercase', marginTop: 3 }}>Estate health</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: N.red }}>{fmt(totals.critical ?? 0)}</div><div style={{ fontSize: 10.5, letterSpacing: '.1em', color: N.muted, textTransform: 'uppercase' }}>Critical</div></div>
                <div><div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: N.amber }}>{fmt(totals.warning ?? 0)}</div><div style={{ fontSize: 10.5, letterSpacing: '.1em', color: N.muted, textTransform: 'uppercase' }}>Warning</div></div>
                <div><div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{staleCount}</div><div style={{ fontSize: 10.5, letterSpacing: '.1em', color: N.muted, textTransform: 'uppercase' }}>Stale feed{staleCount === 1 ? '' : 's'}</div></div>
                <div style={{ fontSize: 11, color: N.muted, fontVariantNumeric: 'tabular-nums' }}>{fmt(totals.objects)} objects / {totals.platforms ?? 0} platforms</div>
              </div>
            </div>
            {/* Burning cards */}
            {burning.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 16 }}>
                {burning.map((p) => <NocturneCard key={p.id} p={p} onNavigate={onNavigate} />)}
              </div>
            ) : (
              <div style={{ background: N.card, border: N.border, borderRadius: N.radius, boxShadow: N.shadow, padding: 24, display: 'flex', alignItems: 'center', fontSize: 13, color: N.body }}>No platform has critical findings.</div>
            )}
          </div>

          {/* Ranked ledger */}
          <div style={{ background: N.card, border: N.border, borderRadius: N.radius, boxShadow: N.shadow, padding: '8px 0 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '14px 24px 10px' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>All platforms, ranked by severity</span>
              <span style={{ fontSize: 11, color: N.muted }}>severity index, 7d flow, freshness</span>
            </div>
            {rows.map((p) => (
              <button type="button" key={p.id} className="ov-btn ovn-row" onClick={() => onNavigate(p.route)}
                style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 210px) 120px minmax(80px, 1fr) 96px 110px 110px', alignItems: 'center', columnGap: 18, padding: '8px 24px', borderRadius: 8, margin: '0 8px', width: 'calc(100% - 16px)', opacity: p.staleTag ? 0.55 : 1 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: p.color }} />
                  <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{p.count}</span>
                  <span style={{ fontSize: 9.5, color: N.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.unit}</span>
                </span>
                <span style={{ display: 'block', height: 6, borderRadius: 3, background: 'rgba(232,237,242,.07)' }}>
                  <span style={{ display: 'block', height: 6, borderRadius: 3, background: 'linear-gradient(90deg,#FBBF24,#F87171)', width: `${p.sevPct.toFixed(1)}%` }} />
                </span>
                <span style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: p.crit ? N.red : N.dim }}>{p.crit}</span><span style={{ color: N.dim }}> / </span><span style={{ color: p.warn ? N.amber : N.dim }}>{p.warn}</span>
                </span>
                <span style={{ width: 100 }}><Flow values={p.spark} w={90} h={24} line="rgba(232,237,242,.45)" fill="url(#ovn-mut)" stroke={1.5} /></span>
                <span style={{ fontSize: 11, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: p.staleTag ? N.amber : N.muted, whiteSpace: 'nowrap' }}>{p.freshTxt}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
