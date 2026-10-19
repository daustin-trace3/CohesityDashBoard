import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CircuitMap from './CircuitMap';

vi.mock('../../../api/client', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: { wan: { state: 'ok', total: 2, down: 0, flapping: 0 }, circuits: [], siteLinks: [], events: [] } })) },
}));
import { SiteHoverBody } from './SitesBand';

const node = (i, extra = {}) => ({ siteKey: `s${i}`, siteName: `Site ${i}`, tier: i === 0 ? 'dc' : 'site', wanState: 'ok', wanTotal: 2, wanDown: 0, devicesDead: 0, openIssues: 0, ...extra });

describe('CircuitMap', () => {
  it('draws 24 sites with colour coded links and opens an edge', () => {
    const nodes = Array.from({ length: 24 }, (_, i) => node(i, i === 3 ? { wanState: 'degraded', wanDown: 1 } : i === 4 ? { wanState: 'down', wanDown: 2, devicesDead: 3 } : {}));
    const edges = [
      { key: 's0|s1', a: 's0', b: 's1', state: 'ok', circuits: [{ port: 'Gi0/1', state: 'ok' }], issueKey: null },
      { key: 's0|s2', a: 's0', b: 's2', state: 'down', circuits: [{ port: 'Gi0/2', state: 'down' }], issueKey: 'site-link-down|LM|Site 0 <-> Site 2' },
      { key: 's0|s5', a: 's0', b: 's5', state: 'flapping', circuits: [{ port: 'Gi0/3', state: 'ok', flaps24h: 5 }] },
    ];
    let opened = null;
    const { container, getByText } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => {}} onOpenEdge={(e) => { opened = e.key; }} />);
    const svg = container.querySelector('svg[viewBox]');
    expect(svg).toBeTruthy();
    expect(container.querySelectorAll('g[role="button"]')).toHaveLength(24);
    expect(container.querySelector('g[data-edge="s0|s2"]').getAttribute('data-state')).toBe('down');
    const flap = container.querySelector('g[data-edge="s0|s5"] path[stroke-dasharray="7 4"]');
    expect(flap).toBeTruthy();
    fireEvent.click(container.querySelector('g[data-edge="s0|s2"] path[role="link"]'));
    // An edge click pins a card; its button then opens the issue.
    expect(opened).toBe(null);
    fireEvent.click(getByText('Open issue'));
    expect(opened).toBe('s0|s2');
  });

  it('renders with no edges and tolerates missing fields', () => {
    const { container } = render(<CircuitMap nodes={[{ siteKey: 'a' }]} edges={undefined} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    expect(container.querySelectorAll('g[role="button"]')).toHaveLength(1);
  });
});

describe('CircuitMap linked and unlinked sites', () => {
  it('draws linked sites in the graph and unlinked sites as chips in the side column', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(i));
    const edges = [
      { key: 's0|s1', a: 's0', b: 's1', state: 'ok', circuits: [{ port: 'Gi0/1', state: 'ok' }] },
      { key: 's2|s3', a: 's2', b: 's3', state: 'degraded', circuits: [{ port: 'Gi0/2', state: 'down' }, { port: 'Gi0/3', state: 'ok' }] },
    ];
    const { container, getAllByTestId } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    expect(getAllByTestId('graph-node')).toHaveLength(4);
    expect(getAllByTestId('unlinked-chip')).toHaveLength(2);
    expect(container.querySelector('svg[viewBox]').getAttribute('viewBox').startsWith('0 0 1400 ')).toBe(true);
  });

  it('a node with open issues and no degraded device names still lists Open issues (3) in its hover body', () => {
    const nodes = [node(0, { openIssues: 3, degradedDevices: [], reasons: ['3 open issue(s)'], issuesTop: [{ type: 'hardware-fault', severity: 'warning', target: 'sjcx-core-1 Slot 25' }] }), node(1)];
    const edges = [{ key: 's0|s1', a: 's0', b: 's1', state: 'ok', circuits: [] }];
    const { getAllByTestId, getByRole, getByText } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    fireEvent.mouseEnter(getAllByTestId('graph-node')[0], { clientX: 10, clientY: 10 });
    expect(getByRole('tooltip')).toBeTruthy();
    expect(getByText('Open issues (3)')).toBeTruthy();
    expect(getByText('warning hardware-fault: sjcx-core-1 Slot 25')).toBeTruthy();
  });
});

beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });

describe('CircuitMap zoom', () => {
  const pair = () => ({
    nodes: [node(0), node(1)],
    edges: [{ key: 's0|s1', a: 's0', b: 's1', state: 'ok', circuits: [] }],
  });
  const vbOf = (c) => c.querySelector('svg[viewBox]').getAttribute('viewBox').split(' ').map(Number);

  it('wheel up zooms in (the viewBox shrinks) and Fit restores the default viewBox', () => {
    const { nodes, edges } = pair();
    const { container, getByTestId } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    const before = container.querySelector('svg[viewBox]').getAttribute('viewBox');
    fireEvent.wheel(container.querySelector('svg[viewBox]'), { deltaY: -100, clientX: 300, clientY: 100 });
    const zoomed = vbOf(container);
    expect(zoomed[2]).toBeLessThan(1400);
    fireEvent.click(getByTestId('zoom-fit'));
    expect(container.querySelector('svg[viewBox]').getAttribute('viewBox')).toBe(before);
  });

  it('zoom stays between 0.5x and 3x', () => {
    const { nodes, edges } = pair();
    const { container } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    for (let i = 0; i < 40; i += 1) fireEvent.wheel(container.querySelector('svg[viewBox]'), { deltaY: -100 });
    expect(vbOf(container)[2]).toBeCloseTo(1400 / 3, 0);
    for (let i = 0; i < 80; i += 1) fireEvent.wheel(container.querySelector('svg[viewBox]'), { deltaY: 100 });
    expect(vbOf(container)[2]).toBeCloseTo(2800, 0);
  });
});

describe('CircuitMap drag beyond the base area', () => {
  const pair = () => ({
    nodes: [node(0), node(1)],
    edges: [{ key: 's0|s1', a: 's0', b: 's1', state: 'ok', circuits: [] }],
  });
  const nodeG = (getAllByTestId) => getAllByTestId('graph-node').find((x) => x.getAttribute('aria-label').startsWith('Site 0'));

  it('a node dragged to x = 1700 keeps that position', () => {
    const { nodes, edges } = pair();
    const moves = [];
    const { getAllByTestId } = render(<CircuitMap nodes={nodes} edges={edges} onMove={(k, p) => moves.push([k, p])} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    const g = nodeG(getAllByTestId);
    const x0 = Number(g.getAttribute('data-x'));
    fireEvent.pointerDown(g, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(g, { clientX: 1700 - x0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(g, { clientX: 1700 - x0, clientY: 0, pointerId: 1 });
    expect(moves).toHaveLength(1);
    expect(moves[0][1].x).toBe(1700);
  });

  it('Fit after a node sits outside the base area yields a viewBox containing it', () => {
    const { nodes, edges } = pair();
    const { container, getByTestId } = render(<CircuitMap nodes={nodes} edges={edges} overrides={{ s0: { x: 1700, y: 120 } }} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    fireEvent.click(getByTestId('zoom-fit'));
    const [x, , w] = container.querySelector('svg[viewBox]').getAttribute('viewBox').split(' ').map(Number);
    expect(x).toBeLessThanOrEqual(1700 - 60);
    expect(x + w).toBeGreaterThanOrEqual(1700 + 60);
    expect(w).toBeGreaterThan(1400);
  });
});

describe('CircuitMap pinned card and dragging', () => {
  const two = () => ({
    nodes: [node(0, { worstState: 'degraded', reasons: ['1 open issue(s)'] }), node(1)],
    edges: [{ key: 's0|s1', a: 's0', b: 's1', state: 'ok', circuits: [] }],
  });

  it('clicking a node pins a card with the site name and does not navigate', () => {
    const { nodes, edges } = two();
    let opened = 0;
    const { getAllByTestId, getByTestId, queryByTestId } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => { opened += 1; }} onOpenEdge={() => { opened += 1; }} />);
    fireEvent.click(getAllByTestId('graph-node')[0]);
    expect(getByTestId('site-card').textContent).toContain('Site 0');
    expect(opened).toBe(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByTestId('site-card')).toBeNull();
  });

  it('a card opened from a node near the bottom is a fixed portal clamped into the viewport', () => {
    const { nodes, edges } = two();
    window.innerHeight = 600;
    window.innerWidth = 1200;
    const { getAllByTestId, getByTestId } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    const g = getAllByTestId('graph-node')[0];
    g.getBoundingClientRect = () => ({ left: 1000, right: 1100, top: 590, bottom: 620, width: 100, height: 30 });
    fireEvent.click(g);
    const box = getByTestId('pinned-float');
    expect(box.parentElement).toBe(document.body);
    expect(box.style.position).toBe('fixed');
    const top = parseInt(box.style.top, 10);
    const left = parseInt(box.style.left, 10);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(592);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThanOrEqual(1200 - 420 - 8);
  });

  it('an override position places the node, and the node colour follows worstState', () => {
    const { nodes, edges } = two();
    const { getAllByTestId } = render(<CircuitMap nodes={nodes} edges={edges} overrides={{ s0: { x: 400, y: 200 } }} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    const g = getAllByTestId('graph-node').find((x) => x.getAttribute('aria-label').startsWith('Site 0'));
    expect(g.getAttribute('transform')).toBe('translate(400 200)');
    expect(g.querySelector('rect').getAttribute('stroke')).toBe('#FBBF24');
  });

  it('a drag under 4 px still clicks, a longer drag moves the node and swallows the click', () => {
    const { nodes, edges } = two();
    const moves = [];
    const { getAllByTestId, queryByTestId } = render(<CircuitMap nodes={nodes} edges={edges} onMove={(k, p) => moves.push([k, p])} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    const g = () => getAllByTestId('graph-node').find((x) => x.getAttribute('aria-label').startsWith('Site 0'));
    fireEvent.pointerDown(g(), { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(g(), { clientX: 102, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(g(), { clientX: 102, clientY: 101, pointerId: 1 });
    fireEvent.click(g());
    expect(moves).toHaveLength(0);
    expect(queryByTestId('site-card')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(g(), { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(g(), { clientX: 160, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(g(), { clientX: 160, clientY: 130, pointerId: 1 });
    fireEvent.click(g());
    expect(moves).toHaveLength(1);
    expect(moves[0][0]).toBe('s0');
    expect(queryByTestId('site-card')).toBeNull();
  });

  it('arrow keys move a focused node by 10 units', () => {
    const { nodes, edges } = two();
    const moves = [];
    const { getAllByTestId } = render(<CircuitMap nodes={nodes} edges={edges} onMove={(k, p) => moves.push([k, p])} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    const g = getAllByTestId('graph-node').find((x) => x.getAttribute('aria-label').startsWith('Site 0'));
    const x0 = Number(g.getAttribute('data-x'));
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    expect(moves[0][1].x).toBe(x0 + 10);
  });
});

describe('SiteHoverBody', () => {
  it('names the dead devices and the WAN sentence', () => {
    const { getByText, getByTestId } = render(<SiteHoverBody n={{ siteKey: 'sjcx', siteName: 'SJCX', wanState: 'degraded', wanTotal: 2, wanDown: 1, devicesDead: 3, deadDevices: ['sw-1', 'sw-2', 'sw-3'], degradedDevices: ['fw-1'], portsDownNames: ['sw-9 Gi1/0/1'], interfacesDown: 1 }} />);
    expect(getByTestId('site-hover')).toBeTruthy();
    expect(getByText('sw-2')).toBeTruthy();
    expect(getByText(/WAN degraded: running on 1 of 2/)).toBeTruthy();
    expect(getByText('sw-9 Gi1/0/1')).toBeTruthy();
  });

  it('shows reasons first and the open issues list', () => {
    const { getAllByTestId, getByText } = render(<SiteHoverBody n={{ siteKey: 'a', siteName: 'A', wanState: 'degraded', wanTotal: 2, wanDown: 1, openIssues: 3, reasons: ['WAN degraded: 1 of 2 circuits up', '3 open issue(s)'], issuesTop: [{ type: 'fw-tunnel-down', severity: 'warning', target: 'sjcx-fwp-01-1 IPSec tunnels' }] }} />);
    expect(getAllByTestId('site-reason')).toHaveLength(2);
    expect(getByText('Open issues (3)')).toBeTruthy();
    expect(getByText('warning fw-tunnel-down: sjcx-fwp-01-1 IPSec tunnels')).toBeTruthy();
  });
});
