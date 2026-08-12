// UniFi plugin frontend module. Bundled as an IIFE with no ESM imports at
// runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/nutanix/frontend/src/index.jsx's registration shape.
//
// Feature-module conditionality (contract §Feature toggles): wifi/protect/
// security nav items are hidden unless GET /api/unifi/features reports the
// module on — fetched BEFORE __ICC_REGISTER_PLUGIN__ is called, since
// navGroups are static at register time. Toggling a module afterwards
// needs a page reload for the menu to pick it up (pages self-gate via
// disabled payloads in the meantime).

import { injectStyles } from './ui.jsx';
import {
  Gauge, Router, Cable, Users, Wifi, Share2, Globe, ShieldCheck, ClipboardCheck, Settings, Cctv,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import DevicesPage from './pages/devices.jsx';
import PortsPage from './pages/ports.jsx';
import ClientsPage from './pages/clients.jsx';
import WifiPage from './pages/wifi.jsx';
import ProtectPage from './pages/protect.jsx';
import TopologyPage from './pages/topology.jsx';
import WanPage from './pages/wan.jsx';
import SecurityPage from './pages/security.jsx';
import AlertsPage from './pages/alerts.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#006FFF';
const FEATURES_TIMEOUT_MS = 3000;

injectStyles();

function navGroups(features) {
  const wifiOn = features?.wifi === true;
  const protectOn = features?.protect === true;
  const securityOn = features?.security === true;

  const monitorItems = [
    { label: 'Overview', route: '/unifi', icon: Gauge, isActive: (p) => p === '/unifi' },
    { label: 'Devices', route: '/unifi/devices', icon: Router, isActive: (p) => p.startsWith('/unifi/devices') },
    { label: 'Ports', route: '/unifi/ports', icon: Cable, isActive: (p) => p.startsWith('/unifi/ports') },
    { label: 'Clients', route: '/unifi/clients', icon: Users, isActive: (p) => p.startsWith('/unifi/clients') },
  ];
  if (wifiOn) monitorItems.push({ label: 'WiFi', route: '/unifi/wifi', icon: Wifi, isActive: (p) => p.startsWith('/unifi/wifi') });
  if (protectOn) monitorItems.push({ label: 'Protect', route: '/unifi/protect', icon: Cctv, isActive: (p) => p.startsWith('/unifi/protect') });

  const networkItems = [
    { label: 'Topology', route: '/unifi/topology', icon: Share2, isActive: (p) => p.startsWith('/unifi/topology') },
    { label: 'WAN / ISP', route: '/unifi/wan', icon: Globe, isActive: (p) => p.startsWith('/unifi/wan') },
  ];
  if (securityOn) networkItems.push({ label: 'Security', route: '/unifi/security', icon: ShieldCheck, isActive: (p) => p.startsWith('/unifi/security') });

  return [
    { label: 'Monitor', items: monitorItems },
    { label: 'Network', items: networkItems },
    {
      label: 'Audit',
      items: [
        { label: 'Issue Alerts', route: '/unifi/alerts', icon: ClipboardCheck, isActive: (p) => p.startsWith('/unifi/alerts') },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Settings', route: '/unifi/settings', icon: Settings, isActive: (p) => p.startsWith('/unifi/settings') },
      ],
    },
  ];
}

const routes = [
  { path: 'unifi', Component: OverviewPage },
  { path: 'unifi/devices', Component: DevicesPage },
  { path: 'unifi/ports', Component: PortsPage },
  { path: 'unifi/clients', Component: ClientsPage },
  { path: 'unifi/wifi', Component: WifiPage },
  { path: 'unifi/protect', Component: ProtectPage },
  { path: 'unifi/topology', Component: TopologyPage },
  { path: 'unifi/wan', Component: WanPage },
  { path: 'unifi/security', Component: SecurityPage },
  { path: 'unifi/alerts', Component: AlertsPage },
  { path: 'unifi/settings', Component: SettingsPage },
];

function register(features) {
  window.__ICC_REGISTER_PLUGIN__({
    id: 'unifi',
    label: 'Ubiquiti UniFi',
    color: ACCENT,
    switcherRoute: '/unifi',
    basePath: '/unifi',
    isActive: (p) => p.startsWith('/unifi'),
    navGroups: navGroups(features),
    routes,
  });
}

function probeFeatures() {
  if (typeof fetch !== 'function') return Promise.resolve({ wifi: false, protect: false, security: false });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), FEATURES_TIMEOUT_MS);
  return fetch('/api/unifi/features', { credentials: 'include', signal: controller?.signal })
    .then((res) => (res.ok ? res.json() : {}))
    .then((json) => ({ wifi: json?.wifi === true, protect: json?.protect === true, security: json?.security === true }))
    // default-OFF shipping: hide feature-tagged nav items on fetch failure/timeout.
    .catch(() => ({ wifi: false, protect: false, security: false }))
    .finally(() => clearTimeout(timer));
}

probeFeatures().then(register);
