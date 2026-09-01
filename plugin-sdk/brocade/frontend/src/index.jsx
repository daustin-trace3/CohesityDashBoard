// Brocade SAN plugin frontend module. Bundled as an IIFE with no ESM imports
// at runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape; nav
// structure/labels/routes copied from
// frontend/src/platforms/brocade/index.jsx.

import { injectStyles, ToastHost } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, Waypoints, Router, Cable, HardDrive, Network, AlertTriangle, ClipboardCheck,
  LineChart, ShieldCheck, Settings, Grid3x3,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import FabricsPage from './pages/fabrics.jsx';
import SwitchesPage from './pages/switches.jsx';
import PortsPage from './pages/ports.jsx';
import PortMapPage from './pages/portmap.jsx';
import DevicesPage from './pages/devices.jsx';
import ZoningPage from './pages/zoning.jsx';
import EventsPage from './pages/events.jsx';
import IssuesPage from './pages/issues.jsx';
import TrendsPage from './pages/trends.jsx';
import GovernancePage from './pages/governance.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#CC092F';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/brocade', icon: Gauge, isActive: (p) => p === '/brocade' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Fabrics', route: '/brocade/fabrics', icon: Waypoints, isActive: (p) => p.startsWith('/brocade/fabrics') },
      { label: 'Switches', route: '/brocade/switches', icon: Router, isActive: (p) => p.startsWith('/brocade/switches') },
      { label: 'Ports', route: '/brocade/ports', icon: Cable, isActive: (p) => p.startsWith('/brocade/ports') },
      { label: 'Port Map', route: '/brocade/portmap', icon: Grid3x3, isActive: (p) => p.startsWith('/brocade/portmap') },
      { label: 'Devices & Enclosures', route: '/brocade/devices', icon: HardDrive, isActive: (p) => p.startsWith('/brocade/devices') },
    ],
  },
  {
    label: 'Zoning',
    items: [
      { label: 'Zoning', route: '/brocade/zoning', icon: Network, isActive: (p) => p.startsWith('/brocade/zoning') },
    ],
  },
  {
    label: 'Alarms',
    items: [
      { label: 'Events', route: '/brocade/events', icon: AlertTriangle, isActive: (p) => p.startsWith('/brocade/events') },
      { label: 'Issues & Alerts', route: '/brocade/issues', icon: ClipboardCheck, isActive: (p) => p.startsWith('/brocade/issues') },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { label: 'Trends', route: '/brocade/trends', icon: LineChart, isActive: (p) => p.startsWith('/brocade/trends') },
      { label: 'Governance', route: '/brocade/governance', icon: ShieldCheck, isActive: (p) => p.startsWith('/brocade/governance') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/brocade/settings', icon: Settings, isActive: (p) => p.startsWith('/brocade/settings') },
    ],
  },
];

// Every page renders inside a .bc-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages. ToastHost mounts alongside so any page's useToast()
// calls have somewhere to render (dell has no toast system; cohesity's
// index.jsx established this rooted()+ToastHost pattern).
const rooted = (C) => function BcRooted() {
  return (
    <div className="bc-root">
      <C />
      <ToastHost />
    </div>
  );
};

const routes = [
  { path: 'brocade', Component: rooted(OverviewPage) },
  { path: 'brocade/fabrics', Component: rooted(FabricsPage) },
  { path: 'brocade/switches', Component: rooted(SwitchesPage) },
  { path: 'brocade/ports', Component: rooted(PortsPage) },
  { path: 'brocade/portmap', Component: rooted(PortMapPage) },
  { path: 'brocade/devices', Component: rooted(DevicesPage) },
  { path: 'brocade/zoning', Component: rooted(ZoningPage) },
  { path: 'brocade/events', Component: rooted(EventsPage) },
  { path: 'brocade/issues', Component: rooted(IssuesPage) },
  { path: 'brocade/trends', Component: rooted(TrendsPage) },
  { path: 'brocade/governance', Component: rooted(GovernancePage) },
  { path: 'brocade/settings', Component: rooted(SettingsPage) },
];

// Registers synchronously — no awaited fetches pre-register; the bundle
// loads on the login page too, so navGroups/routes must be static at
// import time. window.__ICC_REGISTER_PLUGIN__ is injected by the host
// before plugin bundles load.
window.__ICC_REGISTER_PLUGIN__({
  id: 'brocade',
  label: 'Brocade SAN',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/brocade',
  basePath: '/brocade',
  isActive: (p) => p.startsWith('/brocade'),
  get navGroups() { return navGroups; },
  routes,
});
