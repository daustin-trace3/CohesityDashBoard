import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UserMenu from '../components/UserMenu';

function setup(user, logout = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/ops?x=1']}>
      <UserMenu user={user} logout={logout} />
    </MemoryRouter>
  );
  return logout;
}
const local = { id: 1, username: 'doug', displayName: 'Doug A', authProvider: 'local' };

describe('UserMenu', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders the name and opens on click', () => {
    setup(local);
    expect(screen.getByText('Doug A')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Doug A/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByText('Local account')).toBeTruthy();
  });

  it('shows Change password for local accounts only', () => {
    const { unmount } = render(<MemoryRouter><UserMenu user={local} logout={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Doug A/ }));
    expect(screen.getByText('Change password')).toBeTruthy();
    unmount();
    render(<MemoryRouter><UserMenu user={{ ...local, authProvider: 'ad' }} logout={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Doug A/ }));
    expect(screen.queryByText('Change password')).toBeNull();
    expect(screen.getByText('Active Directory')).toBeTruthy();
  });

  it('switcher item writes localStorage and dispatches the event', () => {
    const handler = vi.fn();
    window.addEventListener('switcher-mode-changed', handler);
    setup(local);
    fireEvent.click(screen.getByRole('button', { name: /Doug A/ }));
    fireEvent.click(screen.getByText('Grid launcher'));
    expect(localStorage.getItem('platform-switcher-mode')).toBe('grid');
    expect(handler).toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
    window.removeEventListener('switcher-mode-changed', handler);
  });

  it('Sign out calls logout and Escape closes', () => {
    const logout = setup(local);
    fireEvent.click(screen.getByRole('button', { name: /Doug A/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Doug A/ }));
    fireEvent.click(screen.getByText('Sign out'));
    expect(logout).toHaveBeenCalled();
  });
});
