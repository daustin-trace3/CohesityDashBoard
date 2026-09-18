// BlueCat Address Manager plugin frontend module. Bundled as an IIFE with no
// ESM imports at runtime - React/ReactDOM/ReactRouterDOM/Chart come from
// window globals (injected by the build banner, see plugin-sdk/build.mjs).
// Mirrors plugin-sdk/brocade/frontend/src/index.jsx's registration shape;
// nav structure/labels/routes copied from
// frontend/src/platforms/bluecat/index.jsx. The Privacy Inspector nav entry
// points at the host's generic /ai/privacy/:platform route (App.jsx) - it is
// not one of this pack's own routes, matching the brocade pack's pattern.

import { injectStyles, ToastHost } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, Network, Globe, HardDrive, Server, ClipboardCheck, Settings, Sparkles, ShieldCheck,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import IpSpacesPage from './pages/ipspaces.jsx';
import DnsPage from './pages/dns.jsx';
import DevicesPage from './pages/devices.jsx';
import ServersPage from './pages/servers.jsx';
import AlertsPage from './pages/alerts.jsx';
import AdvisorPage from './pages/advisor.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#0057B8';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/bluecat', icon: Gauge, isActive: (p) => p === '/bluecat' },
      { label: 'AI Advisor', route: '/bluecat/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/bluecat/advisor'), requiresAi: true },
      { label: 'IP Spaces', route: '/bluecat/ipspaces', icon: Network, isActive: (p) => p.startsWith('/bluecat/ipspaces') },
      { label: 'DNS', route: '/bluecat/dns', icon: Globe, isActive: (p) => p.startsWith('/bluecat/dns') },
      { label: 'Devices', route: '/bluecat/devices', icon: HardDrive, isActive: (p) => p.startsWith('/bluecat/devices') },
      { label: 'Servers', route: '/bluecat/servers', icon: Server, isActive: (p) => p.startsWith('/bluecat/servers') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Issue Alerts', route: '/bluecat/alerts', icon: ClipboardCheck, isActive: (p) => p.startsWith('/bluecat/alerts') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: '/ai/privacy/bluecat', icon: ShieldCheck, isActive: (p) => p.startsWith('/ai/privacy/bluecat'), requiresAi: true },
      { label: 'Settings', route: '/bluecat/settings', icon: Settings, isActive: (p) => p.startsWith('/bluecat/settings') },
    ],
  },
];

// Every page renders inside a .blc-root wrapper - the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages. ToastHost mounts alongside so any page's useToast()
// calls have somewhere to render.
const rooted = (C) => function BlcRooted() {
  return (
    <div className="blc-root">
      <C />
      <ToastHost />
    </div>
  );
};

const routes = [
  { path: 'bluecat', Component: rooted(OverviewPage) },
  { path: 'bluecat/ipspaces', Component: rooted(IpSpacesPage) },
  { path: 'bluecat/dns', Component: rooted(DnsPage) },
  { path: 'bluecat/devices', Component: rooted(DevicesPage) },
  { path: 'bluecat/servers', Component: rooted(ServersPage) },
  { path: 'bluecat/alerts', Component: rooted(AlertsPage) },
  { path: 'bluecat/advisor', Component: rooted(AdvisorPage) },
  { path: 'bluecat/settings', Component: rooted(SettingsPage) },
];

// Registers synchronously - no awaited fetches pre-register; the bundle
// loads on the login page too, so navGroups/routes must be static at import
// time. window.__ICC_REGISTER_PLUGIN__ is injected by the host before
// plugin bundles load.
window.__ICC_REGISTER_PLUGIN__({
  id: 'bluecat',
  label: 'BlueCat Address Manager',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/bluecat',
  basePath: '/bluecat',
  isActive: (p) => p.startsWith('/bluecat'),
  get navGroups() { return navGroups; },
  routes,
});
