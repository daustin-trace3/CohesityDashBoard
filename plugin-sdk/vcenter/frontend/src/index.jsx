// vCenter plugin frontend module. Bundled as an IIFE with no ESM imports at
// runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape.
//
// Gaps vs the built-in platforms/vcenter/index.jsx nav: Privacy Inspector is
// DROPPED — it needs the host-only components/PrivacyInspectorPage (not
// portable, same call the Dell conversion made). AI Advisor IS ported
// (advisor.jsx) but registered as a plain nav item without the built-in's
// `requiresAi` gate, since the plugin sandbox has no such host flag (again
// matching the Dell precedent).

import { injectStyles } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, Server, Database, Settings, MonitorSmartphone, Network, ClipboardCheck, History, Sparkles, Bell,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import AlertsPage from './pages/alerts.jsx';
import HostsPage from './pages/hosts.jsx';
import InventoryPage from './pages/inventory.jsx';
import DatastoresPage from './pages/datastores.jsx';
import NetworkPage from './pages/network.jsx';
import EventsPage from './pages/events.jsx';
import GovernancePage from './pages/governance.jsx';
import AdvisorPage from './pages/advisor.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#0091DA';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/vcenter', icon: Gauge, isActive: (p) => p === '/vcenter' },
      { label: 'Alerts', route: '/vcenter/alerts', icon: Bell, isActive: (p) => p.startsWith('/vcenter/alerts') },
      { label: 'AI Advisor', route: '/vcenter/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/vcenter/advisor') },
      { label: 'Events', route: '/vcenter/events', icon: History, isActive: (p) => p.startsWith('/vcenter/events') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'ESX Hosts', route: '/vcenter/hosts', icon: Server, isActive: (p) => p.startsWith('/vcenter/hosts') },
      { label: 'VM Inventory', route: '/vcenter/inventory', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/vcenter/inventory') },
      { label: 'Datastores', route: '/vcenter/datastores', icon: Database, isActive: (p) => p.startsWith('/vcenter/datastores') },
      { label: 'Network', route: '/vcenter/network', icon: Network, isActive: (p) => p.startsWith('/vcenter/network') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Governance', route: '/vcenter/governance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/vcenter/governance') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/vcenter/settings', icon: Settings, isActive: (p) => p.startsWith('/vcenter/settings') },
    ],
  },
];

// Every page renders inside a .vc-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function VcRooted() { return <div className="vc-root"><C /></div>; };

const routes = [
  { path: 'vcenter', Component: rooted(OverviewPage) },
  { path: 'vcenter/alerts', Component: rooted(AlertsPage) },
  { path: 'vcenter/hosts', Component: rooted(HostsPage) },
  { path: 'vcenter/inventory', Component: rooted(InventoryPage) },
  { path: 'vcenter/datastores', Component: rooted(DatastoresPage) },
  { path: 'vcenter/network', Component: rooted(NetworkPage) },
  { path: 'vcenter/events', Component: rooted(EventsPage) },
  { path: 'vcenter/governance', Component: rooted(GovernancePage) },
  { path: 'vcenter/advisor', Component: rooted(AdvisorPage) },
  { path: 'vcenter/settings', Component: rooted(SettingsPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'vcenter',
  label: 'vCenter',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/vcenter',
  basePath: '/vcenter',
  isActive: (p) => p.startsWith('/vcenter'),
  navGroups,
  routes,
});
