// Inline-SVG icon set for the vCenter plugin — no lucide-react import
// (plugin sandbox forbids host package imports). 24x24 viewBox, stroke-based,
// lucide-look; close-enough per the conversion contract. Shapes reused
// verbatim from plugin-sdk/dell/frontend/src/icons.jsx where the icon name
// matches; vCenter-only additions appended at the end.

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

/* ── shared with unifi (same lucide icon) ──────────────────────────────── */
export const Gauge = (p) => <Icon {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M12 3a9 9 0 0 0-9 9M12 3a9 9 0 0 1 9 9M12 12l4-3" /></Icon>;
export const ShieldCheck = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M9 12l2 2 4-4" /></Icon>;
export const ClipboardCheck = (p) => <Icon {...p}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" /><path d="M9 14l2 2 4-4" /></Icon>;
export const Settings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M4 12h3M17 12h3M12 4v3M12 17v3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" /></Icon>;
export const Zap = (p) => <Icon {...p}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></Icon>;
export const Shield = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></Icon>;
export const Clock = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Icon>;
export const Thermometer = (p) => <Icon {...p}><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0Z" /></Icon>;
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

/* ── Dell-only additions ────────────────────────────────────────────────── */
export const AlertTriangle = (p) => <Icon {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4M12 17h.01" /></Icon>;
export const Wrench = (p) => <Icon {...p}><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.7 2.7-2-2 2.7-2.7Z" /></Icon>;
export const BadgeCheck = (p) => <Icon {...p}><path d="M12 2 9.5 4.2 6.2 4l-.7 3.2L2.8 9l1.7 2.9L3.8 15l3 1.1.4 3.2 3.3-.5L12 21l1.5-2.2 3.3.5.4-3.2 3-1.1-1.7-2.9L20.2 9l-2.7-1.8L16.8 4l-3.3.2Z" /><path d="M9 12l2 2 4-4" /></Icon>;
export const Sparkles = (p) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="2.5" /></Icon>;
export const ListChecks = (p) => <Icon {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></Icon>;
export const ScrollText = (p) => <Icon {...p}><path d="M8 21h9a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v6" /><path d="M14 3v5h5" /><path d="M4 15v2a2 2 0 0 0 2 2h2" /><path d="M4 12h1" /></Icon>;
export const FileBarChart = (p) => <Icon {...p}><path d="M14 3v5h5" /><path d="M6 21h12a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /><path d="M9 17v-3M12 17v-5M15 17v-2" /></Icon>;
export const Boxes = (p) => <Icon {...p}><path d="M2.5 7 12 2l9.5 5-9.5 5-9.5-5Z" /><path d="M2.5 7v10L12 22V12" /><path d="M21.5 7v10L12 22" /></Icon>;
export const HardDrive = (p) => <Icon {...p}><path d="M2 12h20" /><rect x="2" y="12" width="20" height="8" rx="2" /><path d="M6 16h.01M10 16h4" /><path d="M6 12 4 5h16l-2 7" /></Icon>;
export const Cpu = (p) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="1" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></Icon>;
export const MemoryStick = (p) => <Icon {...p}><path d="M4 8h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z" /><path d="M8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3" /><path d="M8 12v4M12 12v4M16 12v4" /></Icon>;
export const Unplug = (p) => <Icon {...p}><path d="M9 2v4M15 2v4" /><path d="M7 9h10v3a5 5 0 0 1-10 0V9Z" /><path d="M12 16v6" /><path d="m3 3 18 18" /></Icon>;
export const Network = (p) => <Icon {...p}><rect x="9" y="2" width="6" height="4" rx="1" /><rect x="2" y="18" width="6" height="4" rx="1" /><rect x="16" y="18" width="6" height="4" rx="1" /><path d="M12 6v6M12 12H5v6M12 12h7v6" /></Icon>;
export const Plug = (p) => <Icon {...p}><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v5" /></Icon>;
export const MonitorSmartphone = (p) => <Icon {...p}><rect x="2" y="4" width="14" height="10" rx="1" /><path d="M6 18h6" /><rect x="17" y="9" width="5" height="12" rx="1" /></Icon>;
export const Download = (p) => <Icon {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" /></Icon>;
export const Layers = (p) => <Icon {...p}><path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></Icon>;
export const Database = (p) => <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></Icon>;
export const FileCog = (p) => <Icon {...p}><path d="M14 3v5h5" /><path d="M6 21h5" /><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l5 5v3.5" /><circle cx="17" cy="17" r="3" /><path d="M17 13.5v1M17 19.5v1M13.5 17h1M19.5 17h1" /></Icon>;
export const Search = (p) => <Icon {...p}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></Icon>;
export const ShieldX = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" /></Icon>;
export const FileStack = (p) => <Icon {...p}><path d="M5 2h9l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" /><path d="M3 8v12a1 1 0 0 0 1 1h11" /></Icon>;
export const FileText = (p) => <Icon {...p}><path d="M14 3v5h5" /><path d="M6 21h12a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /><path d="M8 13h8M8 17h5" /></Icon>;
export const KeyRound = (p) => <Icon {...p}><circle cx="8" cy="15" r="4" /><path d="M10.5 12.5 20 3M17 6l3 3M14 9l2 2" /></Icon>;
export const GitCompareArrows = (p) => <Icon {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6H14a4 4 0 0 1 4 4v6.5" /><path d="M15.5 18H10a4 4 0 0 1-4-4V7.5" /><path d="m11 3-3 3 3 3M13 21l3-3-3-3" /></Icon>;
export const Timer = (p) => <Icon {...p}><path d="M10 2h4" /><path d="M12 14v-4" /><circle cx="12" cy="14" r="8" /><path d="m19 8-1.5-1.5" /></Icon>;
export const UserCog = (p) => <Icon {...p}><circle cx="9" cy="7" r="4" /><path d="M2 21v-2a5 5 0 0 1 5-5h1" /><circle cx="18" cy="17" r="3" /><path d="M18 13v1M18 20v1M14.5 17h1M20.5 17h1M15.6 14.6l.7.7M19.7 18.7l.7.7M15.6 19.4l.7-.7M19.7 15.3l.7-.7" /></Icon>;
export const TrendingUp = (p) => <Icon {...p}><path d="M22 7 13.5 15.5 8.5 10.5 2 17" /><path d="M16 7h6v6" /></Icon>;
export const EyeOff = (p) => <Icon {...p}><path d="M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 10 8 10 8a17.6 17.6 0 0 1-2.16 3.19M6.6 6.6C3.8 8.4 2 12 2 12s3 8 10 8a10 10 0 0 0 5-1.3" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><path d="M1 1l22 22" /></Icon>;
export const FileDown = (p) => <Icon {...p}><path d="M14 3v5h5" /><path d="M6 21h12a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /><path d="M12 11v6M9.5 15l2.5 2 2.5-2" /></Icon>;
export const CalendarClock = (p) => <Icon {...p}><path d="M8 2v4M16 2v4" /><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 10h18" /><circle cx="15" cy="16" r="3.5" /><path d="M15 14.5v1.5l1 1" /></Icon>;
export const Recycle = (p) => <Icon {...p}><path d="M7 19H4.5a2 2 0 0 1-1.7-3l3-5" /><path d="M9.5 2.5 6 8.5l3 2" /><path d="M17.5 12.5 21 18.5l-6.5.5" /><path d="M13 19.5h5.5a2 2 0 0 0 1.7-3l-1.2-2" /><path d="M13 2.5H8.5l-1 6" /></Icon>;
export const BellRing = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M4 4l-1 2M20 4l1 2" /></Icon>;

/* ── vCenter-only additions ─────────────────────────────────────────────── */
export const Bell = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></Icon>;
export const Play = (p) => <Icon {...p}><path d="M6 3v18l15-9L6 3Z" /></Icon>;
export const Power = (p) => <Icon {...p}><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></Icon>;
export const ChevronDown = (p) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const ChevronUp = (p) => <Icon {...p}><path d="m18 15-6-6-6 6" /></Icon>;
export const Share2 = (p) => <Icon {...p}><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 10.5 15.4 6.5M8.6 13.5 15.4 17.5" /></Icon>;
export const EthernetPort = (p) => <Icon {...p}><rect x="2" y="9" width="20" height="12" rx="1" /><path d="M8 21v-4M12 21v-4M16 21v-4" /><path d="M6 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4" /></Icon>;
export const Waypoints = (p) => <Icon {...p}><circle cx="4.5" cy="19.5" r="2.5" /><circle cx="19.5" cy="4.5" r="2.5" /><path d="M7 17 17 7" /><path d="M17 17h.5a2.5 2.5 0 0 0 0-5H15" /><path d="M7 7H6.5a2.5 2.5 0 0 0 0 5H9" /></Icon>;
export const Tag = (p) => <Icon {...p}><path d="M12.6 2H5a1 1 0 0 0-1 1v7.6a1 1 0 0 0 .3.7l9.4 9.4a1 1 0 0 0 1.4 0l7.6-7.6a1 1 0 0 0 0-1.4l-9.4-9.4a1 1 0 0 0-.7-.3Z" /><circle cx="8" cy="8" r="1.5" /></Icon>;
export const Building2 = (p) => <Icon {...p}><path d="M3 21v-4.5M3 16.5V3.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v13M3 16.5h18" /><path d="M7 21v-3M12 21v-3M17 21v-3M7 7h4M7 11h4M17 7h.01M17 11h.01" /></Icon>;
export const ArrowLeftRight = (p) => <Icon {...p}><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></Icon>;
