import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Small hover / focus card. The trigger is wrapped in a div; the card is
// portalled to body (position fixed) so a grid or an overflow-hidden parent
// cannot clip it. It opens on mouse enter and on focus inside the trigger and
// closes on mouse leave, blur and Escape. `content` is rendered inside the card.
// A short close delay lets the pointer travel from the trigger onto the card.
const CARD_W = 300;

// useHoverCard returns { bind, card }: spread `bind` on the trigger element and
// render `card` anywhere (it portals to body, so it never changes the trigger's
// DOM parent). HoverCard below is the wrapper-div form of the same thing.
export function useHoverCard(content, { width = CARD_W, disabled = false } = {}) {
  const ref = useRef(null);
  const timer = useRef(null);
  const [pos, setPos] = useState(null);

  const open = useCallback(() => {
    if (disabled || !ref.current) return;
    clearTimeout(timer.current);
    const r = ref.current.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const below = r.bottom + 6;
    // Flip above when there is little room below; the card height is not known yet, so use a coarse guess.
    const flip = vh - below < 220 && r.top > 240;
    setPos(flip ? { left, bottom: vh - r.top + 6 } : { left, top: below });
  }, [disabled, width]);

  const close = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPos(null), 80);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!pos) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPos(null); };
    const onScroll = () => setPos(null);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll, true); };
  }, [pos]);

  const card = pos && !disabled ? createPortal(
    <div role="tooltip" onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={close}
      className="fixed z-[60] rounded-lg border p-3 text-[11px] leading-relaxed shadow-modal"
      style={{ ...pos, width, background: '#0B1015', borderColor: '#2b3b4b' }}>
      {content}
    </div>,
    document.body
  ) : null;

  return { bind: { ref, onMouseEnter: open, onMouseLeave: close, onFocus: open, onBlur: close }, card };
}

export default function HoverCard({ content, children, className = '', width = CARD_W, disabled = false }) {
  const { bind, card } = useHoverCard(content, { width, disabled });
  return <div className={className} {...bind}>{children}{card}</div>;
}
