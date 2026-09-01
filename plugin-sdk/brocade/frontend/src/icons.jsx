// Inline-SVG icon set for the Brocade SAN plugin — no lucide-react import
// (plugin sandbox forbids host package imports). 24x24 viewBox, stroke-based,
// lucide-look; close-enough per the conversion contract. Shapes reused
// verbatim from plugin-sdk/dell/frontend/src/icons.jsx where the icon name
// matches; the rest are new, approximating the lucide-react glyph used by
// the built-in frontend/src/platforms/brocade/index.jsx nav and
// frontend/src/pages/brocade/*.jsx pages.

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

/* ── shared with dell (same lucide icon) ───────────────────────────────── */
export const Gauge = (p) => <Icon {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M12 3a9 9 0 0 0-9 9M12 3a9 9 0 0 1 9 9M12 12l4-3" /></Icon>;
export const ShieldCheck = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M9 12l2 2 4-4" /></Icon>;
export const ClipboardCheck = (p) => <Icon {...p}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" /><path d="M9 14l2 2 4-4" /></Icon>;
export const Settings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M4 12h3M17 12h3M12 4v3M12 17v3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" /></Icon>;
export const Clock = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Icon>;
export const X = (p) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;
export const Pencil = (p) => <Icon {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
export const Trash2 = (p) => <Icon {...p}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></Icon>;
export const RefreshCw = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></Icon>;
export const CheckCircle2 = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M9 12l2 2 4-4" /></Icon>;
export const XCircle = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" /></Icon>;
export const History = (p) => <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6" /><path d="M12 7v5l4 2" /></Icon>;
export const Activity = (p) => <Icon {...p}><path d="M22 12h-4l-3 9-6-18-3 9H2" /></Icon>;
export const Server = (p) => <Icon {...p}><rect x="2" y="3" width="20" height="7" rx="1.5" /><rect x="2" y="14" width="20" height="7" rx="1.5" /><path d="M6 6.5h.01M6 17.5h.01" /></Icon>;
export const ShieldAlert = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M12 8v4M12 15h.01" /></Icon>;
export const Cable = (p) => <Icon {...p}><path d="M4 9v6a4 4 0 0 0 4 4h1" /><path d="M20 9v6a4 4 0 0 1-4 4h-1" /><rect x="2" y="5" width="4" height="4" rx="1" /><rect x="18" y="5" width="4" height="4" rx="1" /><path d="M9 19v2M15 19v2" /></Icon>;
export const AlertTriangle = (p) => <Icon {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4M12 17h.01" /></Icon>;
export const HardDrive = (p) => <Icon {...p}><path d="M2 12h20" /><rect x="2" y="12" width="20" height="8" rx="2" /><path d="M6 16h.01M10 16h4" /><path d="M6 12 4 5h16l-2 7" /></Icon>;
export const Network = (p) => <Icon {...p}><rect x="9" y="2" width="6" height="4" rx="1" /><rect x="2" y="18" width="6" height="4" rx="1" /><rect x="16" y="18" width="6" height="4" rx="1" /><path d="M12 6v6M12 12H5v6M12 12h7v6" /></Icon>;
export const Search = (p) => <Icon {...p}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></Icon>;
export const KeyRound = (p) => <Icon {...p}><circle cx="8" cy="15" r="4" /><path d="M10.5 12.5 20 3M17 6l3 3M14 9l2 2" /></Icon>;
export const CalendarClock = (p) => <Icon {...p}><path d="M8 2v4M16 2v4" /><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 10h18" /><circle cx="15" cy="16" r="3.5" /><path d="M15 14.5v1.5l1 1" /></Icon>;
export const BellRing = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M4 4l-1 2M20 4l1 2" /></Icon>;

/* ── Brocade-only additions ─────────────────────────────────────────────── */
export const Waypoints = (p) => <Icon {...p}><circle cx="4.5" cy="19.5" r="2.5" /><circle cx="19.5" cy="4.5" r="2.5" /><path d="M7 17 17 7" /><path d="M11.25 6.5H16a1 1 0 0 1 1 1v4.75" /></Icon>;
export const Router = (p) => <Icon {...p}><rect x="2" y="12" width="20" height="7" rx="1.5" /><path d="M6.5 12V8a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4" /><path d="M6 16h.01M10 16h.01" /><path d="M12 6V3" /></Icon>;
export const LineChart = (p) => <Icon {...p}><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-4 4" /></Icon>;
export const Grid3x3 = (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></Icon>;
export const HeartPulse = (p) => <Icon {...p}><path d="M19 14c1.5-1.5 3-3.4 3-5.5A4.5 4.5 0 0 0 13.5 6L12 7.5 10.5 6A4.5 4.5 0 0 0 2 8.5C2 13 8 18 12 21c1.2-.9 2.5-2 3.7-3.2" /><path d="M3.5 11h4l1.5-3 2 5 1.5-2.5H16" /></Icon>;
export const LayoutGrid = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>;
export const GitCompare = (p) => <Icon {...p}><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M6 9v6a2 2 0 0 0 2 2h8" /><path d="M18 15V9a2 2 0 0 0-2-2H8" /></Icon>;
export const Plus = (p) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const ListTree = (p) => <Icon {...p}><path d="M4 3v18" /><path d="M4 8h3a1 1 0 0 0 1-1V5" /><path d="M4 16h3a1 1 0 0 1 1 1v2" /><path d="M11 6h9" /><path d="M11 18h9" /></Icon>;
export const Undo2 = (p) => <Icon {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Icon>;
export const GitCommitVertical = (p) => <Icon {...p}><path d="M12 3v6M12 15v6" /><circle cx="12" cy="12" r="3" /></Icon>;
export const Lock = (p) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>;
export const Users = (p) => <Icon {...p}><circle cx="9" cy="8" r="4" /><path d="M2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" /><path d="M17 4.5a4 4 0 0 1 0 7.7" /><path d="M22 21v-2a5 5 0 0 0-3.5-4.8" /></Icon>;
export const Radio = (p) => <Icon {...p}><circle cx="12" cy="12" r="2" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5 5a9 9 0 0 0 0 14M19 5a9 9 0 0 1 0 14" /></Icon>;
