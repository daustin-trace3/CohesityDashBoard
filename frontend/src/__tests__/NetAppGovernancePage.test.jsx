import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NetAppGovernancePage from '../pages/netapp/NetAppGovernancePage';
import { ToastProvider } from '../components/ui/Toaster';

vi.mock('../api/client', () => ({
  default: { get: vi.fn() },
}));

import client from '../api/client';

const GOVERNANCE = {
  clusters: [
    {
      id: 1, name: 'cg-ontap-1', mgmt_host: 'cg-ontap-1.corp.local', source: 'direct',
      ontap_version: '9.13.1P8', ontap_release: '9.13.1P8', node_count: 2, models: ['FAS8300'], serials: ['SN-A1', 'SN-A2'],
      node_versions: ['9.13.1', '9.13.1P8'], mixed_versions: true, behind: true,
      capacity_total_bytes: 1000, capacity_used_bytes: 400, capacity_used_percent: 40,
      aggregate_count: 1, volume_count: 2, disk_count: 4, disk_failed_count: 0, svm_count: 1,
      open_alert_count: 0, open_alerts_by_severity: {}, snapmirror_count: 0,
      last_polled: '2026-09-21T10:00:00Z', poll_status: 'success', poll_error: false,
    },
    {
      // Array-level raw version is the direct-poller full "NetApp Release
      // ...: <date>" form; its node reports the short form of the SAME
      // release. ontap_release/release are what the backend normalizes both
      // to - the format mismatch that broke filtering before this fix.
      id: 2, name: 'cg-ontap-2', mgmt_host: 'cg-ontap-2.corp.local', source: 'AIQUM-1',
      ontap_version: 'NetApp Release 9.14.1: Thu Mar 14 12:00:00 UTC 2024', ontap_release: '9.14.1',
      node_count: 1, models: ['AFF-A400'], serials: ['SN-B1'],
      node_versions: ['9.14.1'], mixed_versions: false, behind: false,
      capacity_total_bytes: 2000, capacity_used_bytes: 1000, capacity_used_percent: 50,
      aggregate_count: 1, volume_count: 1, disk_count: 2, disk_failed_count: 0, svm_count: 1,
      open_alert_count: 1, open_alerts_by_severity: { critical: 1 }, snapmirror_count: 0,
      last_polled: '2026-09-21T10:05:00Z', poll_status: 'success', poll_error: false,
    },
  ],
  nodes: [
    { array_id: 1, array_name: 'cg-ontap-1', name: 'a-node-1', model: 'FAS8300', serial_number: 'SN-A1', state: 'up', version: '9.13.1', release: '9.13.1', behind: true },
    { array_id: 1, array_name: 'cg-ontap-1', name: 'a-node-2', model: 'FAS8300', serial_number: 'SN-A2', state: 'up', version: '9.13.1P8', release: '9.13.1P8', behind: true },
    { array_id: 2, array_name: 'cg-ontap-2', name: 'b-node-1', model: 'AFF-A400', serial_number: 'SN-B1', state: 'up', version: '9.14.1', release: '9.14.1', behind: false },
  ],
  versions: [
    { version: '9.14.1', cluster_count: 1, node_count: 1, clusters: ['cg-ontap-2'] },
    { version: '9.13.1P8', cluster_count: 1, node_count: 1, clusters: ['cg-ontap-1'] },
    { version: '9.13.1', cluster_count: 1, node_count: 1, clusters: ['cg-ontap-1'] },
  ],
  models: [
    { model: 'FAS8300', node_count: 2, cluster_count: 1, clusters: ['cg-ontap-1'] },
    { model: 'AFF-A400', node_count: 1, cluster_count: 1, clusters: ['cg-ontap-2'] },
  ],
  newest_version: '9.14.1',
  majority_version: '9.13.1',
  summary: {
    cluster_count: 2, node_count: 3, distinct_versions: 3, distinct_models: 2,
    clusters_with_mixed_versions: 1, clusters_behind_newest: 1, clusters_with_poll_issue: 0,
  },
};

function renderPage(initialPath = '/netapp/governance') {
  // ToastProvider matches production mounting (App.jsx wraps every route in
  // it). Without it useToast() has no context and returns a fresh { toast }
  // object on every render, which turns the standard useCallback([toast]) +
  // useEffect([load]) data-loading pattern used across every platform page
  // into an infinite re-fetch loop.
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <NetAppGovernancePage />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('NetAppGovernancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.get.mockImplementation((url) => {
      if (url === '/netapp/governance') return Promise.resolve({ data: GOVERNANCE });
      return Promise.resolve({ data: {} });
    });
  });

  it('renders the fetched clusters on the Filers table', async () => {
    renderPage();
    expect(await screen.findByText('cg-ontap-1')).toBeInTheDocument();
    expect(screen.getByText('cg-ontap-2')).toBeInTheDocument();
    expect(screen.getByText('2 rows')).toBeInTheDocument();
  });

  it('a version filter narrows the Filers table and shows an active chip', async () => {
    renderPage();
    await screen.findByText('cg-ontap-1');

    const versionSelect = screen.getByDisplayValue('All versions');
    fireEvent.change(versionSelect, { target: { value: '9.14.1' } });

    await waitFor(() => expect(screen.queryByText('cg-ontap-1')).not.toBeInTheDocument());
    expect(screen.getByText('cg-ontap-2')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 rows', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Version: 9.14.1/)).toBeInTheDocument();
  });

  it('clicking a version in Code levels applies it as a filter and jumps to Filers', async () => {
    renderPage();
    await screen.findByText('cg-ontap-1');

    // "Code levels" also appears as a StatCard label, so target the nav button.
    fireEvent.click(screen.getByRole('button', { name: /Code levels/ }));
    const row = screen.getByText('9.13.1P8').closest('tr');
    fireEvent.click(within(row).getByText('9.13.1P8'));

    // Jumped back to the Filers section, filtered to the clicked version.
    await waitFor(() => expect(screen.queryByText('cg-ontap-2')).not.toBeInTheDocument());
    expect(screen.getByText('cg-ontap-1')).toBeInTheDocument();
    expect(screen.getByText(/Version: 9.13.1P8/)).toBeInTheDocument();
  });

  it('clicking a version in Code levels leaves the matching filer visible when raw formats differ', async () => {
    // cg-ontap-2's raw ontap_version is "NetApp Release 9.14.1: ..." (the
    // direct/node full form), not the short "9.14.1" the Code levels row and
    // the version filter use. Before the fix the filter compared against the
    // raw string and matched zero filers.
    renderPage();
    await screen.findByText('cg-ontap-1');

    fireEvent.click(screen.getByRole('button', { name: /Code levels/ }));
    // The 9.14.1 row also renders a "newest" badge in the same cell, so its
    // text is split across elements - locate the row by content instead of
    // a single getByText match on the version string.
    const row = screen.getAllByRole('row').find((r) => r.textContent.includes('9.14.1'));
    fireEvent.click(row);

    await waitFor(() => expect(screen.queryByText('cg-ontap-1')).not.toBeInTheDocument());
    expect(screen.getByText('cg-ontap-2')).toBeInTheDocument();
    expect(screen.getByText(/Version: 9.14.1/)).toBeInTheDocument();
  });
});
