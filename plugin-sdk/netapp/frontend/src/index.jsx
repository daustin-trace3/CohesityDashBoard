// NetApp plugin frontend module. Bundled as an IIFE with no ESM imports at
// runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape (freshest
// golden template as of the 2026-08-17 conversion wave).
//
// Privacy Inspector is DROPPED per the conversion plan: it needs the
// host-only PrivacyInspectorPage component, which isn't portable. AI Advisor
// IS ported (advisor.jsx) but registered as a plain nav item without the
// built-in's `requiresAi` gate, since the plugin sandbox has no such host
// flag (same pattern as dell).

import { injectStyles } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, Sparkles, Database, Layers, AlertTriangle, Network, FolderTree, Cable,
  ArrowLeftRight, HardDrive, Settings,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import CapacityPage from './pages/capacity.jsx';
import VolumesPage from './pages/volumes.jsx';
import NfsPage from './pages/nfs.jsx';
import CifsPage from './pages/cifs.jsx';
import MountsPage from './pages/mounts.jsx';
import ReplicationPage from './pages/replication.jsx';
import AlertsPage from './pages/alerts.jsx';
import HardwarePage from './pages/hardware.jsx';
import AdvisorPage from './pages/advisor.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#0067C5';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/netapp', icon: Gauge, isActive: (p) => p === '/netapp' },
      { label: 'AI Advisor', route: '/netapp/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/netapp/advisor') },
      { label: 'Capacity', route: '/netapp/capacity', icon: Database, isActive: (p) => p.startsWith('/netapp/capacity') },
      { label: 'Volumes', route: '/netapp/volumes', icon: Layers, isActive: (p) => p.startsWith('/netapp/volumes') },
      { label: 'Alerts', route: '/netapp/alerts', icon: AlertTriangle, isActive: (p) => p.startsWith('/netapp/alerts') },
    ],
  },
  {
    label: 'Shares & Mounts',
    items: [
      { label: 'NFS', route: '/netapp/nfs', icon: Network, isActive: (p) => p.startsWith('/netapp/nfs') },
      { label: 'SMB / CIFS', route: '/netapp/cifs', icon: FolderTree, isActive: (p) => p.startsWith('/netapp/cifs') },
      { label: 'Mounts', route: '/netapp/mounts', icon: Cable, isActive: (p) => p.startsWith('/netapp/mounts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Replication', route: '/netapp/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/netapp/replication') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Hardware', route: '/netapp/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/netapp/hardware') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/netapp/settings', icon: Settings, isActive: (p) => p.startsWith('/netapp/settings') },
    ],
  },
];

// Every page renders inside a .na-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function NaRooted() { return <div className="na-root"><C /></div>; };

const routes = [
  { path: 'netapp', Component: rooted(OverviewPage) },
  { path: 'netapp/capacity', Component: rooted(CapacityPage) },
  { path: 'netapp/volumes', Component: rooted(VolumesPage) },
  { path: 'netapp/nfs', Component: rooted(NfsPage) },
  { path: 'netapp/cifs', Component: rooted(CifsPage) },
  { path: 'netapp/mounts', Component: rooted(MountsPage) },
  { path: 'netapp/replication', Component: rooted(ReplicationPage) },
  { path: 'netapp/alerts', Component: rooted(AlertsPage) },
  { path: 'netapp/hardware', Component: rooted(HardwarePage) },
  { path: 'netapp/advisor', Component: rooted(AdvisorPage) },
  { path: 'netapp/settings', Component: rooted(SettingsPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'netapp',
  label: 'NetApp',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/netapp',
  basePath: '/netapp',
  isActive: (p) => p.startsWith('/netapp'),
  navGroups,
  routes,
});
