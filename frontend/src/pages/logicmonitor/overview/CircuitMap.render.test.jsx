import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CircuitMap from './CircuitMap';
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
    const { container } = render(<CircuitMap nodes={nodes} edges={edges} onOpenSite={() => {}} onOpenEdge={(e) => { opened = e.key; }} />);
    const svg = container.querySelector('svg[viewBox]');
    expect(svg).toBeTruthy();
    expect(container.querySelectorAll('g[role="button"]')).toHaveLength(24);
    expect(container.querySelector('g[data-edge="s0|s2"]').getAttribute('data-state')).toBe('down');
    const flap = container.querySelector('g[data-edge="s0|s5"] path[stroke-dasharray="7 4"]');
    expect(flap).toBeTruthy();
    fireEvent.click(container.querySelector('g[data-edge="s0|s2"] path[role="link"]'));
    expect(opened).toBe('s0|s2');
  });

  it('renders with no edges and tolerates missing fields', () => {
    const { container } = render(<CircuitMap nodes={[{ siteKey: 'a' }]} edges={undefined} onOpenSite={() => {}} onOpenEdge={() => {}} />);
    expect(container.querySelectorAll('g[role="button"]')).toHaveLength(1);
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
});
