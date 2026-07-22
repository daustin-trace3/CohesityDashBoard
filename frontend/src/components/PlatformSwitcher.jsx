import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LayoutGrid, Check, Hexagon, ShieldCheck, Activity } from 'lucide-react';
import dellLogo from '../assets/platform-logos/dell.svg';
import vcenterLogo from '../assets/platform-logos/vcenter.svg';
import netappLogo from '../assets/platform-logos/netapp.svg';
import pureLogo from '../assets/platform-logos/pure.svg';

// Three experimental platform-switcher styles (dropdown | rail | grid), trialed
// side-by-side against the original tab row. The active style is a per-browser
// preference: localStorage 'platform-switcher-mode', picked on Global Settings.
// Once one wins, delete the others (and this comment).

export const SWITCHER_MODES = [
  { id: 'tabs', label: 'Tabs (original)' },
  { id: 'dropdown', label: 'Dropdown' },
  { id: 'rail', label: 'Icon rail' },
  { id: 'grid', label: 'Grid launcher' },
];

export function getSwitcherMode() {
  const m = localStorage.getItem('platform-switcher-mode');
  return SWITCHER_MODES.some(x => x.id === m) ? m : 'tabs';
}

/** Rolled-up health for one platform from the /poller/status payload. */
export function platformHealth(status, id) {
  const p = status?.[id];
  if (!p || p.enabled === false) return { tone: '#8FA3B0', label: 'no data' };
  if (p.entities) {
    if (p.entities.some(e => e.lastPollStatus === 'error')) return { tone: '#C75D5D', label: 'errors' };
    if (p.entities.some(e => e.isStale)) return { tone: '#D4A24E', label: 'stale' };
    if (p.entities.length === 0) return { tone: '#8FA3B0', label: 'no data' };
    return { tone: '#6CB33F', label: 'healthy' };
  }
  if (p.failedSources?.length) return { tone: '#C75D5D', label: 'errors' };
  if (p.isStale) return { tone: '#D4A24E', label: 'stale' };
  if (!p.lastDataCapture) return { tone: '#8FA3B0', label: 'no data' };
  return { tone: '#6CB33F', label: 'healthy' };
}

function useClickOutside(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return ref;
}

const monogram = (label) => label.slice(0, 2);

// Official brand marks (bundled SVGs, tinted to each platform's color).
// Cohesity reuses the app's own hexagon+shield identity; platforms without
// a mark (Zerto, future plugins) fall back to the monogram.
const LOGOS = { dell: dellLogo, vcenter: vcenterLogo, netapp: netappLogo, pure: pureLogo };

export function PlatformLogo({ platform, size = 18 }) {
  if (platform.id === 'ops') {
    return <Activity size={size} strokeWidth={2} style={{ color: platform.color }} />;
  }
  if (platform.id === 'cohesity') {
    return (
      <span className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <Hexagon size={size} strokeWidth={1.75} style={{ color: platform.color }} />
        <ShieldCheck size={Math.round(size * 0.46)} className="absolute" strokeWidth={2.5} style={{ color: platform.color }} />
      </span>
    );
  }
  const src = LOGOS[platform.id];
  if (src) return <img src={src} alt="" style={{ width: size, height: size }} draggable={false} />;
  return <>{monogram(platform.label)}</>;
}

/* ── Style 1: compact dropdown in the top bar ──────────────────────────── */
export function PlatformDropdown({ platforms, currentId, onSelect, status }) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const current = platforms.find(p => p.id === currentId) || platforms[0];
  if (!current) return null;
  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-cohesity-border bg-surface text-[12px] font-medium text-ink hover:border-brand/40 transition-colors cursor-pointer">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: current.color, boxShadow: `0 0 6px ${current.color}99` }} />
        {current.label}
        <ChevronDown size={13} className={`text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-52 rounded-xl border border-cohesity-border bg-surface shadow-panel z-50 p-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint px-2 pt-1 pb-1.5">Platforms</p>
          {platforms.map(p => {
            const h = platformHealth(status, p.id);
            const active = p.id === currentId;
            return (
              <button key={p.id} onClick={() => { setOpen(false); onSelect(p); }}
                className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-[12px] transition-colors cursor-pointer ${active ? 'bg-surface-overlay text-ink' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink'}`}>
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                <span className="flex-1 text-left font-medium">{p.label}</span>
                <span className="w-1.5 h-1.5 rounded-full" title={h.label} style={{ backgroundColor: h.tone }} />
                {active && <Check size={13} className="text-brand" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Style 2: vertical icon rail on the far left ───────────────────────── */
export function PlatformRail({ platforms, currentId, onSelect, status }) {
  return (
    <div className="w-[52px] bg-surface-base/90 border-r border-cohesity-border flex flex-col items-center py-3 gap-2 flex-shrink-0">
      {platforms.map(p => {
        const h = platformHealth(status, p.id);
        const active = p.id === currentId;
        return (
          <button key={p.id} onClick={() => onSelect(p)} title={`${p.label} — ${h.label}`}
            className={`relative w-9 h-9 rounded-xl flex items-center justify-center text-[11px] font-bold transition-all duration-150 cursor-pointer ${active ? 'scale-105' : 'opacity-70 hover:opacity-100'}`}
            style={{
              backgroundColor: active ? `${p.color}33` : `${p.color}22`,
              color: p.color,
              boxShadow: active
                ? `inset 0 0 0 2px ${p.color}, 0 0 12px 2px ${p.color}66`
                : `inset 0 0 0 1px ${p.color}44`,
            }}>
            <PlatformLogo platform={p} size={18} />
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-cohesity-black" style={{ backgroundColor: h.tone }} />
          </button>
        );
      })}
    </div>
  );
}

/* ── Style 3: waffle button + tile grid popover ────────────────────────── */
export function PlatformGrid({ platforms, currentId, onSelect, status }) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button onClick={() => setOpen(o => !o)} title="Switch platform" aria-label="Switch platform"
        className={`flex items-center justify-center h-8 w-8 rounded-lg border transition-colors cursor-pointer ${open ? 'border-brand/60 text-brand' : 'border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40'}`}>
        <LayoutGrid size={15} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-[300px] rounded-xl border border-cohesity-border bg-surface shadow-panel z-50 p-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint px-1 pb-2">Platforms</p>
          <div className="grid grid-cols-2 gap-2">
            {platforms.map(p => {
              const h = platformHealth(status, p.id);
              const active = p.id === currentId;
              return (
                <button key={p.id} onClick={() => { setOpen(false); onSelect(p); }}
                  className={`flex flex-col items-start gap-1.5 rounded-lg p-2.5 border transition-colors cursor-pointer text-left ${active ? 'bg-surface-overlay' : 'hover:bg-surface-overlay'}`}
                  style={{ borderColor: active ? p.color : 'rgba(255,255,255,0.08)' }}>
                  <span className="flex items-center gap-2 w-full">
                    <span className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                      style={{ backgroundColor: `${p.color}22`, color: p.color }}><PlatformLogo platform={p} size={14} /></span>
                    <span className="text-[12px] font-semibold text-ink truncate">{p.label}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[10px] text-ink-faint">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: h.tone }} />
                    {h.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
