// Pure Storage plugin frontend module. Bundled as an IIFE with no ESM
// imports at runtime — React/ReactDOM/ReactRouterDOM/Chart come from window
// globals (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape.
//
// Dropped vs the built-in platforms/pure/index.jsx: the Privacy Inspector
// nav item (needs the host-only PrivacyInspectorPage component, not
// portable) and the `requiresAi` gate on AI Advisor (no such host flag in
// the plugin sandbox — AI Advisor is a plain nav item instead, same as
// dell's conversion). PureOverviewPage.jsx and PureStoragePage.jsx in the
// built-in source tree are NOT routed by platforms/pure/index.jsx (dead
// code) and were not ported.
//
// CONTRACT: the plugin dispatcher only serves /api/pure/* (no static
// /api/pure1/* mount like the built-in host router has), so every Pure1
// SaaS call in these pages goes through apiFetch('/pure/pure1/<x>') —
// status, settings, test, overview, alerts, enrichment, volumes, pods,
// hardware, connectivity, capacity/history, performance/history. Direct-array
// CRUD + advisor stay at /pure/arrays/*, /pure/advisor/* unchanged.

import { injectStyles } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Cloud, LayoutList, Database, Layers, Bell, ArrowLeftRight, HardDrive, Network, Settings, Sparkles,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import EstatePage from './pages/estate.jsx';
import CapacityPage from './pages/capacity.jsx';
import VolumesPage from './pages/volumes.jsx';
import ReplicationPage from './pages/replication.jsx';
import HardwarePage from './pages/hardware.jsx';
import ConnectivityPage from './pages/connectivity.jsx';
import AlertsPage from './pages/alerts.jsx';
import AdvisorPage from './pages/advisor.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#FF6B00';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/pure', icon: Cloud, isActive: (p) => p === '/pure' },
      { label: 'AI Advisor', route: '/pure/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/pure/advisor') },
      { label: 'Estate', route: '/pure/estate', icon: LayoutList, isActive: (p) => p.startsWith('/pure/estate') },
      { label: 'Capacity', route: '/pure/capacity', icon: Database, isActive: (p) => p.startsWith('/pure/capacity') },
      { label: 'Volumes', route: '/pure/volumes', icon: Layers, isActive: (p) => p.startsWith('/pure/volumes') },
      { label: 'Alerts', route: '/pure/alerts', icon: Bell, isActive: (p) => p.startsWith('/pure/alerts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Replication', route: '/pure/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/pure/replication') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Hardware', route: '/pure/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/pure/hardware') },
      { label: 'Connectivity', route: '/pure/connectivity', icon: Network, isActive: (p) => p.startsWith('/pure/connectivity') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/pure/settings', icon: Settings, isActive: (p) => p.startsWith('/pure/settings') },
    ],
  },
];

// Every page renders inside a .pu-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function PuRooted() { return <div className="pu-root"><C /></div>; };

const routes = [
  { path: 'pure', Component: rooted(OverviewPage) },
  { path: 'pure/estate', Component: rooted(EstatePage) },
  { path: 'pure/capacity', Component: rooted(CapacityPage) },
  { path: 'pure/volumes', Component: rooted(VolumesPage) },
  { path: 'pure/replication', Component: rooted(ReplicationPage) },
  { path: 'pure/hardware', Component: rooted(HardwarePage) },
  { path: 'pure/connectivity', Component: rooted(ConnectivityPage) },
  { path: 'pure/alerts', Component: rooted(AlertsPage) },
  { path: 'pure/advisor', Component: rooted(AdvisorPage) },
  { path: 'pure/settings', Component: rooted(SettingsPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'pure',
  label: 'Pure',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/pure',
  basePath: '/pure',
  isActive: (p) => p.startsWith('/pure'),
  navGroups,
  routes,
});
