// One shell for every platform Settings page: a section rail on the left with
// the platform colour bar on top, and the section's panels on the right. Pages
// own their section list, active key and content; this only draws the frame.
export default function PlatformSettingsLayout({ brand, sections, active, onSelect, label, children }) {
  const grouped = sections.some((s) => s.group);
  const groups = grouped ? [...new Set(sections.map((s) => s.group || ''))] : [''];
  const item = (s) => {
    const Icon = s.icon;
    const isActive = active === s.key;
    return (
      <button key={s.key} onClick={() => onSelect(s.key)} aria-current={isActive ? 'page' : undefined}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors cursor-pointer ${isActive ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:bg-surface-overlay/60 hover:text-ink'}`}
        style={{ border: 'none' }}>
        {Icon && <Icon size={13} className={isActive ? 'text-brand' : 'text-ink-faint'} />}
        {s.label}
      </button>
    );
  };
  return (
    <div className="flex flex-col md:flex-row gap-4 items-start">
      <nav className="w-full md:w-56 shrink-0 panel p-2" style={{ borderTop: `3px solid ${brand}` }} aria-label={label ? `${label} settings sections` : 'Settings sections'}>
        {groups.map((g) => (
          <div key={g || 'all'} className={grouped ? 'mb-2 last:mb-0' : ''}>
            {g && <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint px-2 pt-1 mb-1">{g}</p>}
            {sections.filter((s) => (s.group || '') === g).map(item)}
          </div>
        ))}
      </nav>
      <div className="flex-1 min-w-0 flex flex-col gap-4">{children}</div>
    </div>
  );
}
