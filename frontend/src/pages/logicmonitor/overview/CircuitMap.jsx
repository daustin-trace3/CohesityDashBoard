import { useMemo, useRef, useState } from 'react';
import {
  COLORS, NODE_W, NODE_H, MAP_W, layoutNodes, edgeGeometry, nodeRects, pushClear, pillRect,
} from './layout';
import { fmtWhen } from '../helpers';

// Circuit map (round 13): sites as nodes coloured by WAN state, site-link
// circuits as edges coloured by state. Geometry comes from layout.js (the same
// tiers and collision rules as the Overview site map); the data shape is the
// GET /logicmonitor/circuit-map answer. Pure presentation: the page owns
// fetching, filtering and navigation.

const list = (v) => (Array.isArray(v) ? v : []);
const short = (v, n) => (v && v.length > n ? `${v.slice(0, n - 1)}~` : v || '');
const HW = NODE_W / 2;
const HH = NODE_H / 2;
const GREY = '#6B7C8D';

export const wanColor = (s) => (s === 'down' ? COLORS.crit : s === 'degraded' ? COLORS.warn : s === 'ok' ? COLORS.ok : GREY);
export const edgeColor = (s) => (s === 'down' ? COLORS.crit : s === 'degraded' || s === 'flapping' ? COLORS.warn : COLORS.ok);
const edgeWidth = (s) => (s === 'down' ? 3 : s === 'ok' ? 1.75 : 2.5);
const edgeText = (e) => {
  const n = list(e.circuits).length;
  if (e.state === 'down') return n > 1 ? `down x${n}` : 'down';
  if (e.state === 'flapping') return 'flapping';
  if (e.state === 'degraded') return `${list(e.circuits).filter((c) => c.state === 'down').length || 1} of ${n} down`;
  return n > 1 ? `${n} circuits` : '1 circuit';
};
const pillW = (t) => t.length * 6.6 + 14;

function Pill({ x, y, text, color }) {
  const w = pillW(text);
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={y - 10} width={w} height={20} rx={10} fill="#0B1015" stroke={color} strokeWidth="1" />
      <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill={color}>{text}</text>
    </g>
  );
}

function TipCard({ tip }) {
  const flip = tip.x > tip.w - 320;
  const style = { left: flip ? Math.max(0, tip.x - 314) : tip.x + 14, top: Math.max(0, tip.y + 14), width: 300 };
  return (
    <div className="absolute z-10 pointer-events-none rounded-lg border p-3 text-[11px] leading-relaxed shadow-modal" style={{ ...style, background: '#0B1015', borderColor: '#2b3b4b' }} role="tooltip">
      {tip.lines.map((l, i) => (
        <p key={i} className={l.cls || 'text-ink-muted'} style={l.bold ? { fontWeight: 700, fontSize: 13 } : undefined}>{l.text}</p>
      ))}
    </div>
  );
}

function wanLine(n) {
  const total = Number(n.wanTotal) || 0;
  const down = Number(n.wanDown) || 0;
  if (n.wanState === 'down') return { text: `WAN down: ${down} of ${total} circuit(s) down`, cls: 'text-status-crit' };
  if (n.wanState === 'degraded') return { text: `WAN degraded: ${Math.max(0, total - down)} of ${total} circuit(s) up, site still reachable`, cls: 'text-status-warn' };
  if (n.wanState === 'ok') return { text: `WAN up: ${total} circuit(s)`, cls: 'text-status-ok' };
  return { text: 'No WAN circuit identified', cls: 'text-ink-faint' };
}

function nodeTip(n) {
  const dead = list(n.deadDevices);
  const deg = list(n.degradedDevices);
  const lines = [
    { text: n.siteName || n.siteKey, bold: true, cls: 'text-ink' },
    wanLine(n),
    { text: `${n.tier === 'dc' ? 'Data center' : 'Site'}, ${n.openIssues ?? 0} open issue(s)` },
  ];
  if (dead.length) {
    lines.push({ text: `Dead devices (${n.devicesDead ?? dead.length})`, cls: 'text-status-crit font-semibold' });
    dead.slice(0, 10).forEach((d) => lines.push({ text: d }));
  }
  if (deg.length) {
    lines.push({ text: 'Degraded devices', cls: 'text-status-warn font-semibold' });
    deg.slice(0, 10).forEach((d) => lines.push({ text: d }));
  }
  lines.push({ text: 'Click opens Site 360', cls: 'text-ink-faint' });
  return lines;
}

function edgeTip(e, nameOf) {
  const lines = [
    { text: `${nameOf(e.a)} to ${nameOf(e.b)}`, bold: true, cls: 'text-ink' },
    { text: `State ${e.state}${e.lastEventAt ? `, last event ${fmtWhen(e.lastEventAt)}` : ''}`, cls: e.state === 'down' ? 'text-status-crit' : e.state === 'ok' ? 'text-ink-muted' : 'text-status-warn' },
  ];
  list(e.circuits).slice(0, 6).forEach((c) => {
    lines.push({ text: `${[c.deviceName, c.port].filter(Boolean).join(' ')}: ${c.state}${c.flaps24h ? `, ${c.flaps24h} flaps in 24 h` : ''}`, cls: 'text-ink' });
    if (c.label) lines.push({ text: c.label });
  });
  lines.push({ text: e.issueKey ? 'Click opens the issue' : 'Click opens Site 360', cls: 'text-ink-faint' });
  return lines;
}

export default function CircuitMap({ nodes: nodesIn, edges: edgesIn, onOpenSite, onOpenEdge }) {
  const nodes = list(nodesIn);
  const edges = list(edgesIn);
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null);

  const layout = useMemo(() => layoutNodes(nodes), [nodes]);
  const pos = layout.positions;
  const nodeByKey = useMemo(() => { const m = {}; nodes.forEach((n) => { m[String(n.siteKey)] = n; }); return m; }, [nodes]);
  const nameOf = (k) => (nodeByKey[String(k)] ? (nodeByKey[String(k)].siteName || String(k)) : String(k));
  const rects = useMemo(() => nodeRects(pos), [pos]);

  // Problems last so a red or amber line is never hidden under a green one.
  const drawn = useMemo(() => edges
    .filter((e) => e && pos[String(e.a)] && pos[String(e.b)] && String(e.a) !== String(e.b))
    .sort((x, y) => (x.state === 'ok' ? 0 : 1) - (y.state === 'ok' ? 0 : 1)), [edges, pos]);

  const shapes = useMemo(() => {
    const placed = [];
    const out = {};
    drawn.forEach((e) => {
      const geo = edgeGeometry(pos[String(e.a)], pos[String(e.b)]);
      const text = edgeText(e);
      const w = pillW(text);
      const pt = pushClear(geo.at(0.5), geo.tangent(0.5), w, 20, [...rects, ...placed]);
      placed.push(pillRect(pt, w));
      out[e.key] = { geo, text, pt };
    });
    return out;
  }, [drawn, pos, rects]);

  const place = (ev, payload) => {
    const r = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;
    if (!r) return;
    setTip({ ...payload, x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width });
  };
  const placeAt = (sx, sy, payload) => {
    const r = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;
    if (!r) return;
    const k = r.width / MAP_W;
    setTip({ ...payload, x: sx * k, y: sy * k, w: r.width });
  };
  const clearTip = () => setTip(null);

  if (nodes.length === 0) {
    return <div className="panel p-6 text-sm text-ink-muted text-center">No sites to draw. Sites appear once a portal has been polled and circuits computed.</div>;
  }

  return (
    <div ref={wrapRef} className="relative panel overflow-hidden" onMouseLeave={clearTip} data-testid="circuit-map">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-3.5 text-[11px] text-ink-muted" data-testid="circuit-map-legend">
        <span className="text-ink-faint uppercase tracking-wide text-[10px]">Site WAN</span>
        {[['up', COLORS.ok], ['degraded', COLORS.warn], ['down', COLORS.crit], ['no WAN circuit', GREY]].map(([l, c]) => (
          <span key={l} className="inline-flex items-center"><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5" style={{ background: c }} />{l}</span>
        ))}
        <span className="text-ink-faint uppercase tracking-wide text-[10px] ml-2">Link</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.ok }} />ok</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.warn }} />some circuits down</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.crit }} />down</span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke={COLORS.warn} strokeWidth="2.5" strokeDasharray="6 4" /></svg>flapping
        </span>
      </div>

      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" className="block w-full h-auto" role="group" aria-label="Circuit map">
        {drawn.map((e) => {
          const sh = shapes[e.key];
          const col = edgeColor(e.state);
          const hover = tip && tip.kind === 'edge' && tip.key === e.key;
          const payload = { kind: 'edge', key: e.key, lines: edgeTip(e, nameOf) };
          return (
            <g key={e.key} data-edge={e.key} data-state={e.state}>
              <path d={sh.geo.d} fill="none" stroke="transparent" strokeWidth="18" style={{ cursor: 'pointer', outline: 'none' }}
                role="link" tabIndex={0} aria-label={`${nameOf(e.a)} to ${nameOf(e.b)}, ${e.state}`}
                onMouseEnter={(ev) => place(ev, payload)} onMouseMove={(ev) => place(ev, payload)} onMouseLeave={clearTip}
                onFocus={() => placeAt(sh.pt.x, sh.pt.y, payload)} onBlur={clearTip}
                onClick={() => onOpenEdge(e)} onKeyDown={(ev) => { if (ev.key === 'Enter') onOpenEdge(e); }} />
              <path d={sh.geo.d} fill="none" stroke={col} strokeWidth={edgeWidth(e.state) + (hover ? 2 : 0)}
                strokeDasharray={e.state === 'flapping' ? '7 4' : e.state === 'down' ? '4 2' : undefined} pointerEvents="none" />
              <Pill x={sh.pt.x} y={sh.pt.y} text={sh.text} color={col} />
            </g>
          );
        })}

        {nodes.map((n) => {
          const p = pos[String(n.siteKey)];
          if (!p) return null;
          const col = wanColor(n.wanState);
          const dead = Number(n.devicesDead) || 0;
          const hover = tip && tip.kind === 'node' && tip.key === n.siteKey;
          const payload = { kind: 'node', key: n.siteKey, lines: nodeTip(n) };
          const wt = Number(n.wanTotal) || 0;
          const sub = n.wanState ? `WAN ${Math.max(0, wt - (Number(n.wanDown) || 0))}/${wt} ${n.wanState}` : 'no WAN circuit';
          return (
            <g key={n.siteKey} transform={`translate(${p.x} ${p.y})`} role="button" tabIndex={0}
              aria-label={`${n.siteName || n.siteKey}, ${n.wanState ? `WAN ${n.wanState}` : 'no WAN'}`}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={(ev) => place(ev, payload)} onMouseMove={(ev) => place(ev, payload)} onMouseLeave={clearTip}
              onFocus={() => placeAt(p.x + HW, p.y + HH, payload)} onBlur={clearTip}
              onClick={() => onOpenSite(n.siteKey)} onKeyDown={(ev) => { if (ev.key === 'Enter') onOpenSite(n.siteKey); }}>
              <rect x={-HW} y={-HH} width={NODE_W} height={NODE_H} rx={12} fill={hover ? '#22303d' : '#18222C'} stroke={col} strokeWidth="2" />
              <text x={0} y={-2} textAnchor="middle" fontSize="13" fontWeight="700" fill="#E8EDF2">{short(n.siteName || String(n.siteKey), 20)}</text>
              <text x={0} y={14} textAnchor="middle" fontSize="10" fill="#94A3B3">{short(sub, 26)}</text>
              <circle cx={-HW + 10} cy={-HH + 10} r="4.5" fill={col} />
              {dead > 0 && (
                <g>
                  <circle cx={HW - 2} cy={-HH + 2} r="11" fill={COLORS.crit} stroke="#131B23" strokeWidth="3" />
                  <text x={HW - 2} y={-HH + 6} textAnchor="middle" fontSize="12" fontWeight="800" fill="#0B1015">{dead > 99 ? '99+' : dead}</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>

      {tip && <TipCard tip={tip} />}
    </div>
  );
}
