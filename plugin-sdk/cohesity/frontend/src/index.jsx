// Cohesity plugin frontend module. Bundled as an IIFE with no ESM imports at
// runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape.
//
// WP-C built the shared kit + Monitor/Infrastructure half: Dashboard,
// Alerts, Clusters, Hardware, GFlags, Settings. WP-D added the Protect/
// Reporting half: DataProtection, Workloads, Replication, Views,
// Governance, BackupHistory, Object360, Analytics, Licensing, Sources,
// Reporting, AIAdvisor.
//
// Nav groups mirror the built-in frontend/src/platforms/cohesity/index.jsx
// exactly for every item this pack owns, minus Privacy Inspector (dropped —
// needs the host-only PrivacyInspectorPage component, same call dell made).

import { injectStyles, ToastHost } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, Bell, Server, HardDrive, Flag, Settings,
  ShieldCheck, ArrowLeftRight, ClipboardCheck, BadgeCheck, Sparkles,
} from './icons.jsx';

// Nav-only icons not in the shared kit (icons.jsx has no folder-open,
// activity-pulse, file-text, layers, calendar-check, or crosshair/boxes
// glyphs) — added locally, same 24x24 stroke style as icons.jsx, per the
// "no shared-kit edits, page-local helpers instead" rule.
function NavIcon({ children, size = 16, className = '', ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      {children}
    </svg>
  );
}
const FolderOpen = (p) => <NavIcon {...p}><path d="M4 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" /><path d="M2 11h18.5a2 2 0 0 1 1.9 2.6l-1.5 5A2 2 0 0 1 19 20H4" /></NavIcon>;
const Activity = (p) => <NavIcon {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></NavIcon>;
const FileText = (p) => <NavIcon {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6M9 9h1" /></NavIcon>;
const Layers = (p) => <NavIcon {...p}><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></NavIcon>;
const CalendarCheck = (p) => <NavIcon {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="m9 16 2 2 4-4" /></NavIcon>;
const Crosshair = (p) => <NavIcon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></NavIcon>;
const Boxes = (p) => <NavIcon {...p}><path d="M2.97 12.92 12 18l9.03-5.08M2.97 8.08 12 3l9.03 5.08L12 13.16 2.97 8.08Z" /><path d="M2.97 8.08v9.79L12 23l9.03-5.13V8.08M12 13.16V23" /></NavIcon>;

import DashboardPage from './pages/dashboard.jsx';
import AlertsPage from './pages/alerts.jsx';
import ClusterManagementPage from './pages/clusters.jsx';
import HardwarePage from './pages/hardware.jsx';
import GflagsPage from './pages/gflags.jsx';
import SettingsPage from './pages/settings.jsx';
import DataProtectionPage from './pages/dataProtection.jsx';
import WorkloadsPage from './pages/workloads.jsx';
import ReplicationPage from './pages/replication.jsx';
import ViewsPage from './pages/views.jsx';
import GovernancePage from './pages/governance.jsx';
import BackupHistoryPage from './pages/backupHistory.jsx';
import CohesityObject360Page from './pages/object360.jsx';
import AnalyticsPage from './pages/analytics.jsx';
import LicensingPage from './pages/licensing.jsx';
import SourcesPage from './pages/sources.jsx';
import ReportingPage from './pages/reporting.jsx';
import AIAdvisorPage from './pages/aiAdvisor.jsx';

const ACCENT = '#6CB33F';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/cohesity', icon: Gauge, isActive: (p) => p === '/cohesity' },
      { label: 'AI Advisor', route: '/cohesity/ai-advisor', icon: Sparkles, isActive: (p) => p.startsWith('/cohesity/ai-advisor') },
      { label: 'Alerts', route: '/cohesity/alerts', icon: Bell, isActive: (p) => p.startsWith('/cohesity/alerts') },
      { label: 'Licensing', route: '/cohesity/licensing', icon: BadgeCheck, isActive: (p) => p.startsWith('/cohesity/licensing') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Data Protection', route: '/cohesity/data-protection', icon: ShieldCheck, isActive: (p) => p.startsWith('/cohesity/data-protection') },
      { label: 'Workloads', route: '/cohesity/workloads', icon: Layers, isActive: (p) => p.startsWith('/cohesity/workloads') },
      { label: 'Replication', route: '/cohesity/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/cohesity/replication') },
      { label: 'Views', route: '/cohesity/views', icon: FolderOpen, isActive: (p) => p.startsWith('/cohesity/views') },
      { label: 'Governance', route: '/cohesity/governance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/cohesity/governance') },
    ],
  },
  {
    label: 'Reporting',
    items: [
      { label: 'Backup History', route: '/cohesity/backup-history', icon: CalendarCheck, isActive: (p) => p.startsWith('/cohesity/backup-history') },
      { label: 'Object 360', route: '/cohesity/object-360', icon: Crosshair, isActive: (p) => p.startsWith('/cohesity/object-360') },
      { label: 'Reporting', route: '/cohesity/reporting', icon: FileText, isActive: (p) => p.startsWith('/cohesity/reporting') },
      { label: 'Analytics', route: '/cohesity/analytics', icon: Activity, isActive: (p) => p.startsWith('/cohesity/analytics') },
      { label: 'Sources', route: '/cohesity/sources', icon: Boxes, isActive: (p) => p.startsWith('/cohesity/sources') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Clusters', route: '/cohesity/clusters', icon: Server, isActive: (p) => p.startsWith('/cohesity/clusters') },
      { label: 'Hardware', route: '/cohesity/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/cohesity/hardware') },
      { label: 'GFlags', route: '/cohesity/gflags', icon: Flag, isActive: (p) => p.startsWith('/cohesity/gflags') },
    ],
  },
  {
    label: 'System',
    items: [
      // Privacy Inspector dropped: needs the host-only PrivacyInspectorPage
      // component, not portable into the plugin sandbox (same call the dell
      // wave made — see plugin-sdk/dell/frontend/src/index.jsx comment).
      { label: 'Settings', route: '/cohesity/settings', icon: Settings, isActive: (p) => p.startsWith('/cohesity/settings') },
    ],
  },
];

// Every page renders inside a .co-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages. ToastHost mounts alongside so any page's useToast() calls
// render somewhere without every page needing its own toast stack.
const rooted = (C) => function CoRooted() {
  return (
    <div className="co-root">
      <C />
      <ToastHost />
    </div>
  );
};

const ROUTES = [
  { path: 'cohesity', Component: rooted(DashboardPage) },
  { path: 'cohesity/alerts', Component: rooted(AlertsPage) },
  { path: 'cohesity/clusters', Component: rooted(ClusterManagementPage) },
  { path: 'cohesity/hardware', Component: rooted(HardwarePage) },
  { path: 'cohesity/gflags', Component: rooted(GflagsPage) },
  { path: 'cohesity/settings', Component: rooted(SettingsPage) },
  { path: 'cohesity/data-protection', Component: rooted(DataProtectionPage) },
  { path: 'cohesity/workloads', Component: rooted(WorkloadsPage) },
  { path: 'cohesity/replication', Component: rooted(ReplicationPage) },
  { path: 'cohesity/views', Component: rooted(ViewsPage) },
  { path: 'cohesity/governance', Component: rooted(GovernancePage) },
  { path: 'cohesity/backup-history', Component: rooted(BackupHistoryPage) },
  { path: 'cohesity/object-360', Component: rooted(CohesityObject360Page) },
  { path: 'cohesity/analytics', Component: rooted(AnalyticsPage) },
  { path: 'cohesity/licensing', Component: rooted(LicensingPage) },
  { path: 'cohesity/sources', Component: rooted(SourcesPage) },
  { path: 'cohesity/reporting', Component: rooted(ReportingPage) },
  { path: 'cohesity/ai-advisor', Component: rooted(AIAdvisorPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'cohesity',
  label: 'Cohesity',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/cohesity',
  basePath: '/cohesity',
  isActive: (p) => p.startsWith('/cohesity'),
  navGroups,
  routes: ROUTES,
});
