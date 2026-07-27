import { lazy } from 'react';
import { Gauge, Package, Activity, Server, Puzzle, CheckSquare, Settings } from 'lucide-react';

const AriaOverviewPage = lazy(() => import('../../pages/aria/AriaOverviewPage'));
const AriaDeploymentsPage = lazy(() => import('../../pages/aria/AriaDeploymentsPage'));
const AriaActivityPage = lazy(() => import('../../pages/aria/AriaActivityPage'));
const AriaInfrastructurePage = lazy(() => import('../../pages/aria/AriaInfrastructurePage'));
const AriaExtensibilityPage = lazy(() => import('../../pages/aria/AriaExtensibilityPage'));
const AriaApprovalsPage = lazy(() => import('../../pages/aria/AriaApprovalsPage'));
const AriaSettingsPage = lazy(() => import('../../pages/aria/AriaSettingsPage'));

// VMware Aria Automation sidebar — shown when the Aria platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/aria', icon: Gauge, isActive: (p) => p === '/aria' },
      { label: 'Deployments', route: '/aria/deployments', icon: Package, isActive: (p) => p.startsWith('/aria/deployments') },
      { label: 'Activity', route: '/aria/activity', icon: Activity, isActive: (p) => p.startsWith('/aria/activity') },
      { label: 'Infrastructure', route: '/aria/infrastructure', icon: Server, isActive: (p) => p.startsWith('/aria/infrastructure') },
      { label: 'Extensibility', route: '/aria/extensibility', icon: Puzzle, isActive: (p) => p.startsWith('/aria/extensibility') },
      { label: 'Approvals', route: '/aria/approvals', icon: CheckSquare, isActive: (p) => p.startsWith('/aria/approvals') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/aria/settings', icon: Settings, isActive: (p) => p.startsWith('/aria/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/aria');
}

export default {
  id: 'aria',
  label: 'Aria Automation',
  switcherRoute: '/aria',
  color: '#00A2C7',
  basePath: '/aria',
  isActive,
  navGroups,
  routes: [
    { path: 'aria', Component: AriaOverviewPage },
    { path: 'aria/deployments', Component: AriaDeploymentsPage },
    { path: 'aria/activity', Component: AriaActivityPage },
    { path: 'aria/infrastructure', Component: AriaInfrastructurePage },
    { path: 'aria/extensibility', Component: AriaExtensibilityPage },
    { path: 'aria/approvals', Component: AriaApprovalsPage },
    { path: 'aria/settings', Component: AriaSettingsPage },
  ],
};
