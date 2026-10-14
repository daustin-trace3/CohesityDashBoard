import { describe, it, expect } from 'vitest';
import { layoutNodes, clipToBorder, arcGeometry, groupEdges, edgeRank, edgeGeometry, nodeRects, pushClear, pillRect, placeLabel, MAP_W, MIN_H, MAX_PER_ROW, ROW_GAP } from './layout';

const mk = (key, tier = 'site') => ({ siteKey: key, siteName: key.toUpperCase(), tier });

describe('layoutNodes', () => {
  it('returns an empty layout for no nodes', () => {
    const l = layoutNodes(null);
    expect(l.rowCount).toBe(0);
    expect(l.positions).toEqual({});
    expect(l.height).toBe(MIN_H);
  });

  it('puts dc nodes on the centre row and deals the rest above and below', () => {
    const nodes = [mk('dc1', 'dc'), mk('dc2', 'dc'), mk('a'), mk('b'), mk('c'), mk('d')];
    const l = layoutNodes(nodes);
    expect(l.rowCount).toBe(3);
    expect(l.positions.dc1.y).toBe(l.positions.dc2.y);
    expect(l.positions.A === undefined).toBe(true);
    expect(l.positions.a.y).toBeLessThan(l.positions.dc1.y);
    expect(l.positions.b.y).toBeGreaterThan(l.positions.dc1.y);
    expect(l.positions.c.y).toBe(l.positions.a.y);
    expect(l.positions.d.y).toBe(l.positions.b.y);
  });

  it('is deterministic regardless of input order', () => {
    const nodes = [mk('dc1', 'dc'), mk('a'), mk('b'), mk('c'), mk('d'), mk('e')];
    const one = layoutNodes(nodes);
    const two = layoutNodes([...nodes].reverse());
    expect(two.positions).toEqual(one.positions);
  });

  it('caps a row at MAX_PER_ROW and adds rows past 12 non-dc sites', () => {
    const nodes = [mk('dc1', 'dc'), ...Array.from({ length: 14 }, (_, i) => mk(`s${String(i).padStart(2, '0')}`))];
    const l = layoutNodes(nodes);
    expect(l.rowCount).toBe(5);
    const perRow = {};
    Object.values(l.positions).forEach((p) => { perRow[p.row] = (perRow[p.row] || 0) + 1; });
    Object.values(perRow).forEach((n) => expect(n).toBeLessThanOrEqual(MAX_PER_ROW));
    Object.values(l.positions).forEach((p) => { expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(MAP_W); });
  });

  it('keeps every node inside the canvas height', () => {
    const nodes = [mk('dc1', 'dc'), ...Array.from({ length: 24 }, (_, i) => mk(`s${i}`))];
    const l = layoutNodes(nodes);
    Object.values(l.positions).forEach((p) => { expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(l.height); });
  });
});

describe('geometry', () => {
  it('clips to the node border', () => {
    const p = clipToBorder({ x: 0, y: 0 }, { x: 400, y: 0 });
    expect(p).toEqual({ x: 75, y: 0 });
    const q = clipToBorder({ x: 0, y: 0 }, { x: 0, y: 300 });
    expect(q).toEqual({ x: 0, y: 24 });
  });

  it('bows an arc to the upper side', () => {
    const g = arcGeometry({ x: 100, y: 200 }, { x: 500, y: 200 }, 80);
    expect(g.mid.y).toBeLessThan(200);
    expect(g.d.startsWith('M')).toBe(true);
  });

  it('groups both directions of a pair and drops self pairs and unknown sites', () => {
    const positions = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } };
    const edges = [
      { from: 'a', to: 'b', state: 'ok', rttAvgMs: 10 },
      { from: 'b', to: 'a', state: 'down', rttAvgMs: null },
      { from: 'a', to: 'a', state: 'ok' },
      { from: 'a', to: 'zz', state: 'ok' },
    ];
    const g = groupEdges(edges, positions);
    expect(g).toHaveLength(1);
    expect(g[0].edges).toHaveLength(2);
    expect(g[0].worst.state).toBe('down');
  });

  it('ranks edge state', () => {
    expect(edgeRank({ state: 'down' })).toBe(3);
    expect(edgeRank({ state: 'degraded' })).toBe(2);
    expect(edgeRank({ state: 'ok' })).toBe(1);
    expect(edgeRank({})).toBe(0);
  });

  it('spaces rows 150 apart with 75 px above the first and below the last (min height 360)', () => {
    const l = layoutNodes([mk('dc1', 'dc'), mk('a'), mk('b')]);
    expect(ROW_GAP).toBe(150);
    expect(l.height).toBe(450);
    expect([l.positions.a.y, l.positions.dc1.y, l.positions.b.y]).toEqual([75, 225, 375]);
    expect(l.height - l.positions.b.y).toBe(75);
    const one = layoutNodes([mk('x', 'dc')]);
    expect(one.height).toBe(360);
    expect(one.positions.x.y).toBe(180);
  });

  it('keeps neighbours straight and bows a centre-row skip edge below by 70 per skipped node', () => {
    const l = layoutNodes([mk('d1', 'dc'), mk('d2', 'dc'), mk('d3', 'dc'), mk('d4', 'dc')]);
    const p = l.positions;
    expect(edgeGeometry(p.d1, p.d2).curved).toBe(false);
    const skip1 = edgeGeometry(p.d1, p.d3);
    expect(skip1.curved).toBe(true);
    expect(skip1.ctrl.y - p.d1.y).toBe(70);
    const skip2 = edgeGeometry(p.d1, p.d4);
    expect(skip2.ctrl.y - p.d1.y).toBe(140);
    expect(skip2.at(0.5).y).toBeGreaterThan(p.d1.y);
  });

  it('caps the bow at 160', () => {
    const l = layoutNodes(Array.from({ length: 6 }, (_, i) => mk(`d${i}`, 'dc')));
    const g = edgeGeometry(l.positions.d0, l.positions.d5);
    expect(g.ctrl.y - l.positions.d0.y).toBe(160);
  });

  it('bows upper-row skips up and flips to down when a circuit arc owns the pair', () => {
    const l = layoutNodes([mk('dc', 'dc'), ...'abcdefghijkl'.split('').map((k) => mk(k))]);
    const upper = Object.entries(l.positions).filter(([, v]) => v.dir === -1 && v.row === 0).map(([k, v]) => [k, v]);
    const [, first] = upper[0];
    const [, third] = upper[2];
    expect(edgeGeometry(first, third).ctrl.y).toBeLessThan(first.y);
    expect(edgeGeometry(first, third, { arcUp: true }).ctrl.y).toBeGreaterThan(first.y);
  });

  it('pushes a pill off a node rect it intersects, and leaves a clear one alone', () => {
    const l = layoutNodes([mk('d1', 'dc'), mk('d2', 'dc')]);
    const rects = nodeRects(l.positions);
    const n = l.positions.d1;
    const clear = { x: (l.positions.d1.x + l.positions.d2.x) / 2, y: n.y };
    expect(pushClear(clear, { x: 1, y: 0 }, 50, 20, rects)).toEqual(clear);
    const inside = { x: n.x + 70, y: n.y };
    const moved = pushClear(inside, { x: 1, y: 0 }, 50, 20, rects);
    expect(moved).not.toEqual(inside);
    expect(Math.abs(moved.x - inside.x) % 30).toBe(0);
    expect(Math.abs(moved.x - inside.x)).toBeLessThanOrEqual(90);
    expect(pushClear(inside, { x: 1, y: 0 }, 50, 20, rects).x).toBe(inside.x + 60);
  });

  it('places a blame label below, then above, then shifted, and moves on when a pill is in the way', () => {
    const pt = { x: 700, y: 300 };
    const w = 200;
    const bounds = { width: 1400, height: 450 };
    expect(placeLabel(pt, w, 18, [], bounds)).toEqual({ x: 700, y: 327 });
    const blocker = pillRect({ x: 720, y: 327 }, 60);
    expect(placeLabel(pt, w, 18, [blocker], bounds)).toEqual({ x: 700, y: 273 });
    const two = placeLabel(pt, w, 18, [blocker, pillRect({ x: 700, y: 273 }, 60)], bounds);
    expect(two).toEqual({ x: 500, y: 327 });
  });

  it('rejects candidates outside the viewBox', () => {
    const pt = { x: 120, y: 300 };
    const w = 200;
    const bounds = { width: 1400, height: 450 };
    // both centred spots blocked, both left shifts leave the viewBox, so the least-overlap in-bounds spot (shifted right) is taken
    const blockCentre = [{ x1: 0, y1: 310, x2: 400, y2: 345 }, { x1: 0, y1: 255, x2: 400, y2: 290 }];
    const got = placeLabel(pt, w, 18, blockCentre, bounds);
    expect(got.x - w / 2).toBeGreaterThanOrEqual(8);
    expect(got).toEqual({ x: 320, y: 327 });
    // top and bottom margins
    const low = placeLabel({ x: 700, y: 430 }, w, 18, [], bounds);
    expect(low.y + 9).toBeLessThanOrEqual(442);
    expect(low.y).toBe(430 - 27);
  });

  it('picks the in-bounds candidate with the least overlap when every one collides', () => {
    const pt = { x: 700, y: 300 };
    const w = 200;
    const bounds = { width: 1400, height: 450 };
    const wall = { x1: 0, y1: 0, x2: 1400, y2: 450 };
    const got = placeLabel(pt, w, 18, [wall], bounds);
    expect(got.x - w / 2).toBeGreaterThanOrEqual(8);
    expect(got.y - 9).toBeGreaterThanOrEqual(8);
    // a big block over the first candidate only: any other has less overlap
    const heavy = [{ x1: 600, y1: 310, x2: 800, y2: 345 }, { x1: 590, y1: 255, x2: 810, y2: 290 }, { x1: 400, y1: 0, x2: 1000, y2: 450 }];
    const least = placeLabel(pt, w, 18, heavy, bounds);
    const area = (c) => heavy.reduce((s, r) => {
      const ox = Math.min(c.x + w / 2, r.x2) - Math.max(c.x - w / 2, r.x1);
      const oy = Math.min(c.y + 9, r.y2) - Math.max(c.y - 9, r.y1);
      return ox > 0 && oy > 0 ? s + ox * oy : s;
    }, 0);
    expect(area(least)).toBeLessThanOrEqual(area({ x: 700, y: 327 }));
  });
});
