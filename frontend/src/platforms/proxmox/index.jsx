import { lazy } from 'react';
import { Gauge, Server, MonitorSmartphone, Database, ShieldCheck, Settings, Bell, Network, History } from 'lucide-react';

const PxOverviewPage = lazy(() => import('../../pages/proxmox/PxOverviewPage'));
const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const PxAlertsPage = () => <IssueAlertsPage platform="proxmox" />;
const PxNodesPage = lazy(() => import('../../pages/proxmox/PxNodesPage'));
const PxGuestsPage = lazy(() => import('../../pages/proxmox/PxGuestsPage'));
const PxGuest360Page = lazy(() => import('../../pages/proxmox/PxGuest360Page'));
const PxStoragePage = lazy(() => import('../../pages/proxmox/PxStoragePage'));
const PxBackupsPage = lazy(() => import('../../pages/proxmox/PxBackupsPage'));
const PxNetworkPage = lazy(() => import('../../pages/proxmox/PxNetworkPage'));
const PxEventsPage = lazy(() => import('../../pages/proxmox/PxEventsPage'));
const PxSettingsPage = lazy(() => import('../../pages/proxmox/PxSettingsPage'));

// Proxmox VE sidebar — shown when the Proxmox platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/proxmox', icon: Gauge, isActive: (p) => p === '/proxmox' },
      { label: 'Alerts', route: '/proxmox/alerts', icon: Bell, isActive: (p) => p.startsWith('/proxmox/alerts') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Nodes', route: '/proxmox/nodes', icon: Server, isActive: (p) => p.startsWith('/proxmox/nodes') },
      { label: 'Guests', route: '/proxmox/guests', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/proxmox/guests') },
      { label: 'Storage', route: '/proxmox/storage', icon: Database, isActive: (p) => p.startsWith('/proxmox/storage') },
      { label: 'Network', route: '/proxmox/network', icon: Network, isActive: (p) => p.startsWith('/proxmox/network') },
    ],
  },
  {
    label: 'Data Protection',
    items: [
      { label: 'Backups', route: '/proxmox/backups', icon: ShieldCheck, isActive: (p) => p.startsWith('/proxmox/backups') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Events', route: '/proxmox/events', icon: History, isActive: (p) => p.startsWith('/proxmox/events') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/proxmox/settings', icon: Settings, isActive: (p) => p.startsWith('/proxmox/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/proxmox');
}

export default {
  id: 'proxmox',
  label: 'Proxmox VE',
  switcherRoute: '/proxmox',
  color: '#E57000',
  basePath: '/proxmox',
  isActive,
  navGroups,
  routes: [
    { path: 'proxmox', Component: PxOverviewPage },
    { path: 'proxmox/alerts', Component: PxAlertsPage },
    { path: 'proxmox/nodes', Component: PxNodesPage },
    { path: 'proxmox/guests', Component: PxGuestsPage },
    { path: 'proxmox/guests/:id', Component: PxGuest360Page },
    { path: 'proxmox/storage', Component: PxStoragePage },
    { path: 'proxmox/backups', Component: PxBackupsPage },
    { path: 'proxmox/network', Component: PxNetworkPage },
    { path: 'proxmox/events', Component: PxEventsPage },
    { path: 'proxmox/settings', Component: PxSettingsPage },
  ],
};
