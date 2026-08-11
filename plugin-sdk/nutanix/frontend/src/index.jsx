// Nutanix plugin frontend module (ICC contract C9.4). Bundled as an IIFE
// with no ESM imports at runtime — React/ReactDOM/ReactRouterDOM/Chart come
// from window globals (injected by the build banner, see
// plugin-sdk/build.mjs). Mirrors plugin-sdk/rubrik/frontend/src/index.jsx's
// registration shape.
//
// Move nav conditionality (contract decision 5): navGroups are static at
// register time, so this fetches /api/nutanix/overview BEFORE calling
// __ICC_REGISTER_PLUGIN__ with a 3s timeout fallback to showing Move (the
// loader's own overall timeout is 15s, so a 3s local timeout leaves room).

import {
  injectStyles, GaugeIcon, ServerIcon, MonitorIcon, DbIcon, BellIcon, ShieldIcon,
  ArrowRightLeftIcon, ClipboardListIcon, SparklesIcon, GearIcon,
} from './ui.jsx';

import OverviewPage from './pages/overview.jsx';
import ClustersPage from './pages/clusters.jsx';
import HostsPage from './pages/hosts.jsx';
import VmsPage from './pages/vms.jsx';
import StoragePage from './pages/storage.jsx';
import ProtectionPage from './pages/protection.jsx';
import AlertsPage from './pages/alerts.jsx';
import IssuesPage from './pages/issues.jsx';
import MovePage from './pages/move.jsx';
import AdvisorPage from './pages/advisor.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#7855FA';
const MOVE_PROBE_TIMEOUT_MS = 3000;

injectStyles();

function baseNavGroups(includeMove) {
  const dataProtectionItems = [
    { label: 'Protection & Replication', route: '/nutanix/protection', icon: ShieldIcon, isActive: (p) => p === '/nutanix/protection' },
  ];
  if (includeMove) {
    dataProtectionItems.push({ label: 'Move', route: '/nutanix/move', icon: ArrowRightLeftIcon, isActive: (p) => p === '/nutanix/move' });
  }
  return [
    {
      label: 'Monitor',
      items: [
        { label: 'Overview', route: '/nutanix', icon: GaugeIcon, isActive: (p) => p === '/nutanix' },
        { label: 'Clusters', route: '/nutanix/clusters', icon: ServerIcon, isActive: (p) => p === '/nutanix/clusters' },
        { label: 'Hosts', route: '/nutanix/hosts', icon: ServerIcon, isActive: (p) => p === '/nutanix/hosts' },
        { label: 'VMs', route: '/nutanix/vms', icon: MonitorIcon, isActive: (p) => p === '/nutanix/vms' },
        { label: 'Storage', route: '/nutanix/storage', icon: DbIcon, isActive: (p) => p === '/nutanix/storage' },
        { label: 'Alerts', route: '/nutanix/alerts', icon: BellIcon, isActive: (p) => p === '/nutanix/alerts' },
      ],
    },
    {
      label: 'Data Protection',
      items: dataProtectionItems,
    },
    {
      label: 'Audit',
      items: [
        { label: 'Issues & History', route: '/nutanix/issues', icon: ClipboardListIcon, isActive: (p) => p === '/nutanix/issues' },
        { label: 'AI Advisor', route: '/nutanix/advisor', icon: SparklesIcon, isActive: (p) => p === '/nutanix/advisor', requiresAi: true },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Settings', route: '/nutanix/settings', icon: GearIcon, isActive: (p) => p === '/nutanix/settings' },
      ],
    },
  ];
}

const routes = [
  { path: 'nutanix', Component: OverviewPage },
  { path: 'nutanix/clusters', Component: ClustersPage },
  { path: 'nutanix/hosts', Component: HostsPage },
  { path: 'nutanix/vms', Component: VmsPage },
  { path: 'nutanix/storage', Component: StoragePage },
  { path: 'nutanix/alerts', Component: AlertsPage },
  { path: 'nutanix/protection', Component: ProtectionPage },
  { path: 'nutanix/move', Component: MovePage },
  { path: 'nutanix/issues', Component: IssuesPage },
  { path: 'nutanix/advisor', Component: AdvisorPage },
  { path: 'nutanix/settings', Component: SettingsPage },
];

function register(includeMove) {
  window.__ICC_REGISTER_PLUGIN__({
    id: 'nutanix',
    label: 'Nutanix',
    color: ACCENT,
    switcherRoute: '/nutanix',
    basePath: '/nutanix',
    isActive: (p) => p.startsWith('/nutanix'),
    navGroups: baseNavGroups(includeMove),
    routes,
  });
}

function probeMoveConfigured() {
  if (typeof fetch !== 'function') return Promise.resolve(true);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), MOVE_PROBE_TIMEOUT_MS);
  return fetch('/api/nutanix/overview', { credentials: 'include', signal: controller?.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => (json && typeof json.moveConfigured === 'boolean' ? json.moveConfigured : true))
    .catch(() => true) // timeout / error → fall back to showing Move
    .finally(() => clearTimeout(timer));
}

probeMoveConfigured().then(register);
