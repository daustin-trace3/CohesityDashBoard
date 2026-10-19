// Pure geometry for the LogicMonitor Overview site map. No React, no DOM.
// Deterministic: the same nodes always produce the same positions.

export const MAP_W = 1400;
export const NODE_W = 150;
export const NODE_H = 48;
export const ROW_GAP = 150;
export const MIN_H = 360;
export const MAX_PER_ROW = 6;

export const COLORS = { crit: '#F87171', warn: '#FBBF24', ok: '#6CB33F', info: '#60A5FA' };

const list = (v) => (Array.isArray(v) ? v : []);
const nameOf = (n) => String((n && (n.siteName || n.siteKey)) || '');
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b)) || String(a.siteKey).localeCompare(String(b.siteKey));

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Tier dc nodes go on the centre row(s). The rest are sorted by name and dealt
// alternately to the rows above and below the centre, nearest row first, at
// most MAX_PER_ROW per row, so more than 12 of them add a further pair of rows.
export function layoutNodes(nodes) {
  const all = list(nodes).filter((n) => n && n.siteKey != null);
  const dc = all.filter((n) => n.tier === 'dc').sort(byName);
  const rest = all.filter((n) => n.tier !== 'dc').sort(byName);
  const above = rest.filter((_, i) => i % 2 === 0);
  const below = rest.filter((_, i) => i % 2 === 1);
  const rows = [
    ...chunk(above, MAX_PER_ROW).reverse().map((r) => ({ dir: -1, nodes: r })),
    ...chunk(dc, MAX_PER_ROW).map((r) => ({ dir: 0, nodes: r })),
    ...chunk(below, MAX_PER_ROW).map((r) => ({ dir: 1, nodes: r })),
  ];
  // Rows are 150 apart; the band above the first and below the last row is 75 px.
  const height = Math.max(MIN_H, rows.length * ROW_GAP);
  const first = (height - Math.max(0, rows.length - 1) * ROW_GAP) / 2;
  const positions = {};
  rows.forEach((row, r) => {
    row.nodes.forEach((n, i) => {
      positions[String(n.siteKey)] = {
        x: Math.round((MAP_W * (i + 1)) / (row.nodes.length + 1)), y: Math.round(first + r * ROW_GAP), row: r, col: i, dir: row.dir,
      };
    });
  });
  return { width: MAP_W, height, rowCount: rows.length, positions };
}

// Point where the line from centre a toward b leaves a's node rectangle.
export function clipToBorder(a, b, hw = NODE_W / 2, hh = NODE_H / 2) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { x: a.x, y: a.y };
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: a.x + dx * t, y: a.y + dy * t };
}

// Straight edge between two node centres, shortened to both borders.
export function edgeLine(a, b, hw = NODE_W / 2, hh = NODE_H / 2) {
  const p1 = clipToBorder(a, b, hw, hh);
  const p2 = clipToBorder(b, a, hw, hh);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

export function lerp(line, t) {
  return { x: line.x1 + (line.x2 - line.x1) * t, y: line.y1 + (line.y2 - line.y1) * t };
}

// Quadratic arc between two node borders, bowed to the upper side of the
// straight line (or the right side for a perfectly horizontal pair).
// bow is the control point offset in px; mid is the point on the curve at t=0.5.
export function arcGeometry(a, b, bow = 70) {
  const line = edgeLine(a, b);
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; }
  const mx = (line.x1 + line.x2) / 2;
  const my = (line.y1 + line.y2) / 2;
  const cx = mx + nx * bow;
  const cy = my + ny * bow;
  const f = (n) => Math.round(n * 10) / 10;
  return {
    d: `M${f(line.x1)} ${f(line.y1)} Q${f(cx)} ${f(cy)} ${f(line.x2)} ${f(line.y2)}`,
    mid: { x: (line.x1 + line.x2) / 4 + cx / 2, y: (line.y1 + line.y2) / 4 + cy / 2 },
  };
}

export function edgeRank(e) {
  const s = String((e && e.state) || '').toLowerCase();
  const v = String((e && e.severity) || '').toLowerCase();
  if (s === 'down' || (!s && v === 'critical')) return 3;
  if (s === 'degraded' || (!s && v === 'warning')) return 2;
  if (s === 'ok' || v === 'ok') return 1;
  return 0;
}

export function worseEdge(a, b) {
  const ra = edgeRank(a);
  const rb = edgeRank(b);
  if (ra !== rb) return ra > rb ? a : b;
  if (!!a.blame !== !!b.blame) return a.blame ? a : b;
  return (Number(b.rttAvgMs) || 0) > (Number(a.rttAvgMs) || 0) ? b : a;
}

// Groups edges by unordered site pair so a pair seen from both ends draws one
// line. Edges to or from a site without a position, and self-pairs, are dropped.
export function groupEdges(edges, positions) {
  const groups = new Map();
  list(edges).forEach((e) => {
    if (!e || e.from == null || e.to == null) return;
    const f = String(e.from);
    const t = String(e.to);
    if (f === t || !positions[f] || !positions[t]) return;
    const [a, b] = f < t ? [f, t] : [t, f];
    const key = `${a}|${b}`;
    if (!groups.has(key)) groups.set(key, { key, a, b, edges: [] });
    groups.get(key).edges.push(e);
  });
  return [...groups.values()].map((g) => ({ ...g, worst: g.edges.reduce(worseEdge) }));
}

export const BOW_PER_NODE = 70;
export const BOW_CAP = 160;

// Edge shape between two positioned nodes. Neighbours and nodes on different
// rows get a straight line. Two non-neighbours on the same row get a quadratic
// curve bowed away from the centre row (below it for the centre row), so the
// line never crosses a node box. With arcUp true a circuit arc owns the space
// above, so the edge bows down. Returns the path plus at(t) and tangent(t).
export function edgeGeometry(a, b, opts = {}) {
  const skipped = a.row === b.row ? Math.abs(a.col - b.col) - 1 : 0;
  if (skipped < 1) {
    const line = edgeLine(a, b, opts.hw, opts.hh);
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    const len = Math.hypot(dx, dy) || 1;
    return {
      d: `M${line.x1} ${line.y1} L${line.x2} ${line.y2}`, curved: false,
      at: (t) => lerp(line, t), tangent: () => ({ x: dx / len, y: dy / len }),
    };
  }
  const bow = Math.min(BOW_CAP, BOW_PER_NODE * skipped);
  const dirY = opts.arcUp || a.dir !== -1 ? 1 : -1;
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + dirY * bow };
  const p0 = clipToBorder(a, c, opts.hw, opts.hh);
  const p1 = clipToBorder(b, c, opts.hw, opts.hh);
  const f = (n) => Math.round(n * 10) / 10;
  return {
    d: `M${f(p0.x)} ${f(p0.y)} Q${f(c.x)} ${f(c.y)} ${f(p1.x)} ${f(p1.y)}`, curved: true, ctrl: c,
    at: (t) => ({
      x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p1.x,
      y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p1.y,
    }),
    tangent: (t) => {
      const dx = 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p1.x - c.x);
      const dy = 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p1.y - c.y);
      const len = Math.hypot(dx, dy) || 1;
      return { x: dx / len, y: dy / len };
    },
  };
}

// Node rectangles, grown by a margin so the corner badges count as part of the node.
export function nodeRects(positions, margin = 12, w = NODE_W, h = NODE_H) {
  return Object.values(positions || {}).map((p) => ({ x1: p.x - w / 2 - margin, y1: p.y - h / 2 - margin, x2: p.x + w / 2 + margin, y2: p.y + h / 2 + margin }));
}

const hits = (cx, cy, w, h, rects) => rects.some((r) => cx - w / 2 < r.x2 && cx + w / 2 > r.x1 && cy - h / 2 < r.y2 && cy + h / 2 > r.y1);

// Moves a w x h box centred at pt off any node rectangle, stepping 30 px along
// the edge direction (alternating forward and back) up to 3 steps each way.
// Returns pt unchanged when it is already clear or no step clears it.
export function pushClear(pt, dir, w, h, rects) {
  if (!hits(pt.x, pt.y, w, h, rects)) return pt;
  for (let k = 1; k <= 3; k += 1) {
    for (const sgn of [1, -1]) {
      const q = { x: pt.x + dir.x * 30 * k * sgn, y: pt.y + dir.y * 30 * k * sgn };
      if (!hits(q.x, q.y, w, h, rects)) return q;
    }
  }
  return pt;
}

const rectsHit = (c, w, h, rects) => rects.some((r) => c.x - w / 2 < r.x2 && c.x + w / 2 > r.x1 && c.y - h / 2 < r.y2 && c.y + h / 2 > r.y1);

// Rectangle of a w x 20 pill centred at pt, in the {x1,y1,x2,y2} form pushClear and placeLabel take.
export function pillRect(pt, w, h = 20) {
  return { x1: pt.x - w / 2, y1: pt.y - h / 2, x2: pt.x + w / 2, y2: pt.y + h / 2 };
}

const overlapArea = (c, w, h, rects) => rects.reduce((sum, r) => {
  const ox = Math.min(c.x + w / 2, r.x2) - Math.max(c.x - w / 2, r.x1);
  const oy = Math.min(c.y + h / 2, r.y2) - Math.max(c.y - h / 2, r.y1);
  return ox > 0 && oy > 0 ? sum + ox * oy : sum;
}, 0);

// Centre for a w x h label tied to a pill at pt. Candidates in order: 18 px below
// and above centred on the pill, then the same two shifted left, right by the
// full label width, then left, right by half of it. A candidate that leaves the
// viewBox (8 px margin) is rejected; the first one touching none of rects wins;
// when none is clear the in-bounds one with the least overlap area wins.
export function placeLabel(pt, w, h, rects, bounds = {}) {
  const W = bounds.width ?? MAP_W;
  const H = bounds.height ?? Infinity;
  const dy = 18 + h / 2;
  const cands = [];
  [0, -w, w, -w / 2, w / 2].forEach((dx) => { cands.push({ x: pt.x + dx, y: pt.y + dy }); cands.push({ x: pt.x + dx, y: pt.y - dy }); });
  const inside = cands.filter((c) => c.x - w / 2 >= 8 && c.x + w / 2 <= W - 8 && c.y - h / 2 >= 8 && c.y + h / 2 <= H - 8);
  if (inside.length === 0) return cands[0];
  const clear = inside.find((c) => !rectsHit(c, w, h, rects));
  if (clear) return clear;
  return inside.reduce((best, c) => (overlapArea(c, w, h, rects) < overlapArea(best, w, h, rects) ? c : best));
}
