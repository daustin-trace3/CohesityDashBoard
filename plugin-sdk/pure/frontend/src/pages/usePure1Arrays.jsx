// Ported from frontend/src/pages/pure/usePure1Arrays.jsx — apiFetch instead
// of axios `client`, dl-input class swapped for the pu-input equivalent.
import { apiFetch } from '../ui.jsx';

const STORAGE_KEY = 'pure1-array-id';

/**
 * Loads the Pure1 fleet array list once and manages the currently-selected
 * array. The selection is shared across the per-array pages via localStorage
 * so switching pages keeps you on the same array.
 */
export function usePure1Arrays() {
  const [arrays, setArrays] = React.useState(null);
  const [arrayId, setArrayIdState] = React.useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
  });

  const setArrayId = React.useCallback((id) => {
    setArrayIdState(id);
    if (id) { try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ } }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    apiFetch('/pure/pure1/overview')
      .then((data) => {
        if (cancelled) return;
        const list = (data || []).map((a) => ({ id: a.id, name: a.name, model: a.model }));
        setArrays(list);
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
        className="pu-input"
        style={{ minWidth: 220, width: 'auto', cursor: 'pointer' }}
      >
        {(arrays || []).map((a) => (
          <option key={a.id} value={a.id}>{a.name}{a.model ? ` · ${a.model}` : ''}</option>
        ))}
      </select>
    </div>
  );
}
