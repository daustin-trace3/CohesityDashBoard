import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-chartjs-2', () => ({ Line: () => <div data-testid="line" /> }));
vi.mock('../../../api/client', () => ({ default: { get: vi.fn() } }));
import client from '../../../api/client';
import LmOverviewPage from '../LmOverviewPage';
import SiteMap from './SiteMap';

const series = (f) => Array.from({ length: 24 }, (_, i) => f(i));
const names = ['Dallas DC', 'Phoenix DC', 'Denver', 'Tucson', 'Albuquerque', 'Salt Lake', 'New York DC', 'London', 'AWS'];
const nodes = names.map((n, i) => ({
  siteKey: n.toLowerCase().replace(/\s/g, '-'), siteName: n, sourceId: 1, state: i === 0 ? 'critical' : i === 3 ? 'warning' : 'ok',
  tier: /DC$/.test(n) ? 'dc' : 'site', deviceCount: 10, networkCount: 8, devicesDead: i === 0 ? 3 : 0, devicesDeadCollector: i === 3 ? 4 : 0,
  interfacesDown: 1, collectors: i % 2 ? [{ hostname: `c${i}`, isDown: i === 3 }] : [], viaCollector: i % 2 ? null : 'c1', circuitsSaturated: 0, openIssues: 1,
  ...(i === 0 ? { reachability: { label: 'RTT ms', direction: 'in', series: series((j) => (j > 15 ? null : 20 + j)), worst: { checkName: 'DAL file services', fromLabel: 'phx-col01', rttAvgMs: 52, lossPct: 100 } } } : {}),
  ...(i === 1 || i === 4 ? { reachability: { label: 'RTT ms', series: series((j) => 30 + (j % 4)), worst: null } } : {}),
}));
const k = (n) => nodes[n].siteKey;
const edge = (a, b, state, rtt, extra = {}) => ({
  key: `${k(a)}>${k(b)}`, from: k(a), to: k(b), state, severity: state === 'down' ? 'critical' : state === 'degraded' ? 'warning' : 'ok',
  rttAvgMs: rtt, lossPct: state === 'down' ? 100 : 0, anomaly: null, checks: [{ checkId: 1, checkName: 'chk', checkpointLabel: 'cp', state, rttAvgMs: rtt, lossPct: 0, anomaly: null, baselineRttMs: 20, lastGoodAt: null, since: '2026-10-14T10:00:00Z' }], blame: null, ...extra,
});
const fixture = {
  generatedAt: '2026-10-14T12:00:00Z',
  health: { score: 60, formula: '100 - (...)' },
  counters: { devicesDead: 8, devicesDeadCollector: 4, interfacesDown: 10, interfaces: 200, linksDegraded: 3, checksDown: 1, checksDegraded: 2, circuitsSaturated: 1, circuits: 5, collectors: 6, collectorsDown: 1, coverageScore: 86, shadowed: 23, alertsCritical: 5, alertsWarning: 3, alertsInfo: 1, openIssues: 38 },
  map: {
    nodes,
    edges: [
      edge(2, 0, 'degraded', 52), edge(3, 1, 'down', null), edge(1, 0, 'down', null, { blame: { deviceName: 'dal-wan-rtr-01', port: 'Gi0/0/0', state: 'down', reason: 'port down' } }),
      edge(0, 1, 'ok', 30), edge(0, 6, 'ok', 31), edge(6, 7, 'ok', 74), edge(0, 8, 'ok', 24), edge(4, 1, 'degraded', 41), edge(5, 2, 'ok', 19), edge(8, 6, 'ok', null),
    ],
    circuits: [{ siteKey: k(1), deviceName: 'phx-rtr', port: 'Gi0/0/0', label: 'to DAL', state: 'critical', p95InPct: 89, p95OutPct: 74, farSiteKey: k(0) }],
  },
  burning: Array.from({ length: 6 }, (_, i) => ({
    issueKey: `i${i}`, severity: 'critical', type: 'check-down', target: `t${i}`, message: 'm'.repeat(40), since: '2026-10-14T10:00:00Z', siteKey: k(0), siteName: 'Dallas DC',
    likelyHop: i % 2 ? { deviceName: 'd', port: 'p', text: 't' } : null, metric: i === 5 ? null : { label: 'RTT ms', series: series((j) => (j > 15 ? null : j)) },
  })),
  trends: { hours: series((i) => `2026-10-13T${String(i).padStart(2, '0')}:00:00Z`), alertsBySeverity: { critical: series((i) => i), warning: series(() => 2), info: series(() => 1) }, degradation: { linksDegraded: series((i) => i % 3), portsDown: series(() => null) } },
};

const Where = () => { const l = useLocation(); return <i data-testid="where">{l.pathname + l.search}</i>; };
const wrap = () => render(<MemoryRouter><LmOverviewPage /><Where /></MemoryRouter>);

describe('LmOverviewPage', () => {
  let realGet;
  beforeEach(() => { realGet = realGet || client.get; client.get = realGet; client.get.mockReset(); });

  it('renders the full fixture', async () => {
    client.get.mockResolvedValue({ data: fixture });
    wrap();
    await waitFor(() => expect(screen.getByText('Dead devices')).toBeInTheDocument());
    expect(screen.getByText('Derived, not a LogicMonitor score')).toBeInTheDocument();
    expect(screen.getByText('+4 behind a down collector')).toBeInTheDocument();
    expect(screen.getByText('of 200 interfaces')).toBeInTheDocument();
    expect(screen.getByText('1 check down, 2 slow or lossy')).toBeInTheDocument();
    expect(screen.getByText('of 5, phx-rtr Gi0/0/0 89%')).toBeInTheDocument();
    expect(screen.getByText('Collectors up')).toBeInTheDocument();
    expect(screen.getByText('5 / 6')).toBeInTheDocument();
    expect(screen.getByText('Coverage score')).toBeInTheDocument();
    expect(screen.getByText('Shadowed devices')).toBeInTheDocument();
    expect(screen.getByText("9 sites, worst first. Sparkline is 24 h RTT, inbound or from the site's collector. Click opens Site 360.")).toBeInTheDocument();
    expect(screen.getByText(/Burning, 6 of 38 open issues/)).toBeInTheDocument();
    expect(screen.getByText('View all 38 issues')).toBeInTheDocument();
    expect(screen.getAllByTestId('line')).toHaveLength(2);
    expect(client.get).toHaveBeenCalledWith('/logicmonitor/overview');
  });

  it('draws the ring with the score and the amber tone for 60', async () => {
    client.get.mockResolvedValue({ data: fixture });
    wrap();
    const score = await screen.findByTestId('health-score');
    expect(score.textContent).toBe('60');
    expect(score.style.color).toBe('rgb(251, 191, 36)');
    expect(screen.getByTestId('health-arc').getAttribute('stroke')).toBe('#FBBF24');
    expect(screen.getByTestId('health-score').closest('div[title]').getAttribute('title')).toBe('100 - (...)');
  });

  it('colours the ring green at 80 and red below 50', async () => {
    client.get.mockResolvedValue({ data: { ...fixture, health: { score: 92, formula: 'f' } } });
    const a = wrap();
    expect((await screen.findByTestId('health-score')).style.color).toBe('rgb(108, 179, 63)');
    a.unmount();
    client.get.mockResolvedValue({ data: { ...fixture, health: { score: 30, formula: 'f' } } });
    wrap();
    await waitFor(() => expect(screen.getByTestId('health-score').style.color).toBe('rgb(248, 113, 113)'));
  });

  it('renders one chip per node, worst first, with and without reachability', async () => {
    client.get.mockResolvedValue({ data: fixture });
    wrap();
    const chips = await screen.findAllByTestId('site-chip');
    expect(chips).toHaveLength(9);
    const names = chips.map((c) => c.querySelector('p:nth-of-type(2)').textContent);
    expect(names[0]).toBe('Dallas DC');
    expect(chips[0].textContent).toMatch(/CRITICAL/);
    expect(names[1]).toBe('Tucson');
    expect(chips[1].textContent).toMatch(/WARNING/);
    expect(names.slice(2)).toEqual([...names.slice(2)].sort((a, b) => a.localeCompare(b)));
    // Dallas has reachability with a worst check: tooltip and sparkline
    expect(chips[0].getAttribute('title')).toBe('Inbound: Worst check: DAL file services, from phx-col01, 52.0 ms, loss 100%');
    expect(chips[0].querySelector('svg')).toBeTruthy();
    // Tucson has none: no sparkline, no tooltip, no error
    expect(chips[1].querySelector('svg')).toBeNull();
    expect(chips[1].getAttribute('title')).toBeNull();
  });

  it('uses a fixed-width grid for chips, a circuit port abbreviation and a collector-origin tooltip', async () => {
    const fx = { ...fixture, map: { ...fixture.map, circuits: [{ ...fixture.map.circuits[0], port: 'TenGigabitEthernet1/0/48' }],
      nodes: fixture.map.nodes.map((n, i) => (i === 3 ? { ...n, reachability: { series: series(() => 5), direction: 'out', worst: { checkName: 'c', checkpointLabel: 'own', rttAvgMs: 4, lossPct: 0 } } } : n)) } };
    client.get.mockResolvedValue({ data: fx });
    wrap();
    const chips = await screen.findAllByTestId('site-chip');
    expect(chips[0].parentElement.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(150px, 1fr))');
    expect(screen.getByText('of 5, phx-rtr Te1/0/48 89%')).toBeInTheDocument();
    expect(chips[1].getAttribute('title')).toMatch(/^From this site: /);
    expect(screen.getByTestId('health-score').parentElement.textContent).toBe('60');
  });

  it('opens Site 360 from a chip', async () => {
    client.get.mockResolvedValue({ data: fixture });
    wrap();
    const chips = await screen.findAllByTestId('site-chip');
    fireEvent.click(chips[0]);
    expect(screen.getByTestId('where').textContent).toBe('/logicmonitor/sites?site=dallas-dc');
    fireEvent.keyDown(chips[1], { key: 'Enter' });
    expect(screen.getByTestId('where').textContent).toBe('/logicmonitor/sites?site=tucson');
  });

  it('renders with an empty object', async () => {
    client.get.mockResolvedValue({ data: {} });
    wrap();
    await waitFor(() => expect(screen.getByText(/No sites derived yet/)).toBeInTheDocument());
    expect(screen.getByText(/No LogicMonitor data yet/)).toBeInTheDocument();
  });

  it('shows an error panel on 404', async () => {
    const err = Object.assign(new Error('nf'), { response: { status: 404 } });
    // a plain function: vitest's call tracking reports its own copy of a mocked rejection as unhandled
    client.get = async () => { throw err; };
    wrap();
    await waitFor(() => expect(screen.getByText(/Overview needs the round 5 backend/)).toBeInTheDocument());
  });
});
