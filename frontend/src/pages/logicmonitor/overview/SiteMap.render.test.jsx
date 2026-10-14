import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import SiteMap from './SiteMap';

describe('SiteMap (unmounted from the Overview, kept for the Sites page)', () => {
  it('pushes an RTT pill off a node it would sit on', () => {
    const n3 = [
      { siteKey: 'a', siteName: 'A', tier: 'site', state: 'ok', collectors: [] },
      { siteKey: 'dc', siteName: 'DC', tier: 'dc', state: 'ok', collectors: [] },
      { siteKey: 'b', siteName: 'B', tier: 'site', state: 'ok', collectors: [] },
    ];
    // a sits above and b below the lone dc node, so the a>b midpoint is the dc node centre
    const e = { key: 'a>b', from: 'a', to: 'b', state: 'ok', severity: 'ok', rttAvgMs: 12, checks: [] };
    const { container } = render(<MemoryRouter><SiteMap map={{ nodes: n3, edges: [e], circuits: [] }} onOpenSite={() => {}} onOpenReachability={() => {}} /></MemoryRouter>);
    const svg = container.querySelector('svg[viewBox]');
    expect(svg.getAttribute('viewBox')).toBe('0 0 1400 450');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    const pill = [...container.querySelectorAll('rect')].find((r) => r.getAttribute('height') === '20' && r.getAttribute('rx') === '10');
    expect(pill).toBeTruthy();
    expect(Number(pill.getAttribute('y')) + 10).not.toBe(225);
  });

  it('draws the blame label last, after every pill', () => {
    const n2 = [
      { siteKey: 'a', siteName: 'A', tier: 'dc', state: 'ok', collectors: [] },
      { siteKey: 'b', siteName: 'B', tier: 'dc', state: 'ok', collectors: [] },
    ];
    const e = { key: 'a>b', from: 'a', to: 'b', state: 'down', severity: 'critical', rttAvgMs: null, checks: [], blame: { deviceName: 'abq-dist-01', port: 'Te1/0/48', state: 'down', reason: 'x' } };
    const { container } = render(<MemoryRouter><SiteMap map={{ nodes: n2, edges: [e], circuits: [] }} onOpenSite={() => {}} onOpenReachability={() => {}} /></MemoryRouter>);
    const pills = [...container.querySelectorAll('svg[viewBox] rect')].filter((r) => r.getAttribute('rx') === '10' || r.getAttribute('rx') === '6');
    expect(pills.length).toBeGreaterThan(1);
    const last = pills[pills.length - 1];
    expect(last.getAttribute('fill')).toBe('#2a1618');
    expect(last.parentElement.getAttribute('data-blame-label')).toBe('1');
    expect(last.parentElement.textContent).toMatch(/Likely hop: abq-dist-01 Te1\/0\/48/);
  });
});
