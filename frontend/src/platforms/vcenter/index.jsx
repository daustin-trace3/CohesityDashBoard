import { lazy } from 'react';
import { Gauge, Server, Database, Settings, MonitorSmartphone } from 'lucide-react';

const VcOverviewPage = lazy(() => import('../../pages/vcenter/VcOverviewPage'));
const VcHostsPage = lazy(() => import('../../pages/vcenter/VcHostsPage'));
const VcDatastoresPage = lazy(() => import('../../pages/vcenter/VcDatastoresPage'));
const VcInventoryPage = lazy(() => import('../../pages/vcenter/VcInventoryPage'));
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
    { path: 'vcenter/settings', Component: VcSettingsPage },
  ],
};
