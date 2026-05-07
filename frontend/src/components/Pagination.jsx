const PAGE_SIZE_OPTIONS = [25, 50, 100];

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
          className="text-[10px] px-1.5 py-0.5 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green hover:text-cohesity-green disabled:opacity-30 transition-colors"
        >‹</button>
        <span className="text-[10px] text-gray-500">{page + 1}/{totalPages}</span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages - 1}
          aria-label="Next page"
          className="text-[10px] px-1.5 py-0.5 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green hover:text-cohesity-green disabled:opacity-30 transition-colors"
        >›</button>
      </div>
    );
  }

  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-cohesity-border mt-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Rows per page:</span>
        {PAGE_SIZE_OPTIONS.map(s => (
          <button
            key={s}
            onClick={() => onPageSize(s)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              pageSize === s
                ? 'bg-cohesity-green text-cohesity-black border-cohesity-green font-semibold'
                : 'border-cohesity-border text-gray-400 hover:border-cohesity-green'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">{start}–{end} of {totalItems}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => onPage(0)} disabled={page === 0} aria-label="First page"
            className="text-xs px-2 py-1 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green disabled:opacity-30 transition-colors">«</button>
          <button onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page"
            className="text-xs px-2 py-1 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green disabled:opacity-30 transition-colors">‹</button>
          <span className="text-xs text-gray-500 px-1">{page + 1} / {totalPages}</span>
          <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1} aria-label="Next page"
            className="text-xs px-2 py-1 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green disabled:opacity-30 transition-colors">›</button>
          <button onClick={() => onPage(totalPages - 1)} disabled={page >= totalPages - 1} aria-label="Last page"
            className="text-xs px-2 py-1 rounded border border-cohesity-border text-gray-400 hover:border-cohesity-green disabled:opacity-30 transition-colors">»</button>
        </div>
      </div>
    </div>
  );
}
