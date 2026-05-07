/**
 * SkeletonTable — placeholder shown while table data loads.
 * colWidths: array of Tailwind width classes for each column (e.g. 'w-24', 'w-32').
 */
export default function SkeletonTable({ rows = 6, colWidths = ['w-24', 'w-16', 'w-20', 'w-32', 'w-16', 'w-12'] }) {
  return (
    <div className="animate-pulse" aria-hidden="true">
      {/* Header */}
      <div className="flex items-center gap-6 px-2 py-2 border-b border-cohesity-border">
        {colWidths.map((w, i) => (
          <div key={i} className={`h-2.5 bg-cohesity-border rounded ${w}`} />
        ))}
      </div>
      {/* Rows */}
      {[...Array(rows)].map((_, i) => (
        <div
          key={i}
          className={`flex items-center gap-6 px-2 py-3 border-b border-cohesity-border ${
            i % 2 === 0 ? 'bg-cohesity-black/20' : ''
          }`}
        >
          {colWidths.map((w, j) => (
            <div key={j} className={`h-3 bg-cohesity-gray rounded ${w}`} />
          ))}
        </div>
      ))}
    </div>
  );
}
