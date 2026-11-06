import { lazy } from 'react';
import {
  Gauge, Bell, ClipboardCheck, Sparkles, Server, Split, ShieldCheck, Settings,
} from 'lucide-react';
import { BRAND } from '../../pages/f5/f5Shared';

// F5 is a derived platform: no sources and no poller of its own. The rail entry
// appears while the LogicMonitor connector has devices ICC classified as F5.
const F5OverviewPage = lazy(() => import('../../pages/f5/F5OverviewPage'));
const F5DevicesPage = lazy(() => import('../../pages/f5/F5DevicesPage'));
const F5LoadBalancersPage = lazy(() => import('../../pages/f5/F5LoadBalancersPage'));
const F5AlertsPage = lazy(() => import('../../pages/f5/F5AlertsPage'));
const F5AdvisorPage = lazy(() => import('../../pages/f5/F5AdvisorPage'));
const F5SettingsPage = lazy(() => import('../../pages/f5/F5SettingsPage'));
const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const F5IssuesPage = () => <IssueAlertsPage platform="f5" />;
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const F5PrivacyPage = () => <PrivacyInspectorPage platform="f5" />;

const B = '/f5';
const under = (base) => (p) => p === base || p.startsWith(`${base}/`);

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: B, icon: Gauge, isActive: (p) => p === B },
      { label: 'Alerts', route: `${B}/alerts`, icon: Bell, isActive: under(`${B}/alerts`) },
      { label: 'Issues', route: `${B}/issues`, icon: ClipboardCheck, isActive: under(`${B}/issues`) },
      { label: 'AI Advisor', route: `${B}/advisor`, icon: Sparkles, isActive: under(`${B}/advisor`), requiresAi: true },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Devices', route: `${B}/devices`, icon: Server, isActive: under(`${B}/devices`) },
      { label: 'Load Balancers', route: `${B}/load-balancers`, icon: Split, isActive: under(`${B}/load-balancers`) },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: `${B}/privacy`, icon: ShieldCheck, isActive: under(`${B}/privacy`), requiresAi: true },
      { label: 'Settings', route: `${B}/settings`, icon: Settings, isActive: under(`${B}/settings`) },
    ],
  },
];

export default {
  id: 'f5',
  label: 'F5',
  switcherRoute: B,
  color: BRAND,
  basePath: B,
  derived: true,
  isActive: (pathname) => pathname === B || pathname.startsWith(`${B}/`),
  navGroups,
  routes: [
    { path: 'f5', Component: F5OverviewPage },
    { path: 'f5/alerts', Component: F5AlertsPage },
    { path: 'f5/issues', Component: F5IssuesPage },
    { path: 'f5/advisor', Component: F5AdvisorPage },
    { path: 'f5/devices', Component: F5DevicesPage },
    { path: 'f5/load-balancers', Component: F5LoadBalancersPage },
    { path: 'f5/privacy', Component: F5PrivacyPage },
    { path: 'f5/settings', Component: F5SettingsPage },
  ],
};
