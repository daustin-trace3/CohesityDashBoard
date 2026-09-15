import { lazy } from 'react';
import { Gauge, Boxes, AlertTriangle, Settings, Sparkles, ShieldCheck } from 'lucide-react';

const AriaOpsOverviewPage = lazy(() => import('../../pages/ariaops/OverviewPage'));
const AriaOpsResourcesPage = lazy(() => import('../../pages/ariaops/ResourcesPage'));
const AriaOpsAlertsPage = lazy(() => import('../../pages/ariaops/AlertsPage'));
const AriaOpsSettingsPage = lazy(() => import('../../pages/ariaops/SettingsPage'));
const AriaOpsAdvisorPage = lazy(() => import('../../pages/ariaops/AriaopsAdvisorPage'));
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const AriaOpsPrivacyPage = () => <PrivacyInspectorPage platform="ariaops" />;

// Aria Operations sidebar — shown when the Aria Operations platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/ariaops', icon: Gauge, isActive: (p) => p === '/ariaops' },
      { label: 'AI Advisor', route: '/ariaops/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/ariaops/advisor'), requiresAi: true },
      { label: 'Resources', route: '/ariaops/resources', icon: Boxes, isActive: (p) => p.startsWith('/ariaops/resources') },
      { label: 'Alerts', route: '/ariaops/alerts', icon: AlertTriangle, isActive: (p) => p.startsWith('/ariaops/alerts') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: '/ariaops/privacy', icon: ShieldCheck, isActive: (p) => p.startsWith('/ariaops/privacy'), requiresAi: true },
      { label: 'Settings', route: '/ariaops/settings', icon: Settings, isActive: (p) => p.startsWith('/ariaops/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname === '/ariaops' || pathname.startsWith('/ariaops/');
}

export default {
  id: 'ariaops',
  label: 'Aria Ops',
  switcherRoute: '/ariaops',
  color: '#78BE20',
  basePath: '/ariaops',
  isActive,
  navGroups,
  routes: [
    { path: 'ariaops', Component: AriaOpsOverviewPage },
    { path: 'ariaops/resources', Component: AriaOpsResourcesPage },
    { path: 'ariaops/alerts', Component: AriaOpsAlertsPage },
    { path: 'ariaops/advisor', Component: AriaOpsAdvisorPage },
    { path: 'ariaops/privacy', Component: AriaOpsPrivacyPage },
    { path: 'ariaops/settings', Component: AriaOpsSettingsPage },
  ],
};
