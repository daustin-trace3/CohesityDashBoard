import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PlatformAlertNotifications from '../components/PlatformAlertNotifications';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

import client from '../api/client';

const settings = {
  platform: 'netapp',
  enabled: true,
  recipients: 'netapp-team@example.com',
  minSeverity: 'critical',
  globalMinSeverity: 'warning',
  globalRecipientsSet: true,
  smtpReady: true,
  types: [
    { type: 'health', label: 'health', enabled: true, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-20T00:00:00.000Z' },
    { type: 'disk', label: 'disk', enabled: false, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-20T00:00:00.000Z' },
  ],
};

function renderComponent(props = {}) {
  return render(
    <MemoryRouter>
      <PlatformAlertNotifications platform="netapp" label="NetApp" {...props} />
    </MemoryRouter>
  );
}

describe('PlatformAlertNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.get.mockResolvedValue({ data: settings });
    client.put.mockResolvedValue({ data: settings });
    client.post.mockResolvedValue({ data: { ok: true } });
  });

  it('renders values fetched from GET /alert-notify/:platform', async () => {
    renderComponent();
    await waitFor(() => expect(client.get).toHaveBeenCalledWith('/alert-notify/netapp', expect.any(Object)));
    expect(await screen.findByDisplayValue('netapp-team@example.com')).toBeInTheDocument();
    expect(screen.getByText('health')).toBeInTheDocument();
    expect(screen.getByText('disk')).toBeInTheDocument();
  });

  it('Save PUTs the edited recipients, minSeverity and enabled flag', async () => {
    renderComponent();
    await screen.findByDisplayValue('netapp-team@example.com');

    fireEvent.change(screen.getByLabelText('Recipients'), { target: { value: 'new-team@example.com' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(client.put).toHaveBeenCalledWith('/alert-notify/netapp', {
      recipients: 'new-team@example.com',
      minSeverity: 'critical',
      enabled: true,
    }));
  });

  it('toggles a type immediately via PUT /alert-notify/:platform/types/:type', async () => {
    renderComponent();
    await screen.findByText('health');

    const toggle = screen.getByLabelText('Toggle emails for health');
    fireEvent.click(toggle);

    await waitFor(() => expect(client.put).toHaveBeenCalledWith('/alert-notify/netapp/types/health', { enabled: false }));
  });

  it('hides the alert types block when hideTypes is set', async () => {
    renderComponent({ hideTypes: true });
    await screen.findByDisplayValue('netapp-team@example.com');
    expect(screen.queryByText('Alert types')).not.toBeInTheDocument();
  });
});
