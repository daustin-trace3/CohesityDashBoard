// Dell plugin frontend module. Bundled as an IIFE with no ESM imports at
// runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/unifi/frontend/src/index.jsx's registration shape.
//
// Dell has no feature-flag gating like unifi's wifi/protect/security
// modules — the built-in platforms/dell/index.jsx nav is a static array,
// so navGroups here is static too. AI Advisor and Privacy Inspector are
// DROPPED per the conversion plan: Privacy Inspector needs the host-only
// PrivacyInspectorPage component (not portable); AI Advisor IS ported
// (advisor.jsx) but registered as a plain nav item without the built-in's
// `requiresAi` gate, since the plugin sandbox has no such host flag.

import { injectStyles } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, Server, Settings, AlertTriangle, Wrench, BadgeCheck, Sparkles, ClipboardCheck, ListChecks, ScrollText, FileBarChart,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import DevicesPage from './pages/devices.jsx';
import AlertsPage from './pages/alerts.jsx';
import JobsPage from './pages/jobs.jsx';
import HardwarePage from './pages/hardware.jsx';
import GovernancePage from './pages/governance.jsx';
import HardwareLogsPage from './pages/hardwareLogs.jsx';
import ReportsPage from './pages/reports.jsx';
import SupportPage from './pages/support.jsx';
import AdvisorPage from './pages/advisor.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#007DB8';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/dell', icon: Gauge, isActive: (p) => p === '/dell' },
      { label: 'AI Advisor', route: '/dell/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/dell/advisor') },
      { label: 'Alerts', route: '/dell/alerts', icon: AlertTriangle, isActive: (p) => p.startsWith('/dell/alerts') },
      { label: 'Jobs', route: '/dell/jobs', icon: ListChecks, isActive: (p) => p.startsWith('/dell/jobs') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Devices', route: '/dell/devices', icon: Server, isActive: (p) => p.startsWith('/dell/devices') },
      { label: 'Hardware', route: '/dell/hardware', icon: Wrench, isActive: (p) => p.startsWith('/dell/hardware') && !p.startsWith('/dell/hardware-logs') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Governance', route: '/dell/compliance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/dell/compliance') },
      { label: 'Hardware Logs', route: '/dell/hardware-logs', icon: ScrollText, isActive: (p) => p.startsWith('/dell/hardware-logs') },
      { label: 'Reports', route: '/dell/reports', icon: FileBarChart, isActive: (p) => p.startsWith('/dell/reports') },
      { label: 'Support', route: '/dell/support', icon: BadgeCheck, isActive: (p) => p.startsWith('/dell/support') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/dell/settings', icon: Settings, isActive: (p) => p.startsWith('/dell/settings') },
    ],
  },
];

// Every page renders inside a .dl-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function DlRooted() { return <div className="dl-root"><C /></div>; };

const routes = [
  { path: 'dell', Component: rooted(OverviewPage) },
  { path: 'dell/devices', Component: rooted(DevicesPage) },
  { path: 'dell/alerts', Component: rooted(AlertsPage) },
  { path: 'dell/hardware', Component: rooted(HardwarePage) },
  { path: 'dell/jobs', Component: rooted(JobsPage) },
  { path: 'dell/compliance', Component: rooted(GovernancePage) },
  { path: 'dell/hardware-logs', Component: rooted(HardwareLogsPage) },
  { path: 'dell/reports', Component: rooted(ReportsPage) },
  { path: 'dell/support', Component: rooted(SupportPage) },
  { path: 'dell/advisor', Component: rooted(AdvisorPage) },
  { path: 'dell/settings', Component: rooted(SettingsPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'dell',
  label: 'Dell',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/dell',
  basePath: '/dell',
  isActive: (p) => p.startsWith('/dell'),
  navGroups,
  routes,
});
