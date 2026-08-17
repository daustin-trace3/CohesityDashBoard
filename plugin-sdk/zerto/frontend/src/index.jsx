// Zerto plugin frontend module. Bundled as an IIFE with no ESM imports at
// runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape.
//
// Privacy Inspector is DROPPED per the conversion plan (built-in nav had it
// requiresAi-gated): it needs the host-only PrivacyInspectorPage component,
// which isn't portable into the plugin sandbox — same call Dell made for its
// own Privacy Inspector item. AI Advisor IS ported (advisor.jsx) but
// registered as a plain nav item without the built-in's `requiresAi` gate,
// since the plugin sandbox has no such host flag (Dell's advisor item is
// registered the same way).

import { injectStyles } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import { Gauge, ShieldCheck, Globe2, Bell, MonitorSmartphone, Settings, ArrowLeftRight, BadgeCheck, Sparkles } from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import VpgsPage from './pages/vpgs.jsx';
import ReplicationPage from './pages/replication.jsx';
import SitesPage from './pages/sites.jsx';
import AlertsPage from './pages/alerts.jsx';
import VmsPage from './pages/vms.jsx';
import SettingsPage from './pages/settings.jsx';
import LicensingPage from './pages/licensing.jsx';
import AdvisorPage from './pages/advisor.jsx';

const ACCENT = '#EE3124';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/zerto', icon: Gauge, isActive: (p) => p === '/zerto' },
      { label: 'AI Advisor', route: '/zerto/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/zerto/advisor') },
      { label: 'Alerts', route: '/zerto/alerts', icon: Bell, isActive: (p) => p.startsWith('/zerto/alerts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'VPGs', route: '/zerto/vpgs', icon: ShieldCheck, isActive: (p) => p.startsWith('/zerto/vpgs') },
      { label: 'Replication', route: '/zerto/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/zerto/replication') },
      { label: 'Protected VMs', route: '/zerto/vms', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/zerto/vms') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Sites', route: '/zerto/sites', icon: Globe2, isActive: (p) => p.startsWith('/zerto/sites') },
      { label: 'Licensing', route: '/zerto/licensing', icon: BadgeCheck, isActive: (p) => p.startsWith('/zerto/licensing') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/zerto/settings', icon: Settings, isActive: (p) => p.startsWith('/zerto/settings') },
    ],
  },
];

// Every page renders inside a .zr-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function ZrRooted() { return <div className="zr-root"><C /></div>; };

const routes = [
  { path: 'zerto', Component: rooted(OverviewPage) },
  { path: 'zerto/vpgs', Component: rooted(VpgsPage) },
  { path: 'zerto/replication', Component: rooted(ReplicationPage) },
  { path: 'zerto/sites', Component: rooted(SitesPage) },
  { path: 'zerto/alerts', Component: rooted(AlertsPage) },
  { path: 'zerto/vms', Component: rooted(VmsPage) },
  { path: 'zerto/settings', Component: rooted(SettingsPage) },
  { path: 'zerto/licensing', Component: rooted(LicensingPage) },
  { path: 'zerto/advisor', Component: rooted(AdvisorPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'zerto',
  label: 'Zerto',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/zerto',
  basePath: '/zerto',
  isActive: (p) => p.startsWith('/zerto'),
  navGroups,
  routes,
});
