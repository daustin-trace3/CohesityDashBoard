import { lazy } from 'react';
import {
  Gauge, Database, Layers, Network, FolderTree, Bell, ArrowLeftRight, HardDrive, Settings, Sparkles, ShieldCheck, Cable,
} from 'lucide-react';

const NetAppOverviewPage = lazy(() => import('../../pages/netapp/NetAppOverviewPage'));
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const NetAppPrivacyPage = () => <PrivacyInspectorPage platform="netapp" />;
const NetAppCapacityPage = lazy(() => import('../../pages/netapp/NetAppCapacityPage'));
const NetAppVolumesPage = lazy(() => import('../../pages/netapp/NetAppVolumesPage'));
const NetAppNfsPage = lazy(() => import('../../pages/netapp/NetAppNfsPage'));
const NetAppCifsPage = lazy(() => import('../../pages/netapp/NetAppCifsPage'));
const NetAppMountsPage = lazy(() => import('../../pages/netapp/NetAppMountsPage'));
const NetAppReplicationPage = lazy(() => import('../../pages/netapp/NetAppReplicationPage'));
const NetAppAlertsPage = lazy(() => import('../../pages/netapp/NetAppAlertsPage'));
const NetAppHardwarePage = lazy(() => import('../../pages/netapp/NetAppHardwarePage'));
const NetAppSettingsPage = lazy(() => import('../../pages/netapp/NetAppSettingsPage'));
const NetAppAdvisorPage = lazy(() => import('../../pages/netapp/NetAppAdvisorPage'));

// NetApp ONTAP sidebar — shown when the NetApp platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/netapp', icon: Gauge, isActive: (p) => p === '/netapp' },
      { label: 'AI Advisor', route: '/netapp/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/netapp/advisor'), requiresAi: true },
      { label: 'Capacity', route: '/netapp/capacity', icon: Database, isActive: (p) => p.startsWith('/netapp/capacity') },
      { label: 'Volumes', route: '/netapp/volumes', icon: Layers, isActive: (p) => p.startsWith('/netapp/volumes') },
      { label: 'Alerts', route: '/netapp/alerts', icon: Bell, isActive: (p) => p.startsWith('/netapp/alerts') },
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
      { label: 'Privacy Inspector', route: '/netapp/privacy', icon: ShieldCheck, isActive: (p) => p.startsWith('/netapp/privacy'), requiresAi: true },
      { label: 'Settings', route: '/netapp/settings', icon: Settings, isActive: (p) => p.startsWith('/netapp/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/netapp');
}

export default {
  id: 'netapp',
  label: 'NetApp',
  switcherRoute: '/netapp',
  color: '#0067C5',
  basePath: '/netapp',
  isActive,
  navGroups,
  routes: [
    { path: 'netapp', Component: NetAppOverviewPage },
    { path: 'netapp/capacity', Component: NetAppCapacityPage },
    { path: 'netapp/volumes', Component: NetAppVolumesPage },
    { path: 'netapp/nfs', Component: NetAppNfsPage },
    { path: 'netapp/cifs', Component: NetAppCifsPage },
    { path: 'netapp/mounts', Component: NetAppMountsPage },
    { path: 'netapp/replication', Component: NetAppReplicationPage },
    { path: 'netapp/alerts', Component: NetAppAlertsPage },
    { path: 'netapp/hardware', Component: NetAppHardwarePage },
    { path: 'netapp/advisor', Component: NetAppAdvisorPage },
    { path: 'netapp/privacy', Component: NetAppPrivacyPage },
    { path: 'netapp/settings', Component: NetAppSettingsPage },
  ],
};
