import { lazy } from 'react';
import { Gauge, Server, MonitorSmartphone, Database, ShieldCheck, Settings, Bell } from 'lucide-react';

const PxOverviewPage = lazy(() => import('../../pages/proxmox/PxOverviewPage'));
const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const PxAlertsPage = () => <IssueAlertsPage platform="proxmox" />;
const PxNodesPage = lazy(() => import('../../pages/proxmox/PxNodesPage'));
const PxGuestsPage = lazy(() => import('../../pages/proxmox/PxGuestsPage'));
const PxStoragePage = lazy(() => import('../../pages/proxmox/PxStoragePage'));
const PxBackupsPage = lazy(() => import('../../pages/proxmox/PxBackupsPage'));
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
    ],
  },
  {
    label: 'Data Protection',
    items: [
      { label: 'Backups', route: '/proxmox/backups', icon: ShieldCheck, isActive: (p) => p.startsWith('/proxmox/backups') },
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
    { path: 'proxmox/storage', Component: PxStoragePage },
    { path: 'proxmox/backups', Component: PxBackupsPage },
    { path: 'proxmox/settings', Component: PxSettingsPage },
  ],
};
