import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReleaseNotesModal from '../components/ReleaseNotesModal';

const latest = {
  version: '1.1.0',
  date: '2026-08-03',
  previousVersion: '1.0.0',
  sections: [
    { title: 'Added', items: ['Proxmox VE platform support'] },
    { title: 'Fixed', items: ['Failed polls no longer wipe stored inventory'] },
  ],
};

describe('ReleaseNotesModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders version, date, and section items', () => {
    render(<ReleaseNotesModal latest={latest} onClose={() => {}} />);
    expect(screen.getByText(/What's New/)).toBeInTheDocument();
    expect(screen.getByText(/1\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText('Proxmox VE platform support')).toBeInTheDocument();
    expect(screen.getByText('Added')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
  });

  it('shows empty state when there are no sections', () => {
    render(<ReleaseNotesModal latest={{ version: '1.1.0', date: null, sections: [] }} onClose={() => {}} />);
    expect(screen.getByText('No release notes available.')).toBeInTheDocument();
  });

  it('shows empty state when latest is missing', () => {
    render(<ReleaseNotesModal latest={null} onClose={() => {}} />);
    expect(screen.getByText('No release notes available.')).toBeInTheDocument();
  });

  it('writes the version to localStorage on mount', () => {
    render(<ReleaseNotesModal latest={latest} onClose={() => {}} />);
    expect(localStorage.getItem('icc:release-notes-seen')).toBe('1.1.0');
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<ReleaseNotesModal latest={latest} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<ReleaseNotesModal latest={latest} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
