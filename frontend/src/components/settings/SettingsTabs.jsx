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
            className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 -mb-px text-xs font-medium rounded-t-lg border border-b-0 border-t-2 transition-colors cursor-pointer ${
              on
                ? 'border-cohesity-border border-t-brand bg-surface-base text-ink'
                : 'border-cohesity-border/60 border-t-transparent bg-surface-overlay/40 text-ink-muted hover:text-ink hover:bg-surface-overlay hover:border-cohesity-border'}`}>
            {Icon && <Icon size={13} className={on ? 'text-brand' : 'text-ink-faint'} />}
            {t.label}
            {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
          </button>
        );
      })}
    </div>
  );
}
