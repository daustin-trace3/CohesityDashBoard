import { describe, it, expect } from 'vitest';
import { buildSourceRows, rowState } from './pollerPanelRows';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const future = '2026-10-19T12:30:00Z';

const status = {
  netapp: {
    enabled: true,
    entities: [
      { id: 1, name: 'na-live', lastPollStatus: 'success', isStale: false, ageMinutes: 3 },
      { id: 2, name: 'na-stale', lastPollStatus: 'success', isStale: true, ageMinutes: 90 },
    ],
  },
  vcenter: {
    enabled: true,
    entities: [
      { id: 5, name: 'tor-vc-prd-01', lastPollStatus: 'error', lastPollError: 'login refused', isStale: false },
      { id: 6, name: 'vc-backoff', lastPollStatus: 'error', backoffUntil: future },
      { id: 7, name: 'vc-busy', isSyncing: true },
    ],
  },
  zerto: { enabled: true, isStale: false, ageMinutes: 4, lastDataCapture: '2026-10-19T11:56:00Z', failedSources: [] },
};

describe('poller panel rows', () => {
  it('classifies with the chip precedence', () => {
    expect(rowState({ isSyncing: true, lastPollStatus: 'error' }, NOW)).toBe('syncing');
    expect(rowState({ backoffUntil: future, lastPollStatus: 'error' }, NOW)).toBe('delayed');
    expect(rowState({ lastPollStatus: 'error', isStale: true }, NOW)).toBe('error');
    expect(rowState({ isStale: true }, NOW)).toBe('stale');
    expect(rowState({}, NOW)).toBe('live');
  });

  it('sorts worst first across all platforms', () => {
    const rows = buildSourceRows(status, 'all', NOW);
    expect(rows.map((r) => r.state)).toEqual(['error', 'delayed', 'stale', 'syncing', 'live', 'live']);
    expect(rows[0].error).toBe('login refused');
  });

  it('scopes to one platform so other platforms never appear', () => {
    const rows = buildSourceRows(status, 'netapp', NOW);
    expect(rows.map((r) => r.name)).toEqual(['na-stale', 'na-live']);
    expect(rows.every((r) => r.platform === 'netapp')).toBe(true);
  });

  it('gives account-global Zerto a pollable row with id 0', () => {
    const rows = buildSourceRows(status, 'zerto', NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 0, pollable: true, state: 'live' });
  });
});
