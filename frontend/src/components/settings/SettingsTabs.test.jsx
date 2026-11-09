import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SettingsTabs, { useSettingsTab } from './SettingsTabs';

const TABS = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Beta', dirty: true },
  { key: 'c', label: 'Gamma', hidden: true },
];

function Harness() {
  const [tab, setTab] = useSettingsTab(TABS, 'a');
  const loc = useLocation();
  return (
    <div>
      <SettingsTabs tabs={TABS} active={tab} onChange={setTab} />
      <span data-testid="active">{tab}</span>
      <span data-testid="search">{loc.search}</span>
    </div>
  );
}

describe('SettingsTabs', () => {
  it('renders visible tabs, marks the active one and shows the dirty dot', () => {
    render(<MemoryRouter initialEntries={['/x']}><Harness /></MemoryRouter>);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /Alpha/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTitle('Unsaved changes')).toBeTruthy();
  });

  it('keeps the active tab in ?tab= and falls back on a hidden or invalid key', () => {
    render(<MemoryRouter initialEntries={['/x?tab=c']}><Harness /></MemoryRouter>);
    expect(screen.getByTestId('active').textContent).toBe('a');
    fireEvent.click(screen.getByRole('tab', { name: /Beta/ }));
    expect(screen.getByTestId('active').textContent).toBe('b');
    expect(screen.getByTestId('search').textContent).toBe('?tab=b');
  });
});
