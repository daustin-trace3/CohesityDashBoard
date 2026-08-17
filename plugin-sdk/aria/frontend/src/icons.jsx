// Inline-SVG icon set for the Aria plugin — no lucide-react import (plugin
// sandbox forbids host package imports). 24x24 viewBox, stroke-based,
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
export const Clock = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Icon>;
export const X = (p) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;
export const Pencil = (p) => <Icon {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
export const Trash2 = (p) => <Icon {...p}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></Icon>;
export const RefreshCw = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></Icon>;
export const CheckCircle2 = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M9 12l2 2 4-4" /></Icon>;
export const XCircle = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" /></Icon>;
export const Activity = (p) => <Icon {...p}><path d="M22 12h-4l-3 9-6-18-3 9H2" /></Icon>;
export const Server = (p) => <Icon {...p}><rect x="2" y="3" width="20" height="7" rx="1.5" /><rect x="2" y="14" width="20" height="7" rx="1.5" /><path d="M6 6.5h.01M6 17.5h.01" /></Icon>;
export const ShieldAlert = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M12 8v4M12 15h.01" /></Icon>;
export const Cable = (p) => <Icon {...p}><path d="M4 9v6a4 4 0 0 0 4 4h1" /><path d="M20 9v6a4 4 0 0 1-4 4h-1" /><rect x="2" y="5" width="4" height="4" rx="1" /><rect x="18" y="5" width="4" height="4" rx="1" /><path d="M9 19v2M15 19v2" /></Icon>;
export const AlertTriangle = (p) => <Icon {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4M12 17h.01" /></Icon>;
export const Sparkles = (p) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="2.5" /></Icon>;
export const Boxes = (p) => <Icon {...p}><path d="M2.5 7 12 2l9.5 5-9.5 5-9.5-5Z" /><path d="M2.5 7v10L12 22V12" /><path d="M21.5 7v10L12 22" /></Icon>;
export const Cpu = (p) => <Icon {...p}><rect x="6" y="6" width="12" height="12" rx="1" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></Icon>;
export const MonitorSmartphone = (p) => <Icon {...p}><rect x="2" y="4" width="14" height="10" rx="1" /><path d="M6 18h6" /><rect x="17" y="9" width="5" height="12" rx="1" /></Icon>;
export const Search = (p) => <Icon {...p}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></Icon>;
export const FileText = (p) => <Icon {...p}><path d="M14 3v5h5" /><path d="M6 21h12a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /><path d="M8 13h8M8 17h5" /></Icon>;
export const BellRing = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M4 4l-1 2M20 4l1 2" /></Icon>;

/* ── Aria-only additions ────────────────────────────────────────────────── */
export const CheckSquare = (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m9 12 2 2 4-4" /></Icon>;
export const Package = (p) => <Icon {...p}><path d="m7.5 4.27 9 5.15" /><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></Icon>;
export const Puzzle = (p) => <Icon {...p}><path d="M9.5 3.5a2 2 0 0 1 4 0V5h2a2 2 0 0 1 2 2v2h1.5a2 2 0 0 1 0 4H17.5v2a2 2 0 0 1-2 2h-2v1.5a2 2 0 0 1-4 0V17h-2a2 2 0 0 1-2-2v-2H4a2 2 0 0 1 0-4h1.5V7a2 2 0 0 1 2-2h2Z" /></Icon>;
export const DiscAlbum = (p) => <Icon {...p}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.75" fill="currentColor" /></Icon>;
export const Bell = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></Icon>;
export const FolderKanban = (p) => <Icon {...p}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /><path d="M8 12v4M12 10v6M16 12v4" /></Icon>;
export const Import = (p) => <Icon {...p}><path d="M12 3v10" /><path d="m8 9 4 4 4-4" /><path d="M20 21H4a2 2 0 0 1-2-2v-1a1 1 0 0 1 1-1h4l2 2h6l2-2h4a1 1 0 0 1 1 1v1a2 2 0 0 1-2 2Z" /></Icon>;
export const Loader2 = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></Icon>;
