import { lazy } from 'react';
import { Gauge, Package, Activity, Server, Puzzle, CheckSquare, Settings, DiscAlbum, Sparkles, ShieldCheck, MonitorSmartphone } from 'lucide-react';

const AriaOverviewPage = lazy(() => import('../../pages/aria/AriaOverviewPage'));
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const AriaPrivacyPage = () => <PrivacyInspectorPage platform="aria" />;
const AriaDeploymentsPage = lazy(() => import('../../pages/aria/AriaDeploymentsPage'));
const AriaActivityPage = lazy(() => import('../../pages/aria/AriaActivityPage'));
const AriaInfrastructurePage = lazy(() => import('../../pages/aria/AriaInfrastructurePage'));
const AriaExtensibilityPage = lazy(() => import('../../pages/aria/AriaExtensibilityPage'));
const AriaApprovalsPage = lazy(() => import('../../pages/aria/AriaApprovalsPage'));
const AriaSettingsPage = lazy(() => import('../../pages/aria/AriaSettingsPage'));
const AriaImagesAuditPage = lazy(() => import('../../pages/aria/AriaImagesAuditPage'));
const AriaAdvisorPage = lazy(() => import('../../pages/aria/AriaAdvisorPage'));
const AriaAppliancesPage = lazy(() => import('../../pages/aria/AriaAppliancesPage'));

// VMware Aria Automation sidebar — shown when the Aria platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/aria', icon: Gauge, isActive: (p) => p === '/aria' },
      { label: 'AI Advisor', route: '/aria/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/aria/advisor'), requiresAi: true },
      { label: 'Deployments', route: '/aria/deployments', icon: Package, isActive: (p) => p.startsWith('/aria/deployments') },
      { label: 'Activity', route: '/aria/activity', icon: Activity, isActive: (p) => p.startsWith('/aria/activity') },
      { label: 'Infrastructure', route: '/aria/infrastructure', icon: Server, isActive: (p) => p.startsWith('/aria/infrastructure') },
      { label: 'Appliances', route: '/aria/appliances', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/aria/appliances') },
      { label: 'Extensibility', route: '/aria/extensibility', icon: Puzzle, isActive: (p) => p.startsWith('/aria/extensibility') },
      { label: 'Approvals', route: '/aria/approvals', icon: CheckSquare, isActive: (p) => p.startsWith('/aria/approvals') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Images', route: '/aria/images', icon: DiscAlbum, isActive: (p) => p.startsWith('/aria/images') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: '/aria/privacy', icon: ShieldCheck, isActive: (p) => p.startsWith('/aria/privacy'), requiresAi: true },
      { label: 'Settings', route: '/aria/settings', icon: Settings, isActive: (p) => p.startsWith('/aria/settings') },
    ],
  },
];

function isActive(pathname) {
  // 'ariaops' contains 'aria' — don't let /ariaops/* match this platform.
  return pathname === '/aria' || pathname.startsWith('/aria/');
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
    { path: 'aria/images', Component: AriaImagesAuditPage },
    { path: 'aria/advisor', Component: AriaAdvisorPage },
    { path: 'aria/appliances', Component: AriaAppliancesPage },
    { path: 'aria/privacy', Component: AriaPrivacyPage },
    { path: 'aria/settings', Component: AriaSettingsPage },
  ],
};
