import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WhyHover, WhyBlock } from './LmEpisodeWhy';

const why = { headline: 'Degrading: elevated for 16 min (promoted 2026-10-19T10:16:00.000Z)', lines: ['Peak 84 ms, 2.8x the baseline of 30 ms (168 samples)'] };

describe('episode why', () => {
  it('the block shows the headline and lines with the timestamp formatted', () => {
    const { getByTestId } = render(<WhyBlock why={why} />);
    const t = getByTestId('episode-why').textContent;
    expect(t).toContain('Degrading: elevated for 16 min (promoted ');
    expect(t).not.toContain('2026-10-19T10:16:00.000Z');
    expect(t).toContain('Peak 84 ms');
  });

  it('the hover opens a bubble with the reason and renders the badge alone without one', () => {
    const { getByText, getByRole, queryByRole, rerender } = render(<WhyHover why={why}><span>degrading</span></WhyHover>);
    fireEvent.mouseEnter(getByText('degrading').closest('div'));
    expect(getByRole('tooltip').textContent).toContain('Peak 84 ms');
    rerender(<WhyHover why={null}><span>degrading</span></WhyHover>);
    expect(queryByRole('tooltip')).toBeNull();
  });
});
