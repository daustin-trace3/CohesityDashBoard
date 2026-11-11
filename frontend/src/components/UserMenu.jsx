import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Check, KeyRound, LogOut } from 'lucide-react';
import client from '../api/client';
import { SWITCHER_MODES, getSwitcherMode, saveSwitcherMode } from './PlatformSwitcher';

const PROVIDER_LABELS = {
  local: 'Local account',
  ad: 'Active Directory',
  oidc: 'Okta',
  saml: 'Okta',
};

/**
 * Header user menu: switcher style, change password (local accounts only),
 * sign out. Open-access sessions (no user id) get the name only.
 */
export default function UserMenu({ user, logout }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(getSwitcherMode);
  const ref = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();
  const name = user.displayName || user.username;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onMode = () => setMode(getSwitcherMode());
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('switcher-mode-changed', onMode);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('switcher-mode-changed', onMode);
    };
  }, [open]);

  if (user.id == null) {
    return (
      <span className="text-xs text-ink-muted max-w-[120px] truncate hidden sm:block" title={name}>{name}</span>
    );
  }

  const provider = user.authProvider || 'local';
  const pickMode = (id) => {
    setMode(id);
    saveSwitcherMode(id, client, user);
  };
  const itemClass = 'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-[12px] text-ink-muted hover:bg-surface-overlay hover:text-ink transition-colors cursor-pointer';

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={name}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-cohesity-border text-xs text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer"
      >
        <span className="max-w-[120px] truncate">{name}</span>
        <ChevronDown size={13} className={`text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1.5 w-60 rounded-xl border border-cohesity-border bg-surface shadow-panel z-50 p-1.5">
          <div className="px-2 pt-1 pb-2 border-b border-cohesity-border mb-1">
            <p className="text-[12px] font-semibold text-ink truncate">{name}</p>
            <p className="text-[11px] text-ink-muted truncate">{user.username}</p>
            <p className="text-[10px] uppercase tracking-wider text-ink-faint mt-0.5">{PROVIDER_LABELS[provider] || provider}</p>
          </div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint px-2 pt-1 pb-1">Switcher style</p>
          {SWITCHER_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode === m.id}
              onClick={() => pickMode(m.id)}
              className={`${itemClass} ${mode === m.id ? 'bg-surface-overlay text-ink' : ''}`}
            >
              <span className="flex-1 text-left">{m.label}</span>
              {mode === m.id && <Check size={13} className="text-brand" />}
            </button>
          ))}
          <div className="border-t border-cohesity-border my-1" />
          {provider === 'local' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); navigate('/change-password', { state: { returnTo: location.pathname + location.search } }); }}
              className={itemClass}
            >
              <KeyRound size={14} />
              <span className="flex-1 text-left">Change password</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); logout(); }}
            className={itemClass}
          >
            <LogOut size={14} />
            <span className="flex-1 text-left">Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}
