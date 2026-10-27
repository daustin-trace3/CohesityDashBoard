const OPTIONS = [
  { value: 'amortized', label: 'Amortized' },
  { value: 'unblended', label: 'Unblended' },
];

/** Segmented control for the cost metric. value is 'amortized' | 'unblended'. */
export default function MetricToggle({ value, onChange }) {
  return (
    <div className="flex rounded-lg border border-cohesity-border overflow-hidden" role="group" aria-label="Cost metric"
      title="Amortized spreads Savings Plan and reservation fees over the days they cover; unblended is the cash charge">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`px-2.5 py-1.5 text-xs cursor-pointer ${value === o.value ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
