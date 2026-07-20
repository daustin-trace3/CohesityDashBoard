import { useMemo, useState } from 'react';
import { Search, ChevronUp, ChevronDown } from 'lucide-react';

// Client-side search + dropdown filters + column sort for a table.
// `searchKeys` are the row fields matched by the search box; `sortValues` maps a
// column key to a getter when the raw field isn't directly comparable (e.g. ISO durations).
export function useTableControls(rows, { searchKeys = [], defaultSortKey = null, defaultSortDir = 'asc', sortValues = {} } = {}) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({});
  const [sortKey, setSortKey] = useState(defaultSortKey);
  const [sortDir, setSortDir] = useState(defaultSortDir);

  const out = useMemo(() => {
    let list = rows || [];
    for (const [k, v] of Object.entries(filters)) {
      if (v !== '' && v != null) list = list.filter((r) => String(r[k] ?? '') === v);
    }
    const term = q.trim().toLowerCase();
    if (term && searchKeys.length) {
      list = list.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(term)));
    }
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      const get = sortValues[sortKey] || ((r) => r[sortKey]);
      list = [...list].sort((a, b) => {
        const av = get(a), bv = get(b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });
    }
    return list;
  }, [rows, q, filters, sortKey, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  return { rows: out, q, setQ, filters, setFilter, sortKey, sortDir, toggleSort };
}

// Clickable column header. Use inside the existing <tr> in place of a plain <th>.
export function SortTh({ k, label, ctl, align = 'left', className = '' }) {
  const active = ctl.sortKey === k;
  return (
    <th className={`py-2 pr-3 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <button onClick={() => ctl.toggleSort(k)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide cursor-pointer transition-colors hover:text-ink ${active ? 'text-ink' : ''}`}>
        {label}{active && (ctl.sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </button>
    </th>
  );
}

export function TableSearch({ ctl, placeholder = 'Search…', className = '' }) {
  return (
    <div className={`relative ${className || 'w-full max-w-xs'}`}>
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
      <input value={ctl.q} onChange={(e) => ctl.setQ(e.target.value)} placeholder={placeholder}
        className="w-full bg-surface-overlay border border-cohesity-border rounded-lg pl-9 pr-3 py-1.5 text-sm text-ink focus:border-brand/60 outline-none" />
    </div>
  );
}

// Dropdown filter over the distinct values of one row field.
export function FilterSelect({ ctl, k, rows, label }) {
  const options = useMemo(
    () => [...new Set((rows || []).map((r) => r[k]).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [rows, k]
  );
  if (options.length < 2) return null;
  return (
    <select value={ctl.filters[k] || ''} onChange={(e) => ctl.setFilter(k, e.target.value)}
      className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
      <option value="">All {label}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// One-line toolbar: search box + dropdown filters + filtered-row count.
export function TableControls({ ctl, rows, searchPlaceholder, filters = [] }) {
  const total = (rows || []).length;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <TableSearch ctl={ctl} placeholder={searchPlaceholder} />
      {filters.map((f) => <FilterSelect key={f.k} ctl={ctl} k={f.k} rows={rows} label={f.label} />)}
      <span className="text-[11px] text-ink-faint tnum ml-auto">
        {ctl.rows.length === total ? `${total} rows` : `${ctl.rows.length} of ${total} rows`}
      </span>
    </div>
  );
}
