const SEVERITY_MAP = {
  critical: 'bg-red-900 text-red-300 border-red-700',
  warning: 'bg-amber-900 text-amber-300 border-amber-700',
  info: 'bg-blue-900 text-blue-300 border-blue-700'
};

export default function AlertBadge({ severity }) {
  const s = (severity || 'info').toLowerCase();
  const cls = SEVERITY_MAP[s] || SEVERITY_MAP.info;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}
