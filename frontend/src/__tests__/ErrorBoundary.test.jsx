import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ErrorBoundary from '../components/ErrorBoundary';

function Boom({ shouldThrow }) {
  if (shouldThrow) throw new Error('test render error');
  return <div>OK</div>;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(<ErrorBoundary><Boom shouldThrow={false} /></ErrorBoundary>);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('shows error UI when child throws', () => {
    render(<ErrorBoundary><Boom shouldThrow /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong on this page')).toBeInTheDocument();
    expect(screen.getByText(/test render error/)).toBeInTheDocument();
  });

  it('shows error message in the UI', () => {
    render(<ErrorBoundary><Boom shouldThrow /></ErrorBoundary>);
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByText('Reload page')).toBeInTheDocument();
  });

  it('resets error state when Try again is clicked', () => {
    const { rerender } = render(<ErrorBoundary><Boom shouldThrow /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong on this page')).toBeInTheDocument();
    // Swap to non-throwing child first, then reset — boundary re-renders children successfully
    rerender(<ErrorBoundary><Boom shouldThrow={false} /></ErrorBoundary>);
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('OK')).toBeInTheDocument();
  });
});
