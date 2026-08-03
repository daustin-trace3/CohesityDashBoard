// Proxmox VE plugin frontend module (ICC contract C9.1). Bundled as an IIFE
// with no ESM imports at runtime — React/ReactDOM/ReactRouterDOM come from
// window globals (injected by the build banner + host, see
// plugin-sdk/build.mjs and frontend/src/main.jsx). No Tailwind, no
// Chart.js: styled via the injected px- stylesheet (./ui.jsx) and
// hand-rolled inline-SVG charts (./charts.jsx) exclusively.
//
// Mirrors the built-in platform's nav groups (Monitor/Infrastructure/Data
// Protection/Audit/System) and routes 1:1 — see
// frontend/src/platforms/proxmox/index.jsx (host, pre-removal) for the
// source of truth this was ported from.

import { injectStyles } from './ui.jsx';

import OverviewPage from './pages/overview.jsx';
import AlertsPage from './pages/alerts.jsx';
import NodesPage from './pages/nodes.jsx';
import GuestsPage from './pages/guests.jsx';
import Guest360Page from './pages/guest360.jsx';
import StoragePage from './pages/storage.jsx';
import BackupsPage from './pages/backups.jsx';
import NetworkPage from './pages/network.jsx';
import EventsPage from './pages/events.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#E57000';

injectStyles();

window.__ICC_REGISTER_PLUGIN__({
  id: 'proxmox',
  label: 'Proxmox VE',
  color: ACCENT,
  switcherRoute: '/proxmox',
  basePath: '/proxmox',
  isActive: (p) => p.startsWith('/proxmox'),
  navGroups: [
    {
      label: 'Monitor',
      items: [
        { label: 'Overview', route: '/proxmox', isActive: (p) => p === '/proxmox' },
        { label: 'Alerts', route: '/proxmox/alerts', isActive: (p) => p.startsWith('/proxmox/alerts') },
      ],
    },
    {
      label: 'Infrastructure',
      items: [
        { label: 'Nodes', route: '/proxmox/nodes', isActive: (p) => p.startsWith('/proxmox/nodes') },
        { label: 'Guests', route: '/proxmox/guests', isActive: (p) => p.startsWith('/proxmox/guests') },
        { label: 'Storage', route: '/proxmox/storage', isActive: (p) => p.startsWith('/proxmox/storage') },
        { label: 'Network', route: '/proxmox/network', isActive: (p) => p.startsWith('/proxmox/network') },
      ],
    },
    {
      label: 'Data Protection',
      items: [
        { label: 'Backups', route: '/proxmox/backups', isActive: (p) => p.startsWith('/proxmox/backups') },
      ],
    },
    {
      label: 'Audit',
      items: [
        { label: 'Events', route: '/proxmox/events', isActive: (p) => p.startsWith('/proxmox/events') },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Settings', route: '/proxmox/settings', isActive: (p) => p.startsWith('/proxmox/settings') },
      ],
    },
  ],
  routes: [
    { path: 'proxmox', Component: OverviewPage },
    { path: 'proxmox/alerts', Component: AlertsPage },
    { path: 'proxmox/nodes', Component: NodesPage },
    { path: 'proxmox/guests', Component: GuestsPage },
    { path: 'proxmox/guests/:id', Component: Guest360Page },
    { path: 'proxmox/storage', Component: StoragePage },
    { path: 'proxmox/backups', Component: BackupsPage },
    { path: 'proxmox/network', Component: NetworkPage },
    { path: 'proxmox/events', Component: EventsPage },
    { path: 'proxmox/settings', Component: SettingsPage },
  ],
});
