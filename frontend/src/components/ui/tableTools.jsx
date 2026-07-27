import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronUp, ChevronDown, Download, SlidersHorizontal } from 'lucide-react';

// Client-side search + dropdown filters + column sort for a table.
// `searchKeys` are the row fields matched by the search box; `sortValues` maps a
// column key to a getter when the raw field isn't directly comparable (e.g. ISO durations).
// Pass `paginate: true` to slice the result into pages — render `ctl.pageRows`
// instead of `ctl.rows` and drop a <TablePager ctl={ctl} /> under the table.
export function useTableControls(rows, { searchKeys = [], defaultSortKey = null, defaultSortDir = 'asc', sortValues = {}, paginate = false, defaultPageSize = 25 } = {}) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({});
  const [sortKey, setSortKey] = useState(defaultSortKey);
  const [sortDir, setSortDir] = useState(defaultSortDir);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize); // number | 'all'

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

  // Back to page 1 whenever the visible set changes shape.
  useEffect(() => { setPage(0); }, [q, filters, sortKey, sortDir, pageSize]);

  const pageCount = paginate && pageSize !== 'all' ? Math.max(1, Math.ceil(out.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => (!paginate || pageSize === 'all') ? out : out.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [out, paginate, pageSize, safePage]
  );

  return {
    rows: out, q, setQ, filters, setFilter, sortKey, sortDir, toggleSort,
    paginate, pageRows, page: safePage, setPage, pageSize, setPageSize, pageCount,
  };
}

// Clickable column header. Use inside the existing <tr> in place of a plain <th>.
export function SortTh({ k, label, ctl, align = 'left', className = '' }) {
  const active = ctl.sortKey === k;
  return (
    <th className={`py-2 pr-3 ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'} ${className}`}>
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

const PAGE_SIZES = [25, 50, 100, 'all'];
const pagerBtn = 'text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 disabled:cursor-default transition-colors cursor-pointer';

// Footer bar for a paginated table: page-size dropdown + range + prev/next.
// Hidden while the filtered set fits in the smallest page size. Pass `sizes`
// to offer different steps (e.g. [10, 25, 50, 'all'] for nested tables).
export function TablePager({ ctl, sizes = PAGE_SIZES }) {
  const total = ctl.rows.length;
  if (!ctl.paginate || total <= sizes[0]) return null;
  const all = ctl.pageSize === 'all';
  const start = all ? 1 : ctl.page * ctl.pageSize + 1;
  const end = all ? total : Math.min((ctl.page + 1) * ctl.pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 mt-1 border-t border-cohesity-border">
      <label className="flex items-center gap-2 text-xs text-ink-faint">
        Rows per page
        <select value={String(ctl.pageSize)}
          onChange={(e) => ctl.setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer">
          {sizes.map((s) => <option key={s} value={String(s)}>{s === 'all' ? 'All' : s}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-faint tnum">{start}–{end} of {total}</span>
        {!all && ctl.pageCount > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={() => ctl.setPage(0)} disabled={ctl.page === 0} aria-label="First page" className={pagerBtn}>«</button>
            <button onClick={() => ctl.setPage(ctl.page - 1)} disabled={ctl.page === 0} aria-label="Previous page" className={pagerBtn}>‹</button>
            <span className="text-xs text-ink-faint px-1 tnum">{ctl.page + 1} / {ctl.pageCount}</span>
            <button onClick={() => ctl.setPage(ctl.page + 1)} disabled={ctl.page >= ctl.pageCount - 1} aria-label="Next page" className={pagerBtn}>›</button>
            <button onClick={() => ctl.setPage(ctl.pageCount - 1)} disabled={ctl.page >= ctl.pageCount - 1} aria-label="Last page" className={pagerBtn}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Per-table CSV download of the FULL dataset (ignores search/filter/paging).
// `columns` = [{ label, get }] where `get` is a field name or (row) => value.
export function CsvExportButton({ filename, columns, rows }) {
  const esc = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const onClick = () => {
    const lines = [columns.map((c) => esc(c.label)).join(',')];
    for (const r of rows || []) {
      lines.push(columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.get])).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <button onClick={onClick} disabled={!rows?.length}
      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
      <Download size={12} /> Export
    </button>
  );
}

// Column show/hide preference, persisted per table in localStorage.
export function useVisibleColumns(storageKey, defaultHidden = []) {
  const [hidden, setHidden] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return new Set(Array.isArray(saved) ? saved : defaultHidden);
    } catch { return new Set(defaultHidden); }
  });
  const toggle = (k) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(k)) next.delete(k); else next.add(k);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });
  return { hidden, toggle, show: (k) => !hidden.has(k) };
}

// Dropdown of checkboxes toggling column visibility. `columns` = [{ k, label, always? }].
export function ColumnPicker({ columns, prefs }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    // z-50 on the anchor: the dropdown must paint over sticky table headers
    // (position:sticky rows otherwise win against later-DOM siblings).
    <div className="relative z-50" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
        <SlidersHorizontal size={12} /> Columns
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl p-2 w-60 max-h-80 overflow-y-auto">
          {columns.map((c) => (
            <label key={c.k}
              className={`flex items-center gap-2 px-2 py-1 text-xs rounded cursor-pointer ${c.always ? 'text-ink-faint cursor-default' : 'text-ink hover:bg-brand/5'}`}>
              <input type="checkbox" checked={c.always || prefs.show(c.k)} disabled={c.always}
                onChange={() => prefs.toggle(c.k)} className="accent-current" />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
