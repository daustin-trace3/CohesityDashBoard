import { lazy } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Cloud, LayoutList, Database, Layers, Bell, ArrowLeftRight, HardDrive, Network, Settings, Sparkles,
} from 'lucide-react';

const PureAlertsPage = lazy(() => import('../../pages/pure/PureAlertsPage'));
const Pure1FleetPage = lazy(() => import('../../pages/pure/Pure1FleetPage'));
const PureCapacityPage = lazy(() => import('../../pages/pure/PureCapacityPage'));
const PureVolumesPage = lazy(() => import('../../pages/pure/PureVolumesPage'));
const PureReplicationPage = lazy(() => import('../../pages/pure/PureReplicationPage'));
const PureHardwarePage = lazy(() => import('../../pages/pure/PureHardwarePage'));
const PureConnectivityPage = lazy(() => import('../../pages/pure/PureConnectivityPage'));
const PureSettingsPage = lazy(() => import('../../pages/pure/PureSettingsPage'));
const PureEstatePage = lazy(() => import('../../pages/pure/PureEstatePage'));
const PureAdvisorPage = lazy(() => import('../../pages/pure/PureAdvisorPage'));

// Pure Storage sidebar — shown when the Pure platform is active. Grouped into
// sections that mirror the Cohesity menu.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/pure', icon: Cloud, isActive: (p) => p === '/pure' },
      { label: 'AI Advisor', route: '/pure/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/pure/advisor'), requiresAi: true },      { label: 'Estate', route: '/pure/estate', icon: LayoutList, isActive: (p) => p.startsWith('/pure/estate') },      { label: 'Capacity', route: '/pure/capacity', icon: Database, isActive: (p) => p.startsWith('/pure/capacity') },
      { label: 'Volumes', route: '/pure/volumes', icon: Layers, isActive: (p) => p.startsWith('/pure/volumes') },
      { label: 'Alerts', route: '/pure/alerts', icon: Bell, isActive: (p) => p.startsWith('/pure/alerts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Replication', route: '/pure/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/pure/replication') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Hardware', route: '/pure/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/pure/hardware') },
      { label: 'Connectivity', route: '/pure/connectivity', icon: Network, isActive: (p) => p.startsWith('/pure/connectivity') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/pure/settings', icon: Settings, isActive: (p) => p.startsWith('/pure/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/pure');
}

export default {
  id: 'pure',
  label: 'Pure',
  switcherRoute: '/pure',
  color: '#FF6B00',
  basePath: '/pure',
  isActive,
  navGroups,
  routes: [
    { path: 'pure', Component: Pure1FleetPage },
    { path: 'pure/estate', Component: PureEstatePage },
    { path: 'pure/fleet', element: <Navigate to="/pure" replace /> },
    { path: 'pure/capacity', Component: PureCapacityPage },
    { path: 'pure/volumes', Component: PureVolumesPage },
    { path: 'pure/replication', Component: PureReplicationPage },
    { path: 'pure/hardware', Component: PureHardwarePage },
    { path: 'pure/connectivity', Component: PureConnectivityPage },
    { path: 'pure/alerts', Component: PureAlertsPage },
    { path: 'pure/advisor', Component: PureAdvisorPage },
    { path: 'pure/settings', Component: PureSettingsPage },
  ],
};
