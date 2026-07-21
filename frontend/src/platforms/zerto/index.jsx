import { lazy } from 'react';
import { Gauge, ShieldCheck, Globe2, Bell, MonitorSmartphone, Settings, ArrowLeftRight } from 'lucide-react';

const ZertoOverviewPage = lazy(() => import('../../pages/zerto/ZertoOverviewPage'));
const ZertoVpgsPage = lazy(() => import('../../pages/zerto/ZertoVpgsPage'));
const ZertoSitesPage = lazy(() => import('../../pages/zerto/ZertoSitesPage'));
const ZertoAlertsPage = lazy(() => import('../../pages/zerto/ZertoAlertsPage'));
const ZertoVmsPage = lazy(() => import('../../pages/zerto/ZertoVmsPage'));
const ZertoReplicationPage = lazy(() => import('../../pages/zerto/ZertoReplicationPage'));
const ZertoSettingsPage = lazy(() => import('../../pages/zerto/ZertoSettingsPage'));

// Zerto sidebar — shown when the Zerto platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/zerto', icon: Gauge, isActive: (p) => p === '/zerto' },
      { label: 'Alerts', route: '/zerto/alerts', icon: Bell, isActive: (p) => p.startsWith('/zerto/alerts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'VPGs', route: '/zerto/vpgs', icon: ShieldCheck, isActive: (p) => p.startsWith('/zerto/vpgs') },
      { label: 'Replication', route: '/zerto/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/zerto/replication') },
      { label: 'Protected VMs', route: '/zerto/vms', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/zerto/vms') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Sites', route: '/zerto/sites', icon: Globe2, isActive: (p) => p.startsWith('/zerto/sites') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/zerto/settings', icon: Settings, isActive: (p) => p.startsWith('/zerto/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/zerto');
}

export default {
  id: 'zerto',
  label: 'Zerto',
  switcherRoute: '/zerto',
  color: '#EE3124',
  basePath: '/zerto',
  isActive,
  navGroups,
  routes: [
    { path: 'zerto', Component: ZertoOverviewPage },
    { path: 'zerto/vpgs', Component: ZertoVpgsPage },
    { path: 'zerto/replication', Component: ZertoReplicationPage },
    { path: 'zerto/sites', Component: ZertoSitesPage },
    { path: 'zerto/alerts', Component: ZertoAlertsPage },
    { path: 'zerto/vms', Component: ZertoVmsPage },
    { path: 'zerto/settings', Component: ZertoSettingsPage },
  ],
};
