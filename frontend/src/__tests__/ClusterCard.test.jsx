import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ClusterCard from '../components/ClusterCard';

vi.mock('../api/client', () => ({
  default: { get: vi.fn() },
}));
vi.mock('../components/HardwareModal', () => ({ default: () => null }));

import client from '../api/client';

const cluster = { id: 1, name: 'Test Cluster', tags: '', connection_type: 'direct', vip: '10.0.0.1' };

const metricsRow = {
  used_bytes: 500e12,
  total_capacity_bytes: 1000e12,
  logical_bytes: 1000e12,
  data_reduction_ratio: 2.0,
  software_version: '7.1',
};

describe('ClusterCard with historyRows prop', () => {
  beforeEach(() => {
    client.get.mockResolvedValue({ data: [] });
  });

  it('renders cluster name', () => {
    render(<ClusterCard cluster={cluster} historyRows={[metricsRow]} />);
    expect(screen.getByText('Test Cluster')).toBeInTheDocument();
  });

  it('shows storage percentage', () => {
    render(<ClusterCard cluster={cluster} historyRows={[metricsRow]} />);
    expect(screen.getByText('50.00%')).toBeInTheDocument();
  });

  it('shows savings ratio', async () => {
    render(<ClusterCard cluster={cluster} historyRows={[metricsRow]} />);
    expect(await screen.findByText('2.00x')).toBeInTheDocument();
  });

  it('shows software version', () => {
    render(<ClusterCard cluster={cluster} historyRows={[metricsRow]} />);
    expect(screen.getByText('v7.1')).toBeInTheDocument();
  });

  it('skips metrics fetch when historyRows provided', () => {
    render(<ClusterCard cluster={cluster} historyRows={[metricsRow]} />);
    expect(client.get).not.toHaveBeenCalledWith(expect.stringContaining('/metrics/'));
  });

  it('falls back to logical/used ratio when data_reduction_ratio is 0', () => {
    const zeroRatioMetrics = { used_bytes: 500e12, total_capacity_bytes: 1000e12, logical_bytes: 1000e12, data_reduction_ratio: 0 };
    render(<ClusterCard cluster={cluster} historyRows={[zeroRatioMetrics]} />);
    expect(screen.getByText('2.00x')).toBeInTheDocument();
  });

  it('falls back to logical/used ratio when data_reduction_ratio is null', () => {
    const noRatioMetrics = { used_bytes: 500e12, total_capacity_bytes: 1000e12, logical_bytes: 1000e12, data_reduction_ratio: null };
    render(<ClusterCard cluster={cluster} historyRows={[noRatioMetrics]} />);
    expect(screen.getByText('2.00x')).toBeInTheDocument();
  });

  it('shows em-dash pct display when total_capacity_bytes is 0', () => {
    const emptyMetrics = { used_bytes: 0, total_capacity_bytes: 0 };
    render(<ClusterCard cluster={cluster} historyRows={[emptyMetrics]} />);
    // Card root has role="button" with aria-label containing '—'
    expect(screen.getByRole('button', { name: /— used/ })).toBeInTheDocument();
  });
});

describe('ClusterCard self-fetch mode (no historyRows)', () => {
  it('shows "Data unavailable" when metrics fetch fails', async () => {
    client.get.mockImplementation(url => {
      if (url.includes('/metrics/')) return Promise.reject(new Error('network error'));
      return Promise.resolve({ data: [] });
    });
    render(<ClusterCard cluster={cluster} />);
    expect(await screen.findByText('Data unavailable')).toBeInTheDocument();
  });

  it('fetches metrics history from API', async () => {
    client.get.mockResolvedValue({ data: [metricsRow] });
    render(<ClusterCard cluster={cluster} />);
    await waitFor(() => expect(client.get).toHaveBeenCalledWith('/metrics/1/history?days=7'));
  });
});
