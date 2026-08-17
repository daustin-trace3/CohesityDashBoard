// Aria Automation plugin frontend module. Bundled as an IIFE with no ESM
// imports at runtime — React/ReactDOM/ReactRouterDOM/Chart come from window
// globals (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape.
//
// Aria has no feature-flag gating like unifi's wifi/protect/security
// modules — the built-in platforms/aria/index.jsx nav is a static array, so
// navGroups here is static too. Privacy Inspector is DROPPED per the
// conversion plan: it needs the host-only PrivacyInspectorPage component
// (not portable — same reasoning as Dell's drop). AI Advisor IS ported
// (advisor.jsx) but registered as a plain nav item without the built-in's
// `requiresAi` gate, since the plugin sandbox has no such host flag (same
// as Dell's conversion).

import { injectStyles } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, Package, Activity, Server, Puzzle, CheckSquare, Settings, DiscAlbum, Sparkles, MonitorSmartphone, Bell,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import AlertsPage from './pages/alerts.jsx';
import AdvisorPage from './pages/advisor.jsx';
import DeploymentsPage from './pages/deployments.jsx';
import ActivityPage from './pages/activity.jsx';
import InfrastructurePage from './pages/infrastructure.jsx';
import AppliancesPage from './pages/appliances.jsx';
import ExtensibilityPage from './pages/extensibility.jsx';
import ApprovalsPage from './pages/approvals.jsx';
import ImagesAuditPage from './pages/imagesAudit.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#00A2C7';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/aria', icon: Gauge, isActive: (p) => p === '/aria' },
      { label: 'Alerts', route: '/aria/alerts', icon: Bell, isActive: (p) => p.startsWith('/aria/alerts') },
      { label: 'AI Advisor', route: '/aria/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/aria/advisor') },
      { label: 'Deployments', route: '/aria/deployments', icon: Package, isActive: (p) => p.startsWith('/aria/deployments') },
      { label: 'Activity', route: '/aria/activity', icon: Activity, isActive: (p) => p.startsWith('/aria/activity') },
      { label: 'Infrastructure', route: '/aria/infrastructure', icon: Server, isActive: (p) => p.startsWith('/aria/infrastructure') },
      { label: 'Appliances', route: '/aria/appliances', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/aria/appliances') },
      { label: 'Extensibility', route: '/aria/extensibility', icon: Puzzle, isActive: (p) => p.startsWith('/aria/extensibility') },
      { label: 'Approvals', route: '/aria/approvals', icon: CheckSquare, isActive: (p) => p.startsWith('/aria/approvals') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Images', route: '/aria/images', icon: DiscAlbum, isActive: (p) => p.startsWith('/aria/images') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/aria/settings', icon: Settings, isActive: (p) => p.startsWith('/aria/settings') },
    ],
  },
];

// Every page renders inside an .ar-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function ArRooted() { return <div className="ar-root"><C /></div>; };

const routes = [
  { path: 'aria', Component: rooted(OverviewPage) },
  { path: 'aria/alerts', Component: rooted(AlertsPage) },
  { path: 'aria/advisor', Component: rooted(AdvisorPage) },
  { path: 'aria/deployments', Component: rooted(DeploymentsPage) },
  { path: 'aria/activity', Component: rooted(ActivityPage) },
  { path: 'aria/infrastructure', Component: rooted(InfrastructurePage) },
  { path: 'aria/appliances', Component: rooted(AppliancesPage) },
  { path: 'aria/extensibility', Component: rooted(ExtensibilityPage) },
  { path: 'aria/approvals', Component: rooted(ApprovalsPage) },
  { path: 'aria/images', Component: rooted(ImagesAuditPage) },
  { path: 'aria/settings', Component: rooted(SettingsPage) },
];

// 'ariaops' (vROps, a separate plugin) contains 'aria' as a substring —
// don't let /ariaops/* match this platform's isActive.
function isActive(pathname) {
  return pathname === '/aria' || pathname.startsWith('/aria/');
}

window.__ICC_REGISTER_PLUGIN__({
  id: 'aria',
  label: 'Aria Automation',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/aria',
  basePath: '/aria',
  isActive,
  navGroups,
  routes,
});
