import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Search, X, Loader2, Crosshair } from 'lucide-react';
import client from '../api/client';
import { useSearch } from '../context';

const PLATFORM_COLORS = {
  cohesity: '#6CB33F', pure: '#FF6B00', netapp: '#0067C5', zerto: '#EE3124',
  vcenter: '#0091DA', dell: '#007DB8', aria: '#00A2C7', ariaops: '#78BE20',
};

/**
 * Header search: estate-wide entity typeahead (grouped results, deep links)
 * layered on the existing SearchContext so the Cohesity dashboard's live
 * cluster-card filter keeps working as you type. The menu portals to <body>
 * (header ancestors hold retained transforms — same trap as ColumnPicker).
 */
export default function GlobalSearch() {
  const { search, setSearch } = useSearch();
  const navigate = useNavigate();
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);
  const menuRef = useRef(null);
  const seqRef = useRef(0);

  const place = () => {
    if (!boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    const width = Math.max(r.width, 380);
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width });
  };

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults([]); setOpen(false); setLoading(false); return undefined; }
    setLoading(true);
    const id = ++seqRef.current;
    const t = setTimeout(() => {
      client.get('/search', { params: { q } })
        .then(({ data }) => {
          if (seqRef.current !== id) return;
          setResults(data.results || []);
          place();
          setOpen(true);
        })
        .catch(() => { if (seqRef.current === id) setResults([]); })
        .finally(() => { if (seqRef.current === id) setLoading(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (boxRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => {
      if (e && menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      place();
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const go = (item) => {
    setOpen(false);
    setSearch('');
    navigate(item.route);
  };

  const totalHits = results.reduce((n, g) => n + g.items.length, 0);
  const server360Route = () => `/ops/server360?name=${encodeURIComponent(search.trim())}`;

  return (
    <div className="relative ml-auto w-48 lg:w-64 xl:w-72 flex-shrink-0" ref={boxRef}>
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
      <input
        type="search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        onFocus={() => { if (results.length) { place(); setOpen(true); } }}
        onKeyDown={(e) => { if (e.key === 'Enter' && search.trim().length >= 2) go({ route: server360Route() }); }}
        placeholder="Search estate…"
        aria-label="Search the estate"
        className="w-full bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg pl-9 pr-8 py-1.5 placeholder-ink-faint focus:border-brand/60 transition-colors"
      />
      {loading ? (
        <Loader2 size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint animate-spin" />
      ) : search && (
        <button
          onClick={() => { setSearch(''); setOpen(false); }}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink cursor-pointer"
        >
          <X size={13} />
        </button>
      )}

      {open && pos && createPortal(
        <div ref={menuRef} style={{ top: pos.top, left: pos.left, width: pos.width }}
          className="fixed z-50 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl max-h-[70vh] overflow-y-auto">
          {/* Pinned action: open the correlated Server 360 view for the query */}
          <button
            onClick={() => go({ route: server360Route() })}
            className="w-full text-left px-3 py-2 border-b border-cohesity-border/60 bg-brand/5 hover:bg-brand/15 transition-colors cursor-pointer flex items-center gap-2">
            <Crosshair size={13} className="text-brand flex-shrink-0" />
            <span className="text-[13px] text-ink flex-1">Server 360: everything about “{search.trim()}”</span>
            <kbd className="text-[10px] text-ink-faint border border-cohesity-border rounded px-1">Enter</kbd>
          </button>
          {totalHits === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-muted">No entity matches across the estate.</p>
          ) : results.map((group) => (
            <div key={group.key} className="py-1.5 border-b border-cohesity-border/50 last:border-0">
              <p className="px-3 pb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint font-semibold">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: PLATFORM_COLORS[group.platform] || '#8FA3B0' }} />
                {group.label}
              </p>
              {group.items.map((item, i) => (
                <button key={`${group.key}-${i}`} onClick={() => go(item)}
                  className="w-full text-left px-3 py-1.5 hover:bg-brand/10 transition-colors cursor-pointer flex items-baseline justify-between gap-2">
                  <span className="text-[13px] text-ink truncate">{item.title}</span>
                  {item.subtitle && <span className="text-[11px] text-ink-faint truncate max-w-[45%]">{item.subtitle}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
