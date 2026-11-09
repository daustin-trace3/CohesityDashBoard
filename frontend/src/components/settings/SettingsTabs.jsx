import { useSearchParams } from 'react-router-dom';

// Shared tab strip for Global Settings pages. Markup and classes match the
// Intelligence page. tabs: [{ key, label, icon?, hidden?, dirty? }].
export function useSettingsTab(tabs, defaultKey) {
  const [params, setParams] = useSearchParams();
  const visible = tabs.filter(t => !t.hidden);
  const requested = params.get('tab') || defaultKey;
  const active = visible.some(t => t.key === requested)
    ? requested
    : (visible[0] ? visible[0].key : defaultKey);
  const onChange = (key) => {
    const next = new URLSearchParams(params);
    next.set('tab', key);
    setParams(next, { replace: true });
  };
  return [active, onChange];
}

export default function SettingsTabs({ tabs, active, onChange, label = 'Settings tabs' }) {
  return (
    <div role="tablist" aria-label={label} className="flex items-end gap-1 overflow-x-auto border-b border-cohesity-border">
      {tabs.filter(t => !t.hidden).map(t => {
        const Icon = t.icon;
        const on = t.key === active;
        return (
          <button key={t.key} role="tab" aria-selected={on} onClick={() => onChange(t.key)}
            className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 -mb-px text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              on ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
            style={{ borderTop: 'none', borderLeft: 'none', borderRight: 'none', background: 'none' }}>
            {Icon && <Icon size={13} className={on ? 'text-brand' : 'text-ink-faint'} />}
            {t.label}
            {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
          </button>
        );
      })}
    </div>
  );
}
