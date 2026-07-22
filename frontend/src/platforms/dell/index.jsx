import { lazy } from 'react';
import { Gauge, Server, Settings, AlertTriangle, Wrench, BadgeCheck } from 'lucide-react';

const DellOverviewPage = lazy(() => import('../../pages/dell/DellOverviewPage'));
const DellDevicesPage = lazy(() => import('../../pages/dell/DellDevicesPage'));
const DellAlertsPage = lazy(() => import('../../pages/dell/DellAlertsPage'));
const DellHardwarePage = lazy(() => import('../../pages/dell/DellHardwarePage'));
const DellSupportPage = lazy(() => import('../../pages/dell/DellSupportPage'));
const DellSettingsPage = lazy(() => import('../../pages/dell/DellSettingsPage'));

// Dell OpenManage Enterprise sidebar — shown when the OME platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/dell', icon: Gauge, isActive: (p) => p === '/dell' },
      { label: 'Alerts', route: '/dell/alerts', icon: AlertTriangle, isActive: (p) => p.startsWith('/dell/alerts') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Devices', route: '/dell/devices', icon: Server, isActive: (p) => p.startsWith('/dell/devices') },
      { label: 'Hardware', route: '/dell/hardware', icon: Wrench, isActive: (p) => p.startsWith('/dell/hardware') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Support', route: '/dell/support', icon: BadgeCheck, isActive: (p) => p.startsWith('/dell/support') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/dell/settings', icon: Settings, isActive: (p) => p.startsWith('/dell/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/dell');
}

export default {
  id: 'dell',
  label: 'Dell',
  switcherRoute: '/dell',
  color: '#007DB8',
  basePath: '/dell',
  isActive,
  navGroups,
  routes: [
    { path: 'dell', Component: DellOverviewPage },
    { path: 'dell/devices', Component: DellDevicesPage },
    { path: 'dell/alerts', Component: DellAlertsPage },
    { path: 'dell/hardware', Component: DellHardwarePage },
    { path: 'dell/support', Component: DellSupportPage },
    { path: 'dell/settings', Component: DellSettingsPage },
  ],
};
