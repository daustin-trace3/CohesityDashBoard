import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SystemHealthPage, { fmtBytes, fmtDuration } from '../pages/admin/SystemHealthPage';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import client from '../api/client';

const mem = (rssMb) => ({ rssMb, heapUsedMb: 100, heapTotalMb: 150, externalMb: 10 });

const PAYLOAD = {
  generatedAt: '2026-11-09T12:00:00.000Z',
  app: { version: '1.0.0', nodeVersion: 'v24.22.1', sqliteVersion: '3.50.0', betterSqlite3Version: '12.0.0', platform: 'win32', arch: 'x64', hostname: 'icc-box', demo: false, tenantId: 'default', pm2: { web: 4 } },
  processes: {
    web: { pid: 100, startedAt: '2026-11-09T08:00:00.000Z', uptimeSeconds: 14400, mem: mem(300), loopLagP99Ms: 12, log: { error: 1, warn: 2, recent: [{ at: '2026-11-09T11:59:00.000Z', level: 'error', msg: 'web exploded' }] }, db: { slowTransactions: 0, busyRetries: 0 } },
    poller: { alive: true, ageSeconds: 5, uptimeSeconds: 7200, pid: 200, role: 'poller', mem: mem(700), loopLagP99Ms: 20, polling: { active: 1, queued: 0 }, log: { error: 0, warn: 0, recent: [] }, db: { slowTransactions: 0, busyRetries: 0 } },
  },
  database: { path: '/data/cohesity.db', fileBytes: 5 * 1024 * 1024, walBytes: 1024, lastCheckpoint: null, snapshot: null, snapshotAgeSeconds: null, refreshPending: false },
  polling: {
    summary: { runs24h: 40, failures24h: 2, sources: 1, stale: 0, longest: { platform: 'vcenter', sourceName: 'vc-prod-01', durationMs: 65000, startedAt: '2026-11-09T11:00:00.000Z' } },
    sources: [{ platform: 'vcenter', sourceId: 1, sourceName: 'vc-prod-01', kind: 'poll', lastStatus: 'error', lastError: 'login refused', lastStartedAt: '2026-11-09T11:00:00.000Z', lastDurationMs: 65000, avgDurationMs: 30000, maxDurationMs: 65000, runs24h: 40, failures24h: 2, series: [1000, 2000, 65000], intervalMinutes: 15, isStale: false, staleAfterMinutes: 35 }],
  },
  requests: { since: '2026-11-09T08:00:00.000Z', total: 10, routes: [{ route: 'GET /api/ops/summary', count: 10, errors4xx: 0, errors5xx: 0, totalMs: 500, maxMs: 90, lastAt: '2026-11-09T11:59:00.000Z', p50: 40, p95: 80 }] },
  migrations: [{ scope: 'core', version: 37, appliedAt: '2026-11-01T00:00:00.000Z' }],
  platforms: { enabled: ['cohesity'], plugins: [{ id: 'aws', version: '1.2.3', status: 'active', enabled: true }] },
  users: { count: 3, activeSessions: 1 },
  license: { state: 'active', expiresAt: null, customer: 'Acme' },
  findings: [{ id: 'poller-memory', severity: 'crit', text: 'Poller memory is far too high', tab: 'polling' }],
};

function renderPage(path = '/admin/health') {
  return render(<MemoryRouter initialEntries={[path]}><SystemHealthPage /></MemoryRouter>);
}

describe('SystemHealthPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the overview, a finding, and the polling tab', async () => {
    client.get.mockResolvedValue({ data: PAYLOAD });
    renderPage();
    expect(screen.getByText(/Loading system health/)).toBeInTheDocument();
    expect(await screen.findByText('Poller memory is far too high')).toBeInTheDocument();
    expect(screen.getByText('Web memory')).toBeInTheDocument();
    expect(screen.getByText('web exploded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Polling/ }));
    expect(await screen.findByText('Sources, worst first')).toBeInTheDocument();
    expect(screen.getAllByText('vc-prod-01').length).toBeGreaterThan(0);
  });

  it('shows the waiting state when the database snapshot is null', async () => {
    client.get.mockResolvedValue({ data: PAYLOAD });
    renderPage('/admin/health?tab=database');
    expect(await screen.findByText(/Waiting for the first sweep/)).toBeInTheDocument();
  });

  it('shows HTTP status and server text on error', async () => {
    client.get.mockRejectedValue({ response: { status: 403, data: { error: 'Forbidden thing' } } });
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('HTTP 403: Forbidden thing'));
  });

  it('formats sizes and durations', () => {
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(fmtDuration(250)).toBe('250 ms');
    expect(fmtDuration(2500)).toBe('2.5 s');
    expect(fmtDuration(65000)).toBe('1m 5s');
    expect(fmtDuration(120000)).toBe('2m');
    expect(fmtDuration(3 * 3600000 + 7 * 60000)).toBe('3h 7m');
    expect(fmtDuration(7200000)).toBe('2h');
  });
});
