import { useEffect, useState, useCallback } from 'react';
import client from '../../api/client';

const STORAGE_KEY = 'pure1-array-id';

/**
 * Loads the Pure1 fleet array list once and manages the currently-selected
 * array. The selection is shared across the per-array pages via localStorage so
 * switching pages keeps you on the same array.
 */
export function usePure1Arrays() {
  const [arrays, setArrays] = useState(null);
  const [arrayId, setArrayIdState] = useState(() => localStorage.getItem(STORAGE_KEY) || '');

  const setArrayId = useCallback((id) => {
    setArrayIdState(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    client.get('/pure1/overview')
      .then(({ data }) => {
        if (cancelled) return;
        const list = (data || []).map((a) => ({ id: a.id, name: a.name, model: a.model }));
        setArrays(list);
        // Default to the stored array if still present, else the first one.
        setArrayIdState((cur) => (cur && list.some((a) => a.id === cur)) ? cur : (list[0] ? list[0].id : ''));
      })
      .catch(() => { if (!cancelled) setArrays([]); });
    return () => { cancelled = true; };
  }, []);

  return { arrays, arrayId, setArrayId };
}

/** Styled array dropdown used at the top of each per-array Pure page. */
export function ArraySelect({ arrays, value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Array</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!arrays || arrays.length === 0}
        className="bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg px-3 py-1.5 focus:border-brand/60 transition-colors min-w-[220px] disabled:opacity-50"
      >
        {(arrays || []).map((a) => (
          <option key={a.id} value={a.id}>{a.name}{a.model ? ` · ${a.model}` : ''}</option>
        ))}
      </select>
    </div>
  );
}
