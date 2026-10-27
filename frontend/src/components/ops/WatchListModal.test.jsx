import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({ default: { get: vi.fn() } }));
import client from '../../api/client';
import WatchListModal from './WatchListModal';
import { obsDetailLine } from './ObservationModal';

const Shell = ({ title, children }) => <div><h1>{title}</h1>{children}</div>;
const row = (over = {}) => ({
  id: 7, subject: 'batch-01', label: 'VM CPU', unit: '%', value: 95, peak: 97, elevatedSamples: 2, samples: 4,
  openedAt: new Date(Date.now() - 600000).toISOString(),
  series: [{ t: 'a', v: 40 }, { t: 'b', v: 55 }, { t: 'c', v: 93 }, { t: 'd', v: 95 }], ...over,
});

beforeEach(() => { client.get.mockReset(); });

describe('WatchListModal', () => {
  it('asks for the watching scope, lists each episode and opens one on click', async () => {
    client.get.mockResolvedValue({ data: [row(), row({ id: 8, subject: 'file-01', value: 91 })] });
    const onOpen = vi.fn();
    render(<WatchListModal Shell={Shell} onClose={() => {}} onOpenObservation={onOpen} />);
    await waitFor(() => expect(screen.getAllByTestId('watch-row')).toHaveLength(2));
    expect(client.get).toHaveBeenCalledWith('/ops-agent/observations', { params: { scope: 'watching' } });
    expect(screen.getByText('batch-01')).toBeTruthy();
    expect(screen.getAllByText('2/4')).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId('watch-row')[0]);
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it('says nothing is watched when the list is empty', async () => {
    client.get.mockResolvedValue({ data: [] });
    render(<WatchListModal Shell={Shell} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Nothing is being watched/)).toBeTruthy());
  });

  it('shows the server error when the load fails', async () => {
    client.get.mockRejectedValue({ response: { data: { error: 'boom' } } });
    render(<WatchListModal Shell={Shell} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});

describe('obsDetailLine', () => {
  it('prints the value, the peak and when, the first crossing and the sample counts', () => {
    const line = obsDetailLine({ value: 98, peak: 108, peakAt: '2026-10-22T12:15:00.000Z', openedValue: 95, openedAt: '2026-10-22T12:00:00.000Z', warn: 90, elevatedSamples: 4, samples: 4, unit: '%', promoteReason: 'elevated for 3 samples (30 min)' }, 'VM CPU');
    expect(line).toContain('VM CPU 98%, peak 108% at ');
    expect(line).toContain('first over 90% at 95% on ');
    expect(line).toContain('4 of 4 samples, promoted: elevated for 3 samples (30 min)');
  });
  it('is empty without a detail', () => { expect(obsDetailLine(null)).toBe(''); });
});
