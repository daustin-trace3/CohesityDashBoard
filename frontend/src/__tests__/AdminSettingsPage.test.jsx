import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
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

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname}{search}</span>;
}

function renderPage(initialPath = '/admin') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin" element={<AdminSettingsPage />} />
        <Route path="/admin/:section" element={<AdminSettingsPage />} />
      </Routes>
      <LocationProbe />
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

describe('AdminSettingsPage - Intelligence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.get.mockImplementation((url) => {
      if (url === '/cohesity/insights/ai/config') return Promise.resolve({ data: { enabled: true } });
      if (url === '/settings') return Promise.resolve({ data: { opsAgent: { enabled: false, name: 'ICC Operations Agent' } } });
      return Promise.resolve({ data: {} });
    });
    client.put.mockResolvedValue({ data: {} });
  });

  it('shows one Intelligence nav item instead of the four old ones', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /^Intelligence$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /AI Analysis & Keys/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Agent Privacy/ })).not.toBeInTheDocument();
  });

  it('bare /admin lands on the AI provider tab', async () => {
    renderPage('/admin');
    expect(screen.getByTestId('location').textContent).toBe('/admin/intelligence?tab=provider');
    expect(await screen.findByRole('tab', { name: /AI provider/, selected: true })).toBeInTheDocument();
  });

  it('the old /admin/agent route opens the Operations Agent tab', async () => {
    renderPage('/admin/agent');
    expect(screen.getByTestId('location').textContent).toBe('/admin/intelligence?tab=agent');
    expect(await screen.findByRole('tab', { name: /Operations Agent/, selected: true })).toBeInTheDocument();
    expect(await screen.findByLabelText('Agent name')).toBeInTheDocument();
  });

  it('the old /admin/agent-capabilities route opens the Capabilities tab', async () => {
    renderPage('/admin/agent-capabilities');
    expect(await screen.findByRole('tab', { name: /Capabilities/, selected: true })).toBeInTheDocument();
  });
});
