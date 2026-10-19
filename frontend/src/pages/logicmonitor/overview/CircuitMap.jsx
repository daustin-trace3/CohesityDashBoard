import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  COLORS, MAP_W, layoutNodes, edgeGeometry, nodeRects, pushClear, pillRect,
} from './layout';
import { fmtWhen } from '../helpers';
import { SiteCard, EdgeCard } from './PinnedCards';

// Circuit map (round 13): sites as nodes coloured by WAN state, site-link
// circuits as edges coloured by state. Geometry comes from layout.js (the same
// tiers and collision rules as the Overview site map); the data shape is the
// GET /logicmonitor/circuit-map answer. Pure presentation: the page owns
// fetching, filtering and navigation.

const list = (v) => (Array.isArray(v) ? v : []);
const short = (v, n) => (v && v.length > n ? `${v.slice(0, n - 1)}~` : v || '');
// The circuit map draws smaller tiles than the Overview site map (layout.js constants stay untouched).
const NW = 120;
const NH = 38;
const HW = NW / 2;
const HH = NH / 2;
const ROW_SCALE = 0.8; // layout.js rows are 150 apart; here about 120
const PILL_H = 16;
const GREY = '#6B7C8D';

export const wanColor = (s) => (s === 'down' ? COLORS.crit : s === 'degraded' ? COLORS.warn : s === 'ok' ? COLORS.ok : GREY);
// Node colour follows the site overall state; grey only when it has no WAN and nothing wrong.
export const nodeColor = (n) => {
  const w = n.worstState;
  if (w === 'down') return COLORS.crit;
  if (w === 'degraded') return COLORS.warn;
  if (w === 'ok') return n.wanState || (Number(n.openIssues) || 0) > 0 || (Number(n.devicesDead) || 0) > 0 ? COLORS.ok : GREY;
  return wanColor(n.wanState);
};
export const edgeColor = (s) => (s === 'down' ? COLORS.crit : s === 'degraded' || s === 'flapping' ? COLORS.warn : COLORS.ok);
const edgeWidth = (s) => (s === 'down' ? 3 : s === 'ok' ? 1.75 : 2.5);
const edgeText = (e) => {
  const n = list(e.circuits).length;
  if (e.state === 'down') return n > 1 ? `down x${n}` : 'down';
  if (e.state === 'flapping') return 'flapping';
  if (e.state === 'degraded') return `${list(e.circuits).filter((c) => c.state === 'down').length || 1} of ${n} down`;
  return `${n || 1} ckt`;
};
const pillW = (t) => t.length * 5.6 + 10;

// Layout constants for the unlinked-site chips (sites with no site link are not part of the tiered graph).
const CHIP_W = 110;
const CHIP_H = 26;
const CHIP_GAP = 6;
const SIDE_W = 180;

/** Sites that take part in at least one drawn site link, and the rest. */
export function splitLinked(nodes, edges) {
  const have = new Set(list(nodes).map((n) => String(n.siteKey)));
  const touched = new Set();
  list(edges).forEach((e) => {
    if (e && have.has(String(e.a)) && have.has(String(e.b)) && String(e.a) !== String(e.b)) { touched.add(String(e.a)); touched.add(String(e.b)); }
  });
  const linked = list(nodes).filter((n) => touched.has(String(n.siteKey)));
  return { linked, unlinked: list(nodes).filter((n) => !touched.has(String(n.siteKey))) };
}

// Motion is CSS only and animates stroke-dashoffset and opacity, nothing else. Reduced-motion users get a static map.
const MOTION_CSS = `
@media (prefers-reduced-motion: no-preference) {
  @keyframes cmap-flow { to { stroke-dashoffset: -12; } }
  @keyframes cmap-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes cmap-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
  .cmap-edge-ok { stroke-dasharray: 6 6; animation: cmap-flow 3s linear infinite; }
  .cmap-edge-degraded { stroke-dasharray: 6 6; animation: cmap-flow 1.5s linear infinite; }
  .cmap-edge-down { animation: cmap-pulse 1.4s ease-in-out infinite; }
  .cmap-edge-flapping { animation: cmap-blink 0.9s ease-in-out infinite; }
  .cmap-dot-warn, .cmap-dot-crit { animation: cmap-pulse 2.2s ease-in-out infinite; }
}`;

function Pill({ x, y, text, color }) {
  const w = pillW(text);
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={y - PILL_H / 2} width={w} height={PILL_H} rx={PILL_H / 2} fill="#0B1015" stroke={color} strokeWidth="1" />
      <text x={x} y={y + 3.5} textAnchor="middle" fontSize="10" fontWeight="600" fill={color}>{text}</text>
    </g>
  );
}

function TipCard({ tip }) {
  const flip = tip.x > tip.w - 320;
  const style = { left: flip ? Math.max(0, tip.x - 314) : tip.x + 14, top: Math.max(0, tip.y + 14), width: 300 };
  return (
    <div className="absolute z-10 pointer-events-none rounded-lg border p-3 text-[11px] leading-relaxed shadow-modal" style={{ ...style, background: '#0B1015', borderColor: '#2b3b4b' }} role="tooltip">
      {tip.lines.map((l, i) => (
        <p key={i} title={l.title} className={l.cls || 'text-ink-muted'} style={l.bold ? { fontWeight: 700, fontSize: 13 } : undefined}>{l.text}</p>
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

export function nodeTip(n) {
  const dead = list(n.deadDevices);
  const deg = list(n.degradedDevices);
  const top = list(n.issuesTop);
  const lines = [
    { text: n.siteName || n.siteKey, bold: true, cls: 'text-ink' },
    wanLine(n),
  ];
  list(n.reasons).forEach((r) => lines.push({ text: r, cls: 'text-ink' }));
  lines.push({ text: n.tier === 'dc' ? 'Data center' : 'Site' });
  if (dead.length) {
    lines.push({ text: `Dead devices (${n.devicesDead ?? dead.length})`, cls: 'text-status-crit font-semibold' });
    dead.slice(0, 10).forEach((d) => lines.push({ text: d }));
  }
  if (deg.length) {
    lines.push({ text: 'Degraded devices', cls: 'text-status-warn font-semibold' });
    deg.slice(0, 10).forEach((d) => lines.push({ text: d }));
  }
  if ((Number(n.openIssues) || 0) > 0 || top.length) {
    lines.push({ text: `Open issues (${n.openIssues ?? top.length})`, cls: 'text-status-warn font-semibold' });
    top.slice(0, 5).forEach((i) => lines.push({ text: `${i.severity} ${i.type}: ${short(i.target, 60)}`, title: i.target }));
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

const CARD_W = 420;

/**
 * Pinned card host: a fixed-position portal on document.body so no scroll container clips it.
 * Left prefers the right of the anchor, flips to its left, then clamps into the viewport; top starts at
 * the anchor and is clamped once the real height is measured (again when the content grows).
 */
function PinnedFloat({ anchor, panel, width, children }) {
  const ref = useRef(null);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight, ch: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const ch = ref.current ? ref.current.offsetHeight : 0;
      setVp((cur) => (cur.ch === ch && cur.w === window.innerWidth && cur.h === window.innerHeight ? cur : { w: window.innerWidth, h: window.innerHeight, ch }));
    };
    measure();
    window.addEventListener('resize', measure);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && ref.current) { ro = new ResizeObserver(measure); ro.observe(ref.current); }
    return () => { window.removeEventListener('resize', measure); if (ro) ro.disconnect(); };
  }, []);
  let style;
  if (panel) {
    style = { position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(420px, 100vw)', maxHeight: '100vh' };
  } else {
    let left = anchor.right + 12;
    if (left + width + 8 > vp.w) left = anchor.left - 12 - width;
    left = Math.max(8, Math.min(left, vp.w - width - 8));
    const top = Math.max(8, Math.min(anchor.top, vp.h - vp.ch - 8));
    style = { position: 'fixed', left, top, width };
  }
  return createPortal(
    <div ref={ref} className="rounded-lg border shadow-modal" data-testid="pinned-float" style={{ ...style, zIndex: 60, background: '#0B1015', borderColor: '#2b3b4b' }} onClick={(ev) => ev.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export default function CircuitMap({ nodes: nodesIn, edges: edgesIn, onOpenSite, onOpenEdge, onOpenIssues = () => {}, overrides = null, onMove = () => {} }) {
  const nodes = list(nodesIn);
  const edges = list(edgesIn);
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null);
  const svgRef = useRef(null);
  // Drag state: the ref holds the gesture, `live` is the dragged node position while moving.
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const [live, setLive] = useState(null);
  // One pinned card at a time: { kind: 'node'|'edge', key, left, top, panel }.
  const [pinned, setPinned] = useState(null);
  useEffect(() => {
    if (!pinned) return undefined;
    const onKey = (ev) => { if (ev.key === 'Escape') setPinned(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pinned]);

  const { linked, unlinked } = useMemo(() => splitLinked(nodes, edges), [nodes, edges]);
  // Only linked sites take part in the tiered layout. Unlinked sites are chips in a column on the right when
  // it fits next to the graph, else a grid below it. The viewBox width stays MAP_W either way.
  const layout = useMemo(() => {
    const raw = linked.length ? layoutNodes(linked) : { width: MAP_W, height: 0, positions: {} };
    const base = { ...raw, height: Math.round(raw.height * ROW_SCALE), positions: Object.fromEntries(Object.entries(raw.positions).map(([k, p]) => [k, { ...p, y: Math.round(p.y * ROW_SCALE) }])) };
    const colH = unlinked.length * (CHIP_H + CHIP_GAP) + 34;
    const side = unlinked.length > 0 && linked.length > 0 && colH <= base.height;
    const k = side ? (MAP_W - SIDE_W) / MAP_W : 1;
    const positions = {};
    Object.entries(base.positions).forEach(([key, p]) => { positions[key] = { ...p, x: Math.round(p.x * k) }; });
    const chips = {};
    let height = base.height;
    if (side) {
      unlinked.forEach((n, i) => { chips[String(n.siteKey)] = { x: MAP_W - SIDE_W + 24, y: 34 + i * (CHIP_H + CHIP_GAP) }; });
    } else if (unlinked.length) {
      const cols = Math.max(1, Math.floor((MAP_W - 40) / (CHIP_W + 10)));
      const top = base.height ? base.height + 28 : 28;
      unlinked.forEach((n, i) => { chips[String(n.siteKey)] = { x: 20 + (i % cols) * (CHIP_W + 10), y: top + Math.floor(i / cols) * (CHIP_H + CHIP_GAP) }; });
      height = top + Math.ceil(unlinked.length / cols) * (CHIP_H + CHIP_GAP) + 10;
    }
    return { width: MAP_W, height: Math.max(height, 60), positions, chips, side, chipsTop: side ? 0 : (base.height || 0), graphW: side ? MAP_W - SIDE_W : MAP_W, graphH: base.height };
  }, [linked, unlinked]);
  const clampPt = (pt) => ({
    x: Math.round(Math.min(Math.max(pt.x, HW), Math.max(HW, layout.graphW - HW))),
    y: Math.round(Math.min(Math.max(pt.y, HH), Math.max(HH, layout.graphH - HH))),
  });
  // layout.js placement, then saved overrides, then the node being dragged right now.
  const pos = useMemo(() => {
    const out = { ...layout.positions };
    Object.keys(out).forEach((k) => {
      const o = overrides && overrides[k];
      if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) out[k] = { ...out[k], ...clampPt(o) };
    });
    if (live && out[live.key]) out[live.key] = { ...out[live.key], x: live.x, y: live.y };
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, overrides, live]);
  const nodeByKey = useMemo(() => { const m = {}; nodes.forEach((n) => { m[String(n.siteKey)] = n; }); return m; }, [nodes]);
  const nameOf = (k) => (nodeByKey[String(k)] ? (nodeByKey[String(k)].siteName || String(k)) : String(k));
  const rects = useMemo(() => nodeRects(pos, 8, NW, NH), [pos]);

  // Problems last so a red or amber line is never hidden under a green one.
  const drawn = useMemo(() => edges
    .filter((e) => e && pos[String(e.a)] && pos[String(e.b)] && String(e.a) !== String(e.b))
    .sort((x, y) => (x.state === 'ok' ? 0 : 1) - (y.state === 'ok' ? 0 : 1)), [edges, pos]);

  const shapes = useMemo(() => {
    const placed = [];
    const out = {};
    drawn.forEach((e) => {
      const geo = edgeGeometry(pos[String(e.a)], pos[String(e.b)], { hw: HW, hh: HH });
      const text = edgeText(e);
      const w = pillW(text);
      const pt = pushClear(geo.at(0.5), geo.tangent(0.5), w, PILL_H, [...rects, ...placed]);
      placed.push(pillRect(pt, w, PILL_H));
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
  const CARD_W = 420;
  // The card is a fixed-position portal, so the anchor is a viewport rect: the clicked element when given,
  // else the wrapper rect plus the map coordinates.
  const pin = (kind, key, sx, sy, halfW, el) => {
    const wr = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;
    const w = wr && wr.width ? wr.width : MAP_W;
    const k = w / MAP_W;
    const er = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const anchor = er
      ? { left: er.left, right: er.right, top: er.top }
      : { left: (wr ? wr.left : 0) + (sx - halfW) * k, right: (wr ? wr.left : 0) + (sx + halfW) * k, top: (wr ? wr.top : 0) + (sy - HH) * k };
    const panel = typeof window !== 'undefined' && window.innerWidth < 768;
    setTip(null);
    setPinned({ kind, key, anchor, panel });
  };

  // Pointer drag for linked nodes: a 4 px move starts it, so a plain click still pins the card.
  const viewScale = () => {
    const r = svgRef.current ? svgRef.current.getBoundingClientRect() : null;
    return r && r.width ? r.width / layout.width : 1;
  };
  const onNodeDown = (ev, n, p) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    dragRef.current = { key: String(n.siteKey), cx: ev.clientX, cy: ev.clientY, ox: p.x, oy: p.y, moved: false };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* not supported */ }
  };
  const onNodeMove = (ev) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = ev.clientX - d.cx;
    const dy = ev.clientY - d.cy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const k = viewScale();
    setTip(null);
    const pt = clampPt({ x: d.ox + dx / k, y: d.oy + dy / k });
    d.last = pt;
    setLive({ key: d.key, ...pt });
  };
  const onNodeUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 0);
    setLive(null);
    if (d.last) onMove(d.key, d.last);
  };
  const onNodeKey = (ev, n, p) => {
    if (ev.key === 'Enter') { pin('node', n.siteKey, p.x, p.y, HW, ev.currentTarget); return; }
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[ev.key];
    if (!step) return;
    ev.preventDefault();
    onMove(String(n.siteKey), clampPt({ x: p.x + step[0], y: p.y + step[1] }));
  };
  const onNodeClick = (ev, n, p) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    pin('node', n.siteKey, p.x, p.y, HW, ev.currentTarget);
  };

  if (nodes.length === 0) {
    return <div className="panel p-6 text-sm text-ink-muted text-center">No sites to draw. Sites appear once a portal has been polled and circuits computed.</div>;
  }

  return (
    <div ref={wrapRef} className="relative panel overflow-hidden" onMouseLeave={clearTip} data-testid="circuit-map">
      <style>{MOTION_CSS}</style>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-3.5 text-[11px] text-ink-muted" data-testid="circuit-map-legend">
        <span className="text-ink-faint uppercase tracking-wide text-[10px]">Site WAN</span>
        {[['up', COLORS.ok], ['degraded', COLORS.warn], ['down', COLORS.crit], ['no WAN circuit', GREY]].map(([l, c]) => (
          <span key={l} className="inline-flex items-center"><i className="inline-block w-2.5 h-2.5 rounded-full mr-1.5" style={{ background: c }} />{l}</span>
        ))}
        <span className="text-ink-faint uppercase tracking-wide text-[10px] ml-2">Site state</span>
        {[['up', COLORS.ok], ['degraded', COLORS.warn], ['down', COLORS.crit]].map(([l, c]) => (
          <span key={`s-${l}`} className="inline-flex items-center"><i className="inline-block w-3 h-2.5 rounded-sm mr-1.5" style={{ border: `2px solid ${c}`, background: `${c}22` }} />{l}</span>
        ))}
        <span className="text-ink-faint uppercase tracking-wide text-[10px] ml-2">Link</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.ok }} />ok</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.warn }} />some circuits down</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.crit }} />down</span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke={COLORS.warn} strokeWidth="2.5" strokeDasharray="6 4" /></svg>flapping
        </span>
      </div>

      <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" className="block w-full h-auto" role="group" aria-label="Circuit map">
        <rect data-testid="map-bg" x="0" y="0" width={layout.width} height={layout.height} fill="transparent" onClick={() => setPinned(null)} />
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
                onClick={() => pin('edge', e.key, sh.pt.x, sh.pt.y, 0)} onKeyDown={(ev) => { if (ev.key === 'Enter') pin('edge', e.key, sh.pt.x, sh.pt.y, 0); }} />
              <path d={sh.geo.d} fill="none" stroke={col} strokeWidth={edgeWidth(e.state) + (hover ? 2 : 0)} className={`cmap-edge-${e.state}`}
                strokeDasharray={e.state === 'flapping' ? '7 4' : e.state === 'down' ? '4 2' : undefined} pointerEvents="none" />
              <Pill x={sh.pt.x} y={sh.pt.y} text={sh.text} color={col} />
            </g>
          );
        })}

        {linked.map((n) => {
          const p = pos[String(n.siteKey)];
          if (!p) return null;
          const col = nodeColor(n);
          const wcol = wanColor(n.wanState);
          const dead = Number(n.devicesDead) || 0;
          const hover = tip && tip.kind === 'node' && tip.key === n.siteKey;
          const payload = { kind: 'node', key: n.siteKey, lines: nodeTip(n) };
          const wt = Number(n.wanTotal) || 0;
          const sub = n.wanState ? `WAN ${Math.max(0, wt - (Number(n.wanDown) || 0))}/${wt} ${n.wanState}` : 'no WAN circuit';
          return (
            <g key={n.siteKey} data-testid="graph-node" data-x={p.x} data-y={p.y} transform={`translate(${p.x} ${p.y})`} role="button" tabIndex={0}
              aria-label={`${n.siteName || n.siteKey}, ${n.wanState ? `WAN ${n.wanState}` : 'no WAN'}`}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={(ev) => place(ev, payload)} onMouseMove={(ev) => place(ev, payload)} onMouseLeave={clearTip}
              onFocus={() => placeAt(p.x + HW, p.y + HH, payload)} onBlur={clearTip}
              onPointerDown={(ev) => onNodeDown(ev, n, p)} onPointerMove={onNodeMove} onPointerUp={onNodeUp} onPointerCancel={onNodeUp}
              onClick={(ev) => onNodeClick(ev, n, p)} onKeyDown={(ev) => onNodeKey(ev, n, p)}>
              <rect x={-HW} y={-HH} width={NW} height={NH} rx={10} fill={hover ? '#22303d' : '#18222C'} stroke={col} strokeWidth="2" />
              <rect x={-HW} y={-HH} width={NW} height={NH} rx={10} fill={col} fillOpacity="0.09" pointerEvents="none" />
              <rect x={-HW + 10} y={-HH} width={NW - 20} height={3} fill={col} pointerEvents="none" />
              <text x={0} y={-1} textAnchor="middle" fontSize="12" fontWeight="700" fill="#E8EDF2">{short(n.siteName || String(n.siteKey), 16)}</text>
              <text x={0} y={11} textAnchor="middle" fontSize="10" fill="#94A3B3">{short(sub, 22)}</text>
              <circle cx={-HW + 9} cy={-HH + 10} r="5" fill={wcol} className={n.wanState === 'down' ? 'cmap-dot-crit' : n.wanState === 'degraded' ? 'cmap-dot-warn' : undefined} />
              {dead > 0 && (
                <g>
                  <circle cx={HW - 2} cy={-HH + 2} r="7" fill={COLORS.crit} stroke="#131B23" strokeWidth="2" />
                  <text x={HW - 2} y={-HH + 5.5} textAnchor="middle" fontSize="9" fontWeight="800" fill="#0B1015">{dead > 99 ? '99+' : dead}</text>
                </g>
              )}
            </g>
          );
        })}

        {unlinked.length > 0 && (
          <text x={layout.side ? MAP_W - SIDE_W + 24 : 20} y={layout.side ? 20 : layout.chipsTop + 18} fontSize="11" fill="#94A3B3">{`Not linked (${unlinked.length})`}</text>
        )}
        {unlinked.map((n) => {
          const c = layout.chips[String(n.siteKey)];
          if (!c) return null;
          const col = nodeColor(n);
          const wcol = wanColor(n.wanState);
          const hover = tip && tip.kind === 'node' && tip.key === n.siteKey;
          const payload = { kind: 'node', key: n.siteKey, lines: nodeTip(n) };
          return (
            <g key={n.siteKey} data-testid="unlinked-chip" transform={`translate(${c.x} ${c.y})`} role="button" tabIndex={0}
              aria-label={`${n.siteName || n.siteKey}, ${n.wanState ? `WAN ${n.wanState}` : 'no WAN'}`}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={(ev) => place(ev, payload)} onMouseMove={(ev) => place(ev, payload)} onMouseLeave={clearTip}
              onFocus={() => placeAt(c.x + CHIP_W, c.y + CHIP_H, payload)} onBlur={clearTip}
              onClick={(ev) => pin('node', n.siteKey, c.x + CHIP_W / 2, c.y + CHIP_H / 2, CHIP_W / 2, ev.currentTarget)} onKeyDown={(ev) => { if (ev.key === 'Enter') pin('node', n.siteKey, c.x + CHIP_W / 2, c.y + CHIP_H / 2, CHIP_W / 2, ev.currentTarget); }}>
              <rect width={CHIP_W} height={CHIP_H} rx={8} fill={hover ? '#22303d' : '#18222C'} stroke={col} strokeWidth="1.5" />
              <rect width={CHIP_W} height={CHIP_H} rx={8} fill={col} fillOpacity="0.09" pointerEvents="none" />
              <rect x={8} y={0} width={CHIP_W - 16} height={2.5} fill={col} pointerEvents="none" />
              <circle cx={11} cy={CHIP_H / 2} r="4" fill={wcol} className={n.wanState === 'down' ? 'cmap-dot-crit' : n.wanState === 'degraded' ? 'cmap-dot-warn' : undefined} />
              <text x={22} y={CHIP_H / 2 + 4} fontSize="11" fontWeight="600" fill="#E8EDF2">{short(n.siteName || String(n.siteKey), 13)}</text>
            </g>
          );
        })}
      </svg>

      {tip && !(pinned && pinned.kind === tip.kind && String(pinned.key) === String(tip.key)) && <TipCard tip={tip} />}
      {pinned && (() => {
        const n = pinned.kind === 'node' ? nodeByKey[String(pinned.key)] : null;
        const e = pinned.kind === 'edge' ? edges.find((x) => x.key === pinned.key) : null;
        if (!n && !e) return null;
        return (
          <PinnedFloat anchor={pinned.anchor} panel={pinned.panel} width={CARD_W}>
            {n ? <SiteCard key={n.siteKey} node={n} onClose={() => setPinned(null)} onOpenSite={onOpenSite} onOpenIssues={onOpenIssues} />
              : <EdgeCard key={e.key} edge={e} nameOf={nameOf} onClose={() => setPinned(null)} onOpenEdge={onOpenEdge} />}
          </PinnedFloat>
        );
      })()}
    </div>
  );
}
