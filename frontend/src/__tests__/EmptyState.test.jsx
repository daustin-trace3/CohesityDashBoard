import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import EmptyState from '../components/EmptyState';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders optional message when provided', () => {
    render(<EmptyState title="Empty" message="Try again later" />);
    expect(screen.getByText('Try again later')).toBeInTheDocument();
  });

  it('does not render message when omitted', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByRole('paragraph')).not.toBeInTheDocument();
  });

  it('renders action button and calls onClick', () => {
    const onClick = vi.fn();
    render(<EmptyState title="Empty" action={{ label: 'Retry', onClick }} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not render action button when action is omitted', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
