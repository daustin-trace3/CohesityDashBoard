import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, SlidersHorizontal, RotateCcw } from 'lucide-react';

/**
 * User-arrangeable page sections: each section gets a grip handle (hover, top
 * right) for vertical drag-reorder, and the Layout menu toggles visibility.
 * Order + hidden set persist per page via localStorage. Sections added in
 * later builds slot into their default position within a saved order.
 *
 * Usage: <ArrangeableSections storageKey="aria-overview-layout"
 *          sections={[{ id, label, el }, ...]} />
 */
export default function ArrangeableSections({ storageKey, sections }) {
  const [saved, setSaved] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { return {}; }
  });
  const [dragId, setDragId] = useState(null);
  const [armed, setArmed] = useState(null); // section whose grip is pressed
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const ids = sections.map((s) => s.id);
  const order = useMemo(() => {
    const kept = Array.isArray(saved.order) ? saved.order.filter((id) => ids.includes(id)) : [];
    const merged = [...kept];
    ids.forEach((id, i) => { if (!merged.includes(id)) merged.splice(Math.min(i, merged.length), 0, id); });
    return merged;
  }, [saved, sections]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden.filter((id) => ids.includes(id)) : []);
  const customized = JSON.stringify(order) !== JSON.stringify(ids) || hidden.size > 0;

  const persist = (next) => {
    setSaved(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* private mode */ }
  };

  const moveTo = (from, to, before) => {
    const next = order.filter((id) => id !== from);
    const j = next.indexOf(to);
    next.splice(before ? j : j + 1, 0, from);
    if (JSON.stringify(next) !== JSON.stringify(order)) persist({ ...saved, order: next });
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

  return (
    <div>
      <div className="flex justify-end -mb-1">
        <button
          ref={btnRef}
          onClick={() => {
            if (!menuOpen && btnRef.current) {
              const r = btnRef.current.getBoundingClientRect();
              setMenuPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
            }
            setMenuOpen((o) => !o);
          }}
          title="Arrange page sections"
          className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-ink-faint hover:text-ink border border-transparent hover:border-cohesity-border transition-colors cursor-pointer">
          <SlidersHorizontal size={11} /> Layout{customized ? ' *' : ''}
        </button>
      </div>

      {order.map((id) => {
        const s = byId[id];
        if (!s || hidden.has(id)) return null;
        return (
          <div
            key={id}
            draggable={armed === id}
            onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => { setDragId(null); setArmed(null); }}
            onDragOver={(e) => {
              if (!dragId || dragId === id) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              moveTo(dragId, id, e.clientY < r.top + r.height / 2);
            }}
            className={`relative group/arr ${dragId === id ? 'opacity-60 ring-1 ring-brand/50 rounded-xl' : ''}`}>
            <div
              onMouseDown={() => setArmed(id)}
              onMouseUp={() => setArmed(null)}
              title={`Drag to move "${s.label}"`}
              className="absolute right-2 top-2 z-10 p-1 rounded text-ink-faint opacity-0 group-hover/arr:opacity-100 hover:text-ink hover:bg-surface-overlay cursor-grab active:cursor-grabbing transition-opacity">
              <GripVertical size={14} />
            </div>
            {s.el}
          </div>
        );
      })}

      {menuOpen && menuPos && createPortal(
        <div ref={menuRef} style={{ top: menuPos.top, right: menuPos.right }}
          className="fixed z-50 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl py-1.5 min-w-[220px]">
          <p className="px-3 pb-1 text-[10px] uppercase tracking-wide text-ink-faint font-semibold">Page sections</p>
          {order.map((id) => byId[id] && (
            <label key={id} className="flex items-center gap-2 px-3 py-1 text-[13px] text-ink hover:bg-brand/10 cursor-pointer">
              <input
                type="checkbox"
                checked={!hidden.has(id)}
                onChange={() => {
                  const next = new Set(hidden);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  persist({ ...saved, hidden: [...next] });
                }}
                className="accent-[#6CB33F]" />
              {byId[id].label}
            </label>
          ))}
          <div className="border-t border-cohesity-border/60 mt-1 pt-1">
            <button
              onClick={() => { persist({}); setMenuOpen(false); }}
              className="flex items-center gap-1.5 w-full px-3 py-1 text-[12px] text-ink-muted hover:text-ink hover:bg-brand/10 cursor-pointer">
              <RotateCcw size={11} /> Reset layout
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
