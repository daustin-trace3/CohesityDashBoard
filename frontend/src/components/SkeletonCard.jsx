/**
 * SkeletonCard — placeholder shown while cluster data loads.
 * Matches the approximate shape of ClusterCard.
 */
export default function SkeletonCard() {
  return (
    <div
      className="border border-cohesity-border rounded-xl p-3 flex flex-col gap-2 bg-surface"
      aria-hidden="true"
    >
      {/* Name row */}
      <div className="flex items-start justify-between gap-2">
        <div className="skeleton h-3 w-3/5" />
        <div className="skeleton h-3 w-6" />
      </div>
      {/* Sub-label */}
      <div className="skeleton h-2.5 w-2/5" />
      {/* Big % */}
      <div className="skeleton h-7 w-1/4 mt-1" />
      {/* Progress bar */}
      <div className="skeleton h-1.5 w-full" />
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 mt-1">
        {[...Array(4)].map((_, i) => (
          <div key={i}>
            <div className="skeleton h-2 w-2/5 mb-1" />
            <div className="skeleton h-3 w-3/5" />
          </div>
        ))}
      </div>
      {/* Footer */}
      <div className="flex items-center justify-between mt-1">
        <div className="skeleton h-2.5 w-1/4" />
        <div className="skeleton h-5 w-1/5" />
      </div>
    </div>
  );
}
