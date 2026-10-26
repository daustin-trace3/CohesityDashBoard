import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ResolveNoteDialog from '../components/ops/ResolveNoteDialog';

describe('ResolveNoteDialog', () => {
  it('disables Resolve until a note is typed when required', () => {
    const onSubmit = vi.fn();
    render(<ResolveNoteDialog required onSubmit={onSubmit} onCancel={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Resolve' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Resolution note/), { target: { value: '   ' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Resolution note/), { target: { value: 'Replaced the DIMM' } });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledWith('Replaced the DIMM');
  });

  it('allows an empty note when not required', () => {
    const onSubmit = vi.fn();
    render(<ResolveNoteDialog onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('calls onCancel from Cancel and Escape', () => {
    const onCancel = vi.fn();
    render(<ResolveNoteDialog onSubmit={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('blocks submit while busy', () => {
    const onSubmit = vi.fn();
    render(<ResolveNoteDialog busy onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Resolving...' })).toBeDisabled();
  });
});
