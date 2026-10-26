import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  DateRangeControl, RangeNote, useDateRange, timeoutForDays, csvFilename, localDayKey,
} from '../components/ui/DateRangeControl';

const run = (qs) => renderHook(() => useDateRange(new URLSearchParams(qs), vi.fn())).result.current;

describe('useDateRange', () => {
  it('defaults to the last 30 days', () => {
    const r = run('');
    expect(r.range).toMatchObject({ mode: 'days', days: 30 });
    expect(r.label).toBe('Last 30 days');
    expect(r.dayKeys).toHaveLength(30);
    expect(r.dayKeys[0]).toBe(localDayKey(new Date()));
    expect(r.params).toMatchObject({ days: 30, tz: new Date().getTimezoneOffset() });
  });

  it('reads days from the URL and ignores bad values', () => {
    expect(run('days=7').days).toBe(7);
    expect(run('days=0').days).toBe(30);
    expect(run('days=999').days).toBe(30);
    expect(run('days=abc').days).toBe(30);
  });

  it('computes an inclusive custom span, label and day keys', () => {
    const r = run('from=2026-10-01&to=2026-10-26');
    expect(r.range.mode).toBe('custom');
    expect(r.days).toBe(26);
    expect(r.label).toBe('Oct 1 to Oct 26, 2026');
    expect(r.dayKeys).toHaveLength(26);
    expect(r.dayKeys[0]).toBe('2026-10-26');
    expect(r.dayKeys[25]).toBe('2026-10-01');
    expect(r.params).toMatchObject({ from: '2026-10-01', to: '2026-10-26' });
    expect(r.params.days).toBeUndefined();
  });

  it('falls back to the default for an inverted or oversized custom range', () => {
    expect(run('from=2026-10-26&to=2026-10-01').range.mode).toBe('days');
    expect(run('from=2024-01-01&to=2026-10-01').range.mode).toBe('days');
  });

  it('follows the timeout ladder', () => {
    expect(timeoutForDays(7)).toBeUndefined();
    expect(timeoutForDays(29)).toBeUndefined();
    expect(timeoutForDays(30)).toBe(60000);
    expect(timeoutForDays(90)).toBe(120000);
    expect(timeoutForDays(365)).toBe(180000);
    expect(run('from=2026-01-01&to=2026-06-30').timeout).toBe(120000);
  });

  it('writes the range to the URL and keeps other params', () => {
    const set = vi.fn();
    const { result } = renderHook(() => useDateRange(new URLSearchParams('q=web&days=7'), set));
    result.current.setCustom('2026-10-01', '2026-10-05');
    const p = set.mock.calls[0][0];
    expect(p.get('q')).toBe('web');
    expect(p.get('from')).toBe('2026-10-01');
    expect(p.get('days')).toBeNull();
  });

  it('builds the csv filename from the day keys', () => {
    expect(csvFilename('cohesity', ['2026-10-26', '2026-10-25', '2026-10-24'])).toBe('cohesity-backup-history-2026-10-24_2026-10-26.csv');
  });
});

describe('DateRangeControl', () => {
  it('renders the chips and reports a chip pick', () => {
    const onChange = vi.fn();
    render(<DateRangeControl value={{ mode: 'days', days: 30 }} onChange={onChange} />);
    ['7d', '14d', '30d', '90d', 'Custom'].forEach((t) => expect(screen.getByText(t)).toBeInTheDocument());
    fireEvent.click(screen.getByText('14d'));
    expect(onChange).toHaveBeenCalledWith({ mode: 'days', days: 14 });
  });

  it('rejects an inverted custom range', () => {
    const onChange = vi.fn();
    render(<DateRangeControl value={{ mode: 'days', days: 30 }} onChange={onChange} />);
    fireEvent.click(screen.getByText('Custom'));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-10' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(screen.getByRole('alert')).toHaveTextContent('From must be on or before To');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies a valid custom range', () => {
    const onChange = vi.fn();
    render(<DateRangeControl value={{ mode: 'days', days: 30 }} onChange={onChange} />);
    fireEvent.click(screen.getByText('Custom'));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-10' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(onChange).toHaveBeenCalledWith({ mode: 'custom', from: '2026-10-01', to: '2026-10-10' });
  });

  it('rejects a span over maxDays', () => {
    const onChange = vi.fn();
    render(<DateRangeControl value={{ mode: 'days', days: 30 }} onChange={onChange} maxDays={30} />);
    fireEvent.click(screen.getByText('Custom'));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-10' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(screen.getByRole('alert')).toHaveTextContent('limited to 30 days');
  });
});

describe('RangeNote', () => {
  it('shows only when truncated', () => {
    const { container, rerender } = render(<RangeNote historyDays={90} truncated={false} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RangeNote historyDays={90} truncated />);
    expect(screen.getByText(/History is kept for 90 days; older days are empty/)).toBeInTheDocument();
  });
});
