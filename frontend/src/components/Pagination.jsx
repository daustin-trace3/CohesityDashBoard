const PAGE_SIZE_OPTIONS = [25, 50, 100];

const btnCls = 'text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 disabled:cursor-default transition-colors cursor-pointer';

export default function Pagination({
  page,
  totalPages,
  pageSize,
  onPage,
  onPageSize,
  totalItems,
  compact = false,
}) {
  if (totalItems === 0) return null;

  if (compact) {
    return (
      <div className="flex items-center justify-center gap-1 pt-2">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          aria-label="Previous page"
          className="text-[11px] px-1.5 py-0.5 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer"
        >‹</button>
        <span className="text-[11px] text-ink-faint tnum">{page + 1}/{totalPages}</span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages - 1}
          aria-label="Next page"
          className="text-[11px] px-1.5 py-0.5 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer"
        >›</button>
      </div>
    );
  }

  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-cohesity-border mt-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-faint">Rows per page:</span>
        {PAGE_SIZE_OPTIONS.map(s => (
          <button
            key={s}
            onClick={() => onPageSize(s)}
            className={`text-xs px-2 py-1 rounded-md border transition-colors cursor-pointer tnum ${
              pageSize === s
                ? 'bg-brand text-cohesity-black border-brand font-semibold'
                : 'border-cohesity-border text-ink-muted hover:border-brand/50'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-faint tnum">{start}–{end} of {totalItems}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => onPage(0)} disabled={page === 0} aria-label="First page" className={btnCls}>«</button>
          <button onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page" className={btnCls}>‹</button>
          <span className="text-xs text-ink-faint px-1 tnum">{page + 1} / {totalPages}</span>
          <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1} aria-label="Next page" className={btnCls}>›</button>
          <button onClick={() => onPage(totalPages - 1)} disabled={page >= totalPages - 1} aria-label="Last page" className={btnCls}>»</button>
        </div>
      </div>
    </div>
  );
}
