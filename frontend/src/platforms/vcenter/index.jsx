import { lazy } from 'react';
import { Gauge, Server, Database, Settings, MonitorSmartphone, Network, ClipboardCheck, History } from 'lucide-react';

const VcOverviewPage = lazy(() => import('../../pages/vcenter/VcOverviewPage'));
const VcHostsPage = lazy(() => import('../../pages/vcenter/VcHostsPage'));
const VcDatastoresPage = lazy(() => import('../../pages/vcenter/VcDatastoresPage'));
const VcInventoryPage = lazy(() => import('../../pages/vcenter/VcInventoryPage'));
const VcNetworkPage = lazy(() => import('../../pages/vcenter/VcNetworkPage'));
const VcGovernancePage = lazy(() => import('../../pages/vcenter/VcGovernancePage'));
const VcEventsPage = lazy(() => import('../../pages/vcenter/VcEventsPage'));
const VcSettingsPage = lazy(() => import('../../pages/vcenter/VcSettingsPage'));

// VMware vCenter sidebar — shown when the vCenter platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/vcenter', icon: Gauge, isActive: (p) => p === '/vcenter' },
      { label: 'ESX Hosts', route: '/vcenter/hosts', icon: Server, isActive: (p) => p.startsWith('/vcenter/hosts') },
      { label: 'VM Inventory', route: '/vcenter/inventory', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/vcenter/inventory') },
      { label: 'Datastores', route: '/vcenter/datastores', icon: Database, isActive: (p) => p.startsWith('/vcenter/datastores') },
      { label: 'Network', route: '/vcenter/network', icon: Network, isActive: (p) => p.startsWith('/vcenter/network') },
      { label: 'Events', route: '/vcenter/events', icon: History, isActive: (p) => p.startsWith('/vcenter/events') },
      { label: 'Governance', route: '/vcenter/governance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/vcenter/governance') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/vcenter/settings', icon: Settings, isActive: (p) => p.startsWith('/vcenter/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/vcenter');
}

export default {
  id: 'vcenter',
  label: 'vCenter',
  switcherRoute: '/vcenter',
  color: '#0091DA',
  basePath: '/vcenter',
  isActive,
  navGroups,
  routes: [
    { path: 'vcenter', Component: VcOverviewPage },
    { path: 'vcenter/hosts', Component: VcHostsPage },
    { path: 'vcenter/inventory', Component: VcInventoryPage },
    { path: 'vcenter/datastores', Component: VcDatastoresPage },
    { path: 'vcenter/network', Component: VcNetworkPage },
    { path: 'vcenter/events', Component: VcEventsPage },
    { path: 'vcenter/governance', Component: VcGovernancePage },
    { path: 'vcenter/settings', Component: VcSettingsPage },
  ],
};
