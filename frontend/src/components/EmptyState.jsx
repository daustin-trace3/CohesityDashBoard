/**
 * EmptyState — used wherever a data view has no results.
 *
 * Props:
 *   icon     — SVG element or emoji character
 *   title    — short heading (required)
 *   message  — supporting text (optional)
 *   action   — { label: string, onClick: fn } (optional)
 */
export default function EmptyState({ icon, title, message, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center" role="status">
      {icon && (
        <div className="mb-4 text-gray-600 opacity-60" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-cohesity-text mb-1">{title}</h3>
      {message && (
        <p className="text-xs text-gray-500 max-w-xs leading-relaxed mb-5">{message}</p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="text-xs px-4 py-2 bg-cohesity-green text-cohesity-black rounded font-semibold hover:bg-cohesity-green-dark transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/* ── Pre-built icons ──────────────────────────────────────────────────────── */

export function ClusterEmptyIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="14" width="36" height="8" rx="2" />
      <rect x="6" y="26" width="36" height="8" rx="2" />
      <circle cx="12" cy="18" r="1.5" fill="currentColor" />
      <circle cx="12" cy="30" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function AlertEmptyIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M24 8L40 36H8L24 8Z" strokeLinejoin="round" />
      <path d="M24 20v8M24 32v2" strokeLinecap="round" />
    </svg>
  );
}

export function ChartEmptyIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="6" width="36" height="36" rx="2" />
      <path d="M12 32l8-10 7 6 9-14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
