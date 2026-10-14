import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import IntelligenceSettingsPage from '../pages/IntelligenceSettingsPage';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true, loading: false }),
}));

import client from '../api/client';

const settings = {
  llmProvider: 'auto',
  llmModel: '',
  llmEstateContext: 'normal estate',
  opsAgent: {
    enabled: true, name: 'ICC Operations Agent', minSeverity: 'warning', grouping: 'platform',
    holdMinutes: 10, analysesPerHour: 20, renotifyMinutes: 60, autoResolveMinutes: 30,
    evidenceResolve: true, patternMin: 3, patternDays: 14, emailEnabled: true, recipients: '',
  },
};

function LocationProbe() {
  const { search } = useLocation();
  return <span data-testid="search">{search}</span>;
}

function renderPage(path = '/admin/intelligence') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/intelligence" element={<IntelligenceSettingsPage />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

function mockAi(enabled) {
  client.get.mockImplementation((url) => {
    if (url === '/settings') return Promise.resolve({ data: settings });
    if (url === '/cohesity/insights/ai/config') return Promise.resolve({ data: { enabled } });
    if (url === '/settings/llm-models') return Promise.resolve({ data: { provider: 'openai', models: ['gpt-a'], default: 'gpt-a' } });
    return Promise.resolve({ data: {} });
  });
}

describe('IntelligenceSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAi(true);
    client.put.mockResolvedValue({ data: {} });
    client.post.mockResolvedValue({ data: {} });
  });

  it('a tab click puts the tab in ?tab=', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Estate context/ }));
    expect(screen.getByTestId('search').textContent).toBe('?tab=context');
    expect(await screen.findByDisplayValue('normal estate')).toBeInTheDocument();
  });

  it('Save on the Operations Agent tab PUTs opsAgent with the changed field', async () => {
    renderPage('/admin/intelligence?tab=agent');
    const hold = await screen.findByLabelText('Hold window (minutes)');
    await waitFor(() => expect(hold).toHaveValue(10));
    const save = screen.getByRole('button', { name: /Save agent settings/ });
    expect(save).toBeDisabled();
    fireEvent.change(hold, { target: { value: '25' } });
    expect(screen.getAllByText('unsaved').length).toBeGreaterThan(0);
    fireEvent.click(save);
    await waitFor(() => expect(client.put).toHaveBeenCalledWith('/settings', {
      opsAgent: expect.objectContaining({ holdMinutes: 25, name: 'ICC Operations Agent', enabled: true }),
    }));
    const body = client.put.mock.calls[0][1];
    expect(body.llmEstateContext).toBeUndefined();
    expect(body.opsAgent.recipients).toBeUndefined();
  });

  it('the info tip shows its explanation on hover and on focus', async () => {
    renderPage('/admin/intelligence?tab=agent');
    await screen.findByLabelText('Hold window (minutes)');
    const text = 'How long a new incident collects related alerts before triage. 0 to 120.';
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    const tipButton = screen.getByRole('button', { name: 'About Hold window (minutes)' });
    fireEvent.mouseEnter(tipButton.parentElement);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent(text);
    expect(tipButton).toHaveAttribute('aria-describedby', tip.id);
    fireEvent.mouseLeave(tipButton.parentElement);
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    fireEvent.focus(tipButton);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('hides the agent tabs and shows the provider note without an AI provider', async () => {
    mockAi(false);
    renderPage('/admin/intelligence?tab=agent');
    expect(await screen.findByText(/AI analysis is not configured/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /AI provider/, selected: true })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Operations Agent/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Privacy/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Keys/ })).toBeInTheDocument();
  });
});
