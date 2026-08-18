// Inline-SVG icon set for the Cohesity plugin — no lucide-react import (the
// plugin sandbox forbids host package imports). 24x24 viewBox, stroke-based,
// lucide-look; close-enough per the conversion contract. Shapes reused
// verbatim from plugin-sdk/dell/frontend/src/icons.jsx where the icon name
// matches; the rest are new, approximating the lucide-react glyph.

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

/* ── shared with dell/unifi (same lucide icon) ─────────────────────────── */
export const Gauge = (p) => <Icon {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M12 3a9 9 0 0 0-9 9M12 3a9 9 0 0 1 9 9M12 12l4-3" /></Icon>;
export const ShieldCheck = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M9 12l2 2 4-4" /></Icon>;
export const ClipboardCheck = (p) => <Icon {...p}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" /><path d="M9 14l2 2 4-4" /></Icon>;
export const Settings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M4 12h3M17 12h3M12 4v3M12 17v3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" /></Icon>;
export const Server = (p) => <Icon {...p}><rect x="2" y="3" width="20" height="7" rx="1.5" /><rect x="2" y="14" width="20" height="7" rx="1.5" /><path d="M6 6.5h.01M6 17.5h.01" /></Icon>;
export const ShieldAlert = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M12 8v4M12 15h.01" /></Icon>;
export const AlertTriangle = (p) => <Icon {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4M12 17h.01" /></Icon>;
export const BadgeCheck = (p) => <Icon {...p}><path d="M12 2 9.5 4.2 6.2 4l-.7 3.2L2.8 9l1.7 2.9L3.8 15l3 1.1.4 3.2 3.3-.5L12 21l1.5-2.2 3.3.5.4-3.2 3-1.1-1.7-2.9L20.2 9l-2.7-1.8L16.8 4l-3.3.2Z" /><path d="M9 12l2 2 4-4" /></Icon>;
export const Sparkles = (p) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="2.5" /></Icon>;
export const HardDrive = (p) => <Icon {...p}><path d="M2 12h20" /><rect x="2" y="12" width="20" height="8" rx="2" /><path d="M6 16h.01M10 16h4" /><path d="M6 12 4 5h16l-2 7" /></Icon>;
export const Pencil = (p) => <Icon {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
export const Trash2 = (p) => <Icon {...p}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></Icon>;
export const RefreshCw = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></Icon>;
export const CheckCircle2 = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M9 12l2 2 4-4" /></Icon>;
export const History = (p) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /><path d="M12 7v5l4 2" /></Icon>;
export const X = (p) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;

/* ── Cohesity-only additions ────────────────────────────────────────────── */
export const Database = (p) => <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></Icon>;
export const Bell = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></Icon>;
export const Download = (p) => <Icon {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" /></Icon>;
export const RotateCcw = (p) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /></Icon>;
export const Globe = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></Icon>;
export const TrendingUp = (p) => <Icon {...p}><path d="M22 7 13.5 15.5 8.5 10.5 2 17" /><path d="M16 7h6v6" /></Icon>;
export const ListFilter = (p) => <Icon {...p}><path d="M3 6h18M6 12h12M10 18h4" /></Icon>;
export const LayoutGrid = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>;
export const ChevronUp = (p) => <Icon {...p}><path d="m18 15-6-6-6 6" /></Icon>;
export const ChevronDown = (p) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const ChevronRight = (p) => <Icon {...p}><path d="m9 18 6-6-6-6" /></Icon>;
export const Upload = (p) => <Icon {...p}><path d="M12 21V9" /><path d="m7 14 5-5 5 5" /><path d="M4 5h16" /></Icon>;
export const Save = (p) => <Icon {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></Icon>;
export const Flag = (p) => <Icon {...p}><path d="M4 3v18" /><path d="M4 4h13l-2.5 4L17 12H4" /></Icon>;
export const ListTree = (p) => <Icon {...p}><path d="M4 4h4M4 4v6h4M4 10v6h4M12 7h8M12 17h8M4 20h4" /></Icon>;
export const Columns3 = (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M15 3v18" /></Icon>;
export const Lock = (p) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>;
export const Cloud = (p) => <Icon {...p}><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.3-1.8A4.5 4.5 0 0 0 6.5 19h11Z" /></Icon>;
export const Plus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const PlugZap = (p) => <Icon {...p}><path d="M9 2v4M15 2v4" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v2" /><path d="m9 21 3-4 3 4" /></Icon>;
export const Lightbulb = (p) => <Icon {...p}><path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.1 1 1.8V17h6v-.5c0-.7.4-1.4 1-1.8A7 7 0 0 0 12 2Z" /></Icon>;
export const AlertOctagon = (p) => <Icon {...p}><path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86Z" /><path d="M12 8v4M12 16h.01" /></Icon>;
export const Info = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></Icon>;
export const WifiOff = (p) => <Icon {...p}><path d="M1 1l22 22" /><path d="M16.7 8.2a10 10 0 0 1 3.3 2.1M5.9 10.4A10 10 0 0 1 9 8.6M8.5 13.5a5 5 0 0 1 5.5.4M12 20h.01" /></Icon>;
export const ArrowLeftRight = (p) => <Icon {...p}><path d="m17 3 4 4-4 4" /><path d="M3 7h18" /><path d="m7 21-4-4 4-4" /><path d="M21 17H3" /></Icon>;
export const RadioTower = (p) => <Icon {...p}><path d="M4.9 16.1a8 8 0 0 1 0-8.2M19.1 7.9a8 8 0 0 1 0 8.2M8 12a4 4 0 0 1 8 0" /><circle cx="12" cy="12" r="1.5" /><path d="M12 13.5V22M9 22h6" /></Icon>;
export const Loader2 = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-6.2-8.6" /></Icon>;
