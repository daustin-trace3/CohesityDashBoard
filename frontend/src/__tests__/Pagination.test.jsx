import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Pagination from '../components/Pagination';

const base = { page: 0, totalPages: 5, pageSize: 25, onPage: vi.fn(), onPageSize: vi.fn(), totalItems: 120 };

describe('Pagination', () => {
  it('renders nothing when totalItems is 0', () => {
    const { container } = render(<Pagination {...base} totalItems={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows X–Y of N range', () => {
    render(<Pagination {...base} />);
    expect(screen.getByText('1–25 of 120')).toBeInTheDocument();
  });

  it('calls onPage with page+1 on next click', () => {
    const onPage = vi.fn();
    render(<Pagination {...base} onPage={onPage} />);
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(onPage).toHaveBeenCalledWith(1);
  });

  it('disables previous button on first page', () => {
    render(<Pagination {...base} page={0} />);
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
  });

  it('disables next button on last page', () => {
    render(<Pagination {...base} page={4} totalPages={5} />);
    expect(screen.getByLabelText('Next page')).toBeDisabled();
  });

  it('calls onPageSize when page size button clicked', () => {
    const onPageSize = vi.fn();
    render(<Pagination {...base} onPageSize={onPageSize} />);
    fireEvent.click(screen.getByText('50'));
    expect(onPageSize).toHaveBeenCalledWith(50);
  });

  it('compact mode renders only prev/next', () => {
    render(<Pagination {...base} compact />);
    expect(screen.getByLabelText('Previous page')).toBeInTheDocument();
    expect(screen.getByLabelText('Next page')).toBeInTheDocument();
    expect(screen.queryByText('Rows per page:')).not.toBeInTheDocument();
  });
});
