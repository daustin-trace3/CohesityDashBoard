import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import GrantEditor from '../components/access/GrantEditor';

vi.mock('../api/client', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

const catalog = {
  categories: [
    { key: 'backup', label: 'Backup', platforms: [
      { id: 'cohesity', label: 'Cohesity', enabled: true, sections: [{ key: 'alerts', label: 'Alerts' }, { key: 'views', label: 'Views' }] },
      { id: 'eon', label: 'EON', enabled: false, sections: [] },
    ] },
    { key: 'storage', label: 'Storage and SAN', platforms: [
      { id: 'pure', label: 'Pure', enabled: true, sections: [] },
      { id: 'netapp', label: 'NetApp', enabled: true, sections: [] },
    ] },
  ],
  ops: { ns: 'ops', label: 'Ops', hint: 'ops hint', sections: [] },
  admin: { ns: 'admin', label: 'Administration', hint: 'settings, users', sections: [] },
  all: { ns: '*', label: 'All platforms', hint: 'every platform' },
};

function setup(grants = [], extra = {}) {
  const onSave = vi.fn(() => Promise.resolve());
  render(<GrantEditor grants={grants} catalog={catalog} onSave={onSave} {...extra} />);
  return onSave;
}
const group = (name) => screen.getByRole('group', { name });
const press = (name, label) => fireEvent.click(within(group(name)).getByRole('button', { name: label }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('GrantEditor', () => {
  beforeEach(() => { localStorage.clear(); });

  it('starts categories collapsed except one with a direct grant', () => {
    setup(['pure:*:view']);
    expect(screen.queryByText('Cohesity')).toBeNull();
    expect(screen.getByText('Pure')).toBeTruthy();
    expect(screen.getByText('NetApp')).toBeTruthy();
  });

  it('category control sets every row and Save sends the full set', () => {
    const onSave = setup(['pure:*:view']);
    press('Storage and SAN access', 'Manage');
    expect(within(group('Pure access')).getByRole('button', { name: 'Manage' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group('NetApp access')).getByRole('button', { name: 'Manage' }).getAttribute('aria-pressed')).toBe('true');
    save();
    expect(onSave).toHaveBeenCalledWith(['netapp:*:manage', 'pure:*:manage']);
  });

  it('shows Mixed when rows disagree', () => {
    setup(['pure:*:view']);
    expect(screen.getByText('Mixed')).toBeTruthy();
    for (const b of within(group('Storage and SAN access')).getAllByRole('button')) {
      expect(b.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('section sub-row sets ns:section:level', () => {
    const onSave = setup(['cohesity:*:view']);
    fireEvent.click(screen.getByRole('button', { name: /Sections \(0\)/ }));
    press('Cohesity Views access', 'Manage');
    save();
    expect(onSave).toHaveBeenCalledWith(['cohesity:*:view', 'cohesity:views:manage']);
  });

  it('disables None on a section covered by the platform level', () => {
    setup(['cohesity:*:view']);
    fireEvent.click(screen.getByRole('button', { name: /Sections/ }));
    expect(within(group('Cohesity Alerts access')).getByRole('button', { name: 'None' }).disabled).toBe(true);
  });

  it('Cancel restores the seed', () => {
    setup(['pure:*:view']);
    press('Pure access', 'Manage');
    expect(screen.getByText('2 changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('2 changes')).toBeNull();
    expect(within(group('Pure access')).getByRole('button', { name: 'View' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('presets produce the stated sets', () => {
    const onSave = setup(['admin:users:view', 'pure:*:view']);
    const preset = (label) => {
      fireEvent.click(screen.getByRole('button', { name: /Presets/ }));
      fireEvent.click(screen.getByRole('button', { name: label }));
      save();
    };
    preset('Read-only on every platform');
    expect(onSave).toHaveBeenLastCalledWith(['*:*:view', 'admin:users:view']);
    preset('Operate every platform, no administration');
    expect(onSave).toHaveBeenLastCalledWith(['*:*:manage', 'admin:users:view']);
    preset('Administrator');
    expect(onSave).toHaveBeenLastCalledWith(['*:*:*', 'admin:*:*']);
    preset('Clear all');
    expect(onSave).toHaveBeenLastCalledWith([]);
  });

  it('Administration does not inherit from all platforms', () => {
    setup(['*:*:view']);
    expect(within(group('Administration access')).getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group('Ops access')).getByRole('button', { name: 'View' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('copy from group replaces the draft', async () => {
    const onCopyFrom = vi.fn(() => Promise.resolve(['netapp:*:view']));
    const onSave = setup(['pure:*:view'], { copySources: [{ id: 7, name: 'Ops team' }], onCopyFrom });
    fireEvent.click(screen.getByRole('button', { name: /Presets/ }));
    fireEvent.change(screen.getByLabelText('Copy from group'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await screen.findByText('2 changes');
    save();
    expect(onSave).toHaveBeenCalledWith(['netapp:*:view']);
  });
});
