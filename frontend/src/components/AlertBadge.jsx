const SEVERITY_MAP = {
  critical: 'bg-status-crit/10 text-status-crit border-status-crit/30',
  warning: 'bg-status-warn/10 text-status-warn border-status-warn/30',
  info: 'bg-status-info/10 text-status-info border-status-info/30'
};

export default function AlertBadge({ severity }) {
  const s = (severity || 'info').toLowerCase();
  const cls = SEVERITY_MAP[s] || SEVERITY_MAP.info;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${cls}`}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}
