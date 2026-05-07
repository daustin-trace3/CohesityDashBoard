/**
 * SkeletonCard — placeholder shown while cluster data loads.
 * Matches the approximate shape of ClusterCard.
 */
export default function SkeletonCard() {
  return (
    <div
      className="border border-cohesity-border rounded p-3 flex flex-col gap-2 bg-cohesity-gray animate-pulse"
      aria-hidden="true"
    >
      {/* Name row */}
      <div className="flex items-start justify-between gap-2">
        <div className="h-3 bg-cohesity-border rounded w-3/5" />
        <div className="h-3 bg-cohesity-border rounded w-6" />
      </div>
      {/* Sub-label */}
      <div className="h-2.5 bg-cohesity-border rounded w-2/5" />
      {/* Big % */}
      <div className="h-7 bg-cohesity-border rounded w-1/4 mt-1" />
      {/* Progress bar */}
      <div className="h-1.5 bg-cohesity-border rounded w-full" />
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 mt-1">
        {[...Array(4)].map((_, i) => (
          <div key={i}>
            <div className="h-2 bg-cohesity-border rounded w-2/5 mb-1" />
            <div className="h-3 bg-cohesity-border rounded w-3/5" />
          </div>
        ))}
      </div>
      {/* Footer */}
      <div className="flex items-center justify-between mt-1">
        <div className="h-2.5 bg-cohesity-border rounded w-1/4" />
        <div className="h-5 bg-cohesity-border rounded w-1/5" />
      </div>
    </div>
  );
}
