// Aria Operations plugin frontend module. Bundled as an IIFE with no ESM
// imports at runtime — React/ReactDOM/ReactRouterDOM/Chart come from window
// globals (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape.
//
// No PNG exists at frontend/src/assets/platform-logos/ariaops.png and the
// built-in platforms/ariaops/index.jsx module carries no logo/monogram
// reference of its own (just a `color` hex) — so `logo` is omitted here;
// the switcher falls back to its generic monogram for this id.

import { injectStyles } from './ui.jsx';
import { Gauge, Boxes, AlertTriangle, Settings } from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import ResourcesPage from './pages/resources.jsx';
import AlertsPage from './pages/alerts.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#78BE20';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/ariaops', icon: Gauge, isActive: (p) => p === '/ariaops' },
      { label: 'Resources', route: '/ariaops/resources', icon: Boxes, isActive: (p) => p.startsWith('/ariaops/resources') },
      { label: 'Alerts', route: '/ariaops/alerts', icon: AlertTriangle, isActive: (p) => p.startsWith('/ariaops/alerts') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/ariaops/settings', icon: Settings, isActive: (p) => p.startsWith('/ariaops/settings') },
    ],
  },
];

// Every page renders inside an .ao-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function AoRooted() { return <div className="ao-root"><C /></div>; };

const routes = [
  { path: 'ariaops', Component: rooted(OverviewPage) },
  { path: 'ariaops/resources', Component: rooted(ResourcesPage) },
  { path: 'ariaops/alerts', Component: rooted(AlertsPage) },
  { path: 'ariaops/settings', Component: rooted(SettingsPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'ariaops',
  label: 'Aria Ops',
  color: ACCENT,
  switcherRoute: '/ariaops',
  basePath: '/ariaops',
  isActive: (p) => p === '/ariaops' || p.startsWith('/ariaops/'),
  navGroups,
  routes,
});
