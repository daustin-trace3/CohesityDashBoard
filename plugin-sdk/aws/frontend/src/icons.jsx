// Inline-SVG icon set for the AWS plugin — no lucide-react import (plugin
// sandbox forbids host package imports). 24x24 viewBox, stroke-based,
// lucide-look; close-enough per the conversion contract. Shapes reused
// verbatim from plugin-sdk/dell/frontend/src/icons.jsx where the icon name
// matches; the rest are new, approximating the lucide-react glyph used by
// frontend/src/platforms/aws/index.jsx and frontend/src/pages/aws/*.

function Icon({ children, size = 16, className = '', ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ── shared with dell (same lucide icon) ──────────────────────────────── */
export const Gauge = (p) => <Icon {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M12 3a9 9 0 0 0-9 9M12 3a9 9 0 0 1 9 9M12 12l4-3" /></Icon>;
export const Settings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M4 12h3M17 12h3M12 4v3M12 17v3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" /></Icon>;
export const Zap = (p) => <Icon {...p}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></Icon>;
export const X = (p) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;
export const Pencil = (p) => <Icon {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
export const Trash2 = (p) => <Icon {...p}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></Icon>;
export const RefreshCw = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></Icon>;
export const CheckCircle2 = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M9 12l2 2 4-4" /></Icon>;
export const XCircle = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" /></Icon>;
export const Activity = (p) => <Icon {...p}><path d="M22 12h-4l-3 9-6-18-3 9H2" /></Icon>;
export const Server = (p) => <Icon {...p}><rect x="2" y="3" width="20" height="7" rx="1.5" /><rect x="2" y="14" width="20" height="7" rx="1.5" /><path d="M6 6.5h.01M6 17.5h.01" /></Icon>;
export const ShieldAlert = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M12 8v4M12 15h.01" /></Icon>;
export const Sparkles = (p) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="2.5" /></Icon>;
export const HardDrive = (p) => <Icon {...p}><path d="M2 12h20" /><rect x="2" y="12" width="20" height="8" rx="2" /><path d="M6 16h.01M10 16h4" /><path d="M6 12 4 5h16l-2 7" /></Icon>;
export const Search = (p) => <Icon {...p}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></Icon>;
export const FileText = (p) => <Icon {...p}><path d="M14 3v5h5" /><path d="M6 21h12a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /><path d="M8 13h8M8 17h5" /></Icon>;
export const Clock = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Icon>;
export const BellRing = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M4 4l-1 2M20 4l1 2" /></Icon>;
export const BadgeCheck = (p) => <Icon {...p}><path d="M12 2 9.5 4.2 6.2 4l-.7 3.2L2.8 9l1.7 2.9L3.8 15l3 1.1.4 3.2 3.3-.5L12 21l1.5-2.2 3.3.5.4-3.2 3-1.1-1.7-2.9L20.2 9l-2.7-1.8L16.8 4l-3.3.2Z" /><path d="M9 12l2 2 4-4" /></Icon>;
export const Wrench = (p) => <Icon {...p}><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.7 2.7-2-2 2.7-2.7Z" /></Icon>;
export const ListChecks = (p) => <Icon {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></Icon>;
export const Database = (p) => <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></Icon>;

/* ── AWS-only additions ──────────────────────────────────────────────── */
export const DollarSign = (p) => <Icon {...p}><path d="M12 1v22" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></Icon>;
export const Bell = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></Icon>;
export const Boxes = (p) => <Icon {...p}><path d="M2.5 7 12 2l9.5 5-9.5 5-9.5-5Z" /><path d="M2.5 7v10L12 22V12" /><path d="M21.5 7v10L12 22" /></Icon>;
export const Container = (p) => <Icon {...p}><rect x="2" y="7" width="20" height="14" rx="1" /><path d="M6 7V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3" /><path d="M2 12h20" /></Icon>;
export const Package = (p) => <Icon {...p}><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" /><path d="M3 8l9 5 9-5M12 13v8" /></Icon>;
export const Table2 = (p) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 10h18M3 16h18M9 4v16" /></Icon>;
export const Network = (p) => <Icon {...p}><rect x="9" y="2" width="6" height="4" rx="1" /><rect x="2" y="18" width="6" height="4" rx="1" /><rect x="16" y="18" width="6" height="4" rx="1" /><path d="M12 6v6M12 12H5v6M12 12h7v6" /></Icon>;
export const BrainCircuit = (p) => <Icon {...p}><path d="M12 2a3 3 0 0 0-3 3v1a3 3 0 0 0-3 3 3 3 0 0 0 1 2.2V13a3 3 0 0 0 3 3v1a3 3 0 1 0 6 0v-1a3 3 0 0 0 3-3v-1.8A3 3 0 0 0 20 9a3 3 0 0 0-3-3V5a3 3 0 0 0-3-3Z" /><path d="M9 9h.01M15 9h.01M9 15h.01M15 15h.01M12 6v3M12 15v3" /></Icon>;
export const LineChartIcon = (p) => <Icon {...p}><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-4 4" /></Icon>;
export const PiggyBank = (p) => <Icon {...p}><path d="M11 5a5 5 0 0 1 5 5v0a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2v2a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-2a5 5 0 0 1-1-3 5 5 0 0 1 5-5Z" /><path d="M2 9h3M13 5V3M18 8l1.5-1.5" /><circle cx="13" cy="11" r=".5" fill="currentColor" /></Icon>;
export const TrendingUp = (p) => <Icon {...p}><path d="M22 7 13.5 15.5 8.5 10.5 2 17" /><path d="M16 7h6v6" /></Icon>;
