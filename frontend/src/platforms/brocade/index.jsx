import { lazy } from 'react';
import {
  Gauge, Waypoints, Router, Cable, HardDrive, Network, AlertTriangle, ClipboardCheck,
  LineChart, ShieldCheck, Settings, Grid3x3,
} from 'lucide-react';

const BrocadeOverviewPage = lazy(() => import('../../pages/brocade/BrocadeOverviewPage'));
const BrocadeFabricsPage = lazy(() => import('../../pages/brocade/BrocadeFabricsPage'));
const BrocadeSwitchesPage = lazy(() => import('../../pages/brocade/BrocadeSwitchesPage'));
const BrocadePortsPage = lazy(() => import('../../pages/brocade/BrocadePortsPage'));
const BrocadePortMapPage = lazy(() => import('../../pages/brocade/BrocadePortMapPage'));
const BrocadeDevicesPage = lazy(() => import('../../pages/brocade/BrocadeDevicesPage'));
const BrocadeZoningPage = lazy(() => import('../../pages/brocade/BrocadeZoningPage'));
const BrocadeEventsPage = lazy(() => import('../../pages/brocade/BrocadeEventsPage'));
const BrocadeTrendsPage = lazy(() => import('../../pages/brocade/BrocadeTrendsPage'));
const BrocadeGovernancePage = lazy(() => import('../../pages/brocade/BrocadeGovernancePage'));
const BrocadeSettingsPage = lazy(() => import('../../pages/brocade/BrocadeSettingsPage'));
const BrocadeIssuesPage = lazy(() => import('../../pages/brocade/BrocadeIssuesPage'));

// Brocade SAN sidebar — shown when the Brocade SANnav platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/brocade', icon: Gauge, isActive: (p) => p === '/brocade' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Fabrics', route: '/brocade/fabrics', icon: Waypoints, isActive: (p) => p.startsWith('/brocade/fabrics') },
      { label: 'Switches', route: '/brocade/switches', icon: Router, isActive: (p) => p.startsWith('/brocade/switches') },
      { label: 'Ports', route: '/brocade/ports', icon: Cable, isActive: (p) => p.startsWith('/brocade/ports') },
      { label: 'Port Map', route: '/brocade/portmap', icon: Grid3x3, isActive: (p) => p.startsWith('/brocade/portmap') },
      { label: 'Devices & Enclosures', route: '/brocade/devices', icon: HardDrive, isActive: (p) => p.startsWith('/brocade/devices') },
    ],
  },
  {
    label: 'Zoning',
    items: [
      { label: 'Zoning', route: '/brocade/zoning', icon: Network, isActive: (p) => p.startsWith('/brocade/zoning') },
    ],
  },
  {
    label: 'Alarms',
    items: [
      { label: 'Events', route: '/brocade/events', icon: AlertTriangle, isActive: (p) => p.startsWith('/brocade/events') },
      { label: 'Issues & Alerts', route: '/brocade/issues', icon: ClipboardCheck, isActive: (p) => p.startsWith('/brocade/issues') },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { label: 'Trends', route: '/brocade/trends', icon: LineChart, isActive: (p) => p.startsWith('/brocade/trends') },
      { label: 'Governance', route: '/brocade/governance', icon: ShieldCheck, isActive: (p) => p.startsWith('/brocade/governance') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/brocade/settings', icon: Settings, isActive: (p) => p.startsWith('/brocade/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/brocade');
}

export default {
  id: 'brocade',
  label: 'Brocade SAN',
  switcherRoute: '/brocade',
  color: '#CC092F',
  basePath: '/brocade',
  isActive,
  navGroups,
  routes: [
    { path: 'brocade', Component: BrocadeOverviewPage },
    { path: 'brocade/fabrics', Component: BrocadeFabricsPage },
    { path: 'brocade/switches', Component: BrocadeSwitchesPage },
    { path: 'brocade/ports', Component: BrocadePortsPage },
    { path: 'brocade/portmap', Component: BrocadePortMapPage },
    { path: 'brocade/devices', Component: BrocadeDevicesPage },
    { path: 'brocade/zoning', Component: BrocadeZoningPage },
    { path: 'brocade/events', Component: BrocadeEventsPage },
    { path: 'brocade/issues', Component: BrocadeIssuesPage },
    { path: 'brocade/trends', Component: BrocadeTrendsPage },
    { path: 'brocade/governance', Component: BrocadeGovernancePage },
    { path: 'brocade/settings', Component: BrocadeSettingsPage },
  ],
};
