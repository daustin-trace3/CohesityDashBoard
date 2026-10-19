import { fmtWhen } from './helpers';
import HoverCard from '../../components/ui/HoverCard';

// Plain-English reason for a latency episode state. The backend (episodeWhy in
// services/logicmonitorWatch.js) sends ISO timestamps inside the text; they are
// shown in the page's usual format here.
const ISO = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/g;
const nice = (t) => String(t == null ? '' : t).replace(ISO, (m) => fmtWhen(m));

export function WhyBody({ why }) {
  if (!why) return null;
  return (
    <div data-testid="episode-why">
      <p className="text-[12px] font-semibold text-ink">{nice(why.headline)}</p>
      {(why.lines || []).map((l, i) => <p key={i} className="text-ink-muted mt-0.5">{nice(l)}</p>)}
    </div>
  );
}

/** Wraps a state badge: hover or focus opens the reason bubble. Renders the children alone without a reason. */
export function WhyHover({ why, children }) {
  if (!why) return children;
  return (
    <HoverCard content={<WhyBody why={why} />} width={340} className="inline-block" >
      <span tabIndex={0} className="outline-none cursor-help">{children}</span>
    </HoverCard>
  );
}

/** Visible block for the episode modal header. */
export function WhyBlock({ why }) {
  if (!why) return null;
  return (
    <div className="rounded-lg border p-3 text-[11px] leading-relaxed" style={{ borderColor: '#2b3b4b', background: '#0B1015' }}>
      <WhyBody why={why} />
    </div>
  );
}
