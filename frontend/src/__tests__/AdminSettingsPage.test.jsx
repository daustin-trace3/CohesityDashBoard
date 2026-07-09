import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdminSettingsPage from '../pages/AdminSettingsPage';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true, loading: false }),
}));

import client from '../api/client';

const notifySettings = {
  smtpEnabled: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpEncryption: 'starttls',
  smtpAuthMethod: 'login',
  smtpUsername: 'alerts@example.com',
  smtpPasswordSet: true,
  smtpFrom: 'alerts@example.com',
  smtpRecipients: 'ops@example.com',
  alertMinSeverity: 'warning',
  alertPlatforms: { cohesity: true, pure: false, netapp: true },
  reminderHours: 24,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminSettingsPage />
    </MemoryRouter>
  );
}

describe('AdminSettingsPage — Alert Notifications tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.get.mockImplementation((url) => {
      if (url === '/settings/notifications') return Promise.resolve({ data: notifySettings });
      return Promise.resolve({ data: {} });
    });
    client.put.mockResolvedValue({ data: notifySettings });
    client.post.mockResolvedValue({ data: { ok: true } });
  });

  it('shows the Alert Notifications tab', () => {
    renderPage();
    expect(screen.getByText('Alert Notifications')).toBeInTheDocument();
  });

  it('loads and populates fields from GET on tab activation', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Alert Notifications'));
    await waitFor(() => expect(client.get).toHaveBeenCalledWith('/settings/notifications'));
    expect(await screen.findByDisplayValue('smtp.example.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ops@example.com')).toBeInTheDocument();
  });

  it('Save PUTs without smtpPassword when the password field is untouched', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Alert Notifications'));
    await screen.findByDisplayValue('smtp.example.com');

    fireEvent.click(screen.getByText('Save settings'));

    await waitFor(() => expect(client.put).toHaveBeenCalledWith('/settings/notifications', expect.not.objectContaining({ smtpPassword: expect.anything() })));
  });

  it('Save PUTs smtpPassword once the user types a new one', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Alert Notifications'));
    await screen.findByDisplayValue('smtp.example.com');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByText('Save settings'));

    await waitFor(() => expect(client.put).toHaveBeenCalledWith('/settings/notifications', expect.objectContaining({ smtpPassword: 'new-secret' })));
  });
});
