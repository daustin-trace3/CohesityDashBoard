import { useMemo, useRef, useState } from 'react';
import { fmtWhen } from '../helpers';
import {
  COLORS, NODE_W, NODE_H, MAP_W, layoutNodes, edgeGeometry, nodeRects, pushClear, pillRect, placeLabel, arcGeometry, groupEdges, edgeRank, worseEdge,
} from './layout';

const list = (v) => (Array.isArray(v) ? v : []);
const short = (v, n) => (v && v.length > n ? `${v.slice(0, n - 1)}~` : v || '');
const HW = NODE_W / 2;
const HH = NODE_H / 2;

const nodeColor = (s) => (s === 'critical' ? COLORS.crit : s === 'warning' ? COLORS.warn : COLORS.ok);
const edgeColor = (e) => { const r = edgeRank(e); return r >= 3 ? COLORS.crit : r === 2 ? COLORS.warn : COLORS.ok; };
const edgeWidth = (e) => { const r = edgeRank(e); return r >= 3 ? 2.5 : r === 2 ? 2 : 1.5; };

function rttText(e) {
  if (edgeRank(e) >= 3) return 'down';
  const v = Number(e.rttAvgMs);
  if (e.rttAvgMs == null || !Number.isFinite(v)) return 'no data';
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ms`;
}

const pillW = (text) => text.length * 6.6 + 14;

function Pill({ x, y, text, color }) {
  const w = pillW(text);
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={y - 10} width={w} height={20} rx={10} fill="#0B1015" stroke={color} strokeWidth="1" />
      <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill={color}>{text}</text>
    </g>
  );
}

function circuitFar(c) {
  return c && c.farSiteKey != null ? String(c.farSiteKey) : null;
}

function TipCard({ tip }) {
  const flip = tip.x > tip.w - 300;
  const style = { left: flip ? Math.max(0, tip.x - 294) : tip.x + 14, top: Math.max(0, tip.y + 14), width: 280 };
  return (
    <div className="absolute z-10 pointer-events-none rounded-lg border p-3 text-[11px] leading-relaxed shadow-modal" style={{ ...style, background: '#0B1015', borderColor: '#2b3b4b' }}>
      {tip.lines.map((l, i) => (
        <p key={i} className={l.cls || 'text-ink-muted'} style={l.bold ? { fontWeight: 700, fontSize: 13 } : undefined}>{l.text}</p>
      ))}
    </div>
  );
}

function edgeTipLines(group, nameOf) {
  const lines = [];
  group.edges.forEach((e) => {
    const checks = list(e.checks).slice(0, 3);
    lines.push({ text: `${nameOf(e.from)} to ${nameOf(e.to)}`, bold: true, cls: 'text-ink' });
    if (checks.length === 0) lines.push({ text: `${rttText(e)}${e.lossPct != null ? `, loss ${e.lossPct}%` : ''}` });
    checks.forEach((c) => {
      lines.push({ text: c.checkName || 'check', cls: 'text-ink', bold: false });
      lines.push({ text: `from ${c.checkpointLabel || nameOf(e.from)}, ${c.state || 'unknown'}${c.since ? ` since ${fmtWhen(c.since)}` : ''}` });
      const base = c.baselineRttMs != null ? `Baseline ${Math.round(c.baselineRttMs)} ms` : 'No baseline';
      const now = c.rttAvgMs != null ? `now ${Math.round(c.rttAvgMs)} ms` : 'no current RTT';
      lines.push({ text: `${base}, ${now}${c.lastGoodAt ? `, last good ${fmtWhen(c.lastGoodAt)}` : ''}` });
      if (c.lossPct != null) lines.push({ text: `Loss ${c.lossPct}%`, cls: Number(c.lossPct) > 0 ? 'text-status-crit' : 'text-ink-muted' });
      if (c.anomaly) lines.push({ text: String(c.anomaly), cls: 'text-status-warn' });
    });
    if (e.blame) {
      const where = [e.blame.deviceName, e.blame.port].filter(Boolean).join(' ');
      lines.push({ text: `Likely hop: ${where}${e.blame.reason ? ` (${e.blame.reason})` : ''}`, cls: 'text-ink font-semibold' });
    }
  });
  return lines;
}

export default function SiteMap({ map, onOpenSite, onOpenReachability }) {
  const nodes = list(map && map.nodes);
  const edges = list(map && map.edges);
  const circuits = list(map && map.circuits);
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null);

  const layout = useMemo(() => layoutNodes(nodes), [nodes]);
  const pos = layout.positions;
  const nodeByKey = useMemo(() => { const m = {}; nodes.forEach((n) => { if (n) m[String(n.siteKey)] = n; }); return m; }, [nodes]);
  const nameOf = (k) => (nodeByKey[String(k)] ? (nodeByKey[String(k)].siteName || String(k)) : String(k));

  const groups = useMemo(() => groupEdges(edges, pos), [edges, pos]);
  const worst = useMemo(() => {
    const bad = groups.map((g) => g.worst).filter((e) => edgeRank(e) >= 2);
    return bad.length ? bad.reduce(worseEdge) : null;
  }, [groups]);

  const rects = useMemo(() => nodeRects(pos), [pos]);
  const arcPairs = useMemo(() => {
    const set = new Set();
    circuits.forEach((c) => {
      const far = circuitFar(c);
      if (far && c.siteKey != null) set.add([String(c.siteKey), far].sort().join('|'));
    });
    return set;
  }, [circuits]);

  // Per pair: the curve or line, plus the (pushed) pill centres and the blame label.
  const shapes = useMemo(() => {
    const out = {};
    groups.forEach((g) => {
      const geo = edgeGeometry(pos[g.a], pos[g.b], { arcUp: arcPairs.has(`${g.a}|${g.b}`) });
      const both = g.edges.length > 1 && new Set(g.edges.map((e) => String(e.from))).size > 1;
      const place1 = (e, t) => {
        const text = rttText(e);
        const pt = pushClear(geo.at(t), geo.tangent(t), pillW(text), 20, rects);
        return { e, text, pt };
      };
      const pills = both ? g.edges.slice(0, 2).map((e) => place1(e, String(e.from) === g.a ? 0.36 : 0.64)) : [place1(g.worst, 0.5)];
      out[g.key] = { geo, pills };
    });
    return out;
  }, [groups, pos, arcPairs, rects]);

  const arcs = useMemo(() => {
    const seen = {};
    const out = [];
    circuits.forEach((c, i) => {
      const far = circuitFar(c);
      const near = c && c.siteKey != null ? String(c.siteKey) : null;
      if (!far || !near || far === near || !pos[far] || !pos[near]) return;
      const pk = [near, far].sort().join('|');
      seen[pk] = (seen[pk] || 0) + 1;
      const bow = 70 + (seen[pk] - 1) * 34;
      const p95 = Math.max(Number(c.p95InPct) || 0, Number(c.p95OutPct) || 0);
      out.push({ key: `${pk}#${i}`, c, near, far, geo: arcGeometry(pos[near], pos[far], bow), text: `${c.port || c.label || 'circuit'} p95 ${Math.round(p95)}%` });
    });
    return out;
  }, [circuits, pos]);

  // Placed after the pills and arcs exist so it can avoid every one of them.
  const blameLabel = useMemo(() => {
    if (!worst || !worst.blame) return null;
    const g = groups.find((x) => x.worst === worst);
    const sh = g && shapes[g.key];
    if (!sh) return null;
    const pill = sh.pills.find((p) => p.e === worst) || sh.pills[0];
    const text = `Likely hop: ${[worst.blame.deviceName, worst.blame.port].filter(Boolean).join(' ')}`;
    const w = text.length * 6.2 + 20;
    const others = [];
    Object.values(shapes).forEach((x) => x.pills.forEach((p) => { if (p !== pill) others.push(pillRect(p.pt, pillW(p.text))); }));
    arcs.forEach((a) => others.push(pillRect(a.geo.mid, pillW(a.text))));
    return { text, w, c: placeLabel(pill.pt, w, 18, [...others, ...rects], { width: layout.width, height: layout.height }) };
  }, [worst, groups, shapes, arcs, rects, layout]);

  const place = (e, payload) => {
    const r = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;
    if (!r) return;
    setTip({ ...payload, x: e.clientX - r.left, y: e.clientY - r.top, w: r.width });
  };
  const placeAt = (sx, sy, payload) => {
    const r = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;
    if (!r) return;
    const k = r.width / MAP_W;
    setTip({ ...payload, x: sx * k, y: sy * k, w: r.width });
  };
  const clearTip = () => setTip(null);

  if (nodes.length === 0) {
    return (
      <div className="panel p-6 text-sm text-ink-muted text-center">
        No sites derived yet. Sites come from device groups and hostname prefixes once a portal has been polled.
      </div>
    );
  }

  const nodeTip = (n) => {
    const cols = list(n.collectors);
    const lines = [
      { text: n.siteName || n.siteKey, bold: true, cls: 'text-ink' },
      { text: `State ${n.state || 'unknown'}, ${n.tier === 'dc' ? 'data center' : 'site'}` },
      { text: `${n.deviceCount ?? 0} devices (${n.networkCount ?? 0} network), ${n.devicesDead ?? 0} dead${n.devicesDeadCollector ? `, ${n.devicesDeadCollector} behind a down collector` : ''}` },
      { text: `${n.interfacesDown ?? 0} ports down, ${n.openIssues ?? 0} open issues` },
    ];
    if (n.circuitsSaturated) lines.push({ text: `${n.circuitsSaturated} saturated circuit(s)`, cls: 'text-status-warn' });
    if (cols.length) lines.push({ text: `Collectors: ${cols.map((c) => `${c.hostname}${c.isDown ? ' (down)' : ''}`).join(', ')}` });
    else if (n.viaCollector) lines.push({ text: `Polled via ${n.viaCollector}` });
    return lines;
  };

  return (
    <div ref={wrapRef} className="relative panel overflow-hidden" onMouseLeave={clearTip}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-3.5 text-[11px] text-ink-muted">
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.ok }} />Reachable</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.warn }} />Latency or loss</span>
        <span className="inline-flex items-center"><i className="inline-block w-[18px] h-[3px] rounded mr-1.5" style={{ background: COLORS.crit }} />Down</span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke={COLORS.warn} strokeWidth="2.5" strokeDasharray="6 4" /></svg>Saturated circuit
        </span>
        <span>Edges run from the collector site to the target site</span>
      </div>

      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet" className="block w-full h-auto" role="group" aria-label="Site map">
        {groups.map((g) => {
          const { geo, pills } = shapes[g.key];
          const w = g.worst;
          const col = edgeColor(w);
          const hover = tip && tip.kind === 'edge' && tip.key === g.key;
          const payload = { kind: 'edge', key: g.key, lines: edgeTipLines(g, nameOf) };
          return (
            <g key={g.key}>
              <path d={geo.d} fill="none" stroke="transparent" strokeWidth="18" style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => place(e, payload)} onMouseMove={(e) => place(e, payload)} onMouseLeave={clearTip} onClick={onOpenReachability} />
              <path d={geo.d} fill="none" stroke={col} strokeWidth={edgeWidth(w) + (hover ? 2 : 0)} strokeDasharray={edgeRank(w) >= 3 ? '4 2' : undefined} pointerEvents="none" />
              {pills.map((p) => <Pill key={p.e.key || `${p.e.from}>${p.e.to}`} x={p.pt.x} y={p.pt.y} text={p.text} color={edgeColor(p.e)} />)}
            </g>
          );
        })}

        {arcs.map((a) => {
          const hover = tip && tip.kind === 'arc' && tip.key === a.key;
          const c = a.c;
          const payload = {
            kind: 'arc', key: a.key,
            lines: [
              { text: `${[c.deviceName, c.port].filter(Boolean).join(' ') || 'Circuit'}`, bold: true, cls: 'text-ink' },
              c.label ? { text: c.label } : null,
              { text: `${nameOf(a.near)} to ${nameOf(a.far)}, ${c.state || 'saturated'}` },
              { text: `p95 in ${Math.round(Number(c.p95InPct) || 0)}%, out ${Math.round(Number(c.p95OutPct) || 0)}%`, cls: 'text-status-warn' },
            ].filter(Boolean),
          };
          const w = pillW(a.text);
          return (
            <g key={a.key}>
              <path d={a.geo.d} fill="none" stroke="transparent" strokeWidth="18" style={{ cursor: 'pointer' }}
                onMouseEnter={(e) => place(e, payload)} onMouseMove={(e) => place(e, payload)} onMouseLeave={clearTip} onClick={onOpenReachability} />
              <path d={a.geo.d} fill="none" stroke={COLORS.warn} strokeWidth={hover ? 4 : 2.5} strokeDasharray="6 4" pointerEvents="none" />
              <g pointerEvents="none">
                <rect x={a.geo.mid.x - w / 2} y={a.geo.mid.y - 10} width={w} height={20} rx={10} fill="#0B1015" stroke={COLORS.warn} />
                <text x={a.geo.mid.x} y={a.geo.mid.y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill={COLORS.warn}>{a.text}</text>
              </g>
            </g>
          );
        })}

        {nodes.map((n) => {
          if (!n || !pos[String(n.siteKey)]) return null;
          const p = pos[String(n.siteKey)];
          const col = nodeColor(n.state);
          const cols = list(n.collectors);
          const lead = cols.find((c) => c && c.isDown) || cols[0];
          const sub = lead
            ? `${lead.hostname}${lead.isDown ? ' DOWN' : ''}${cols.length > 1 ? ` +${cols.length - 1}` : ''}`
            : (n.viaCollector ? `via ${n.viaCollector}` : 'no collector');
          const dead = Number(n.devicesDead) || 0;
          const deadBehind = Number(n.devicesDeadCollector) || 0;
          const badge = dead > 0 ? { n: dead, c: COLORS.crit } : deadBehind > 0 ? { n: deadBehind, c: COLORS.warn } : null;
          const anyDown = cols.some((c) => c && c.isDown);
          const hover = tip && tip.kind === 'node' && tip.key === n.siteKey;
          const payload = { kind: 'node', key: n.siteKey, lines: nodeTip(n) };
          return (
            <g
              key={n.siteKey}
              transform={`translate(${p.x} ${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${n.siteName || n.siteKey}, ${n.state || 'unknown'}`}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={(e) => place(e, payload)}
              onMouseMove={(e) => place(e, payload)}
              onMouseLeave={clearTip}
              onFocus={() => placeAt(p.x + HW, p.y + HH, payload)}
              onBlur={clearTip}
              onClick={() => onOpenSite(n.siteKey)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpenSite(n.siteKey); }}
            >
              <rect x={-HW} y={-HH} width={NODE_W} height={NODE_H} rx={12} fill={hover ? '#22303d' : '#18222C'} stroke={col} strokeWidth="2" />
              <text x={0} y={-2} textAnchor="middle" fontSize="13" fontWeight="700" fill="#E8EDF2">{short(n.siteName || String(n.siteKey), 20)}</text>
              <text x={0} y={14} textAnchor="middle" fontSize="10" fill="#94A3B3">{short(sub, 26)}</text>
              <circle cx={-HW + 10} cy={-HH + 10} r="4.5" fill={col} />
              {badge && (
                <g>
                  <circle cx={HW - 2} cy={-HH + 2} r="11" fill={badge.c} stroke="#131B23" strokeWidth="3" />
                  <text x={HW - 2} y={-HH + 6} textAnchor="middle" fontSize="12" fontWeight="800" fill="#0B1015">{badge.n > 99 ? '99+' : badge.n}</text>
                </g>
              )}
              {anyDown && <circle cx={HW - 2} cy={HH - 2} r="8" fill={COLORS.warn} stroke="#131B23" strokeWidth="3" />}
            </g>
          );
        })}
        {blameLabel && (
          <g pointerEvents="none" data-blame-label="1">
            <rect x={blameLabel.c.x - blameLabel.w / 2} y={blameLabel.c.y - 9} width={blameLabel.w} height={18} rx={6} fill="#2a1618" stroke={COLORS.crit} />
            <text x={blameLabel.c.x} y={blameLabel.c.y + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill={COLORS.crit}>{blameLabel.text}</text>
          </g>
        )}
      </svg>

      {tip && <TipCard tip={tip} />}
    </div>
  );
}
