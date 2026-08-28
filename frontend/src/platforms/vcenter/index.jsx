import { lazy } from 'react';
import { Gauge, Server, Database, Settings, MonitorSmartphone, Network, ClipboardCheck, History, Sparkles, ShieldCheck, Bell, Building2, TrendingUp, ArrowLeftRight } from 'lucide-react';

const VcOverviewPage = lazy(() => import('../../pages/vcenter/VcOverviewPage'));
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const VcPrivacyPage = () => <PrivacyInspectorPage platform="vcenter" />;
const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const VcAlertsPage = () => <IssueAlertsPage platform="vcenter" />;
const VcHostsPage = lazy(() => import('../../pages/vcenter/VcHostsPage'));
const VcDatastoresPage = lazy(() => import('../../pages/vcenter/VcDatastoresPage'));
const VcInventoryPage = lazy(() => import('../../pages/vcenter/VcInventoryPage'));
const VcNetworkPage = lazy(() => import('../../pages/vcenter/VcNetworkPage'));
const VcGovernancePage = lazy(() => import('../../pages/vcenter/VcGovernancePage'));
const VcEventsPage = lazy(() => import('../../pages/vcenter/VcEventsPage'));
const VcSettingsPage = lazy(() => import('../../pages/vcenter/VcSettingsPage'));
const VcAdvisorPage = lazy(() => import('../../pages/vcenter/VcAdvisorPage'));
const VcCapacityOverviewPage = lazy(() => import('../../pages/vcenter/VcCapacityOverviewPage'));
const VcCapacityTrendsPage = lazy(() => import('../../pages/vcenter/VcCapacityTrendsPage'));
const VcCapacityExplorerPage = lazy(() => import('../../pages/vcenter/VcCapacityExplorerPage'));

// VMware vCenter sidebar — shown when the vCenter platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/vcenter', icon: Gauge, isActive: (p) => p === '/vcenter' },
      { label: 'Alerts', route: '/vcenter/alerts', icon: Bell, isActive: (p) => p.startsWith('/vcenter/alerts') },
      { label: 'AI Advisor', route: '/vcenter/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/vcenter/advisor'), requiresAi: true },
      { label: 'Events', route: '/vcenter/events', icon: History, isActive: (p) => p.startsWith('/vcenter/events') },
    ],
  },
  {
    label: 'Capacity',
    items: [
      { label: 'Site Capacity', route: '/vcenter/capacity', icon: Building2, isActive: (p) => p === '/vcenter/capacity' },
      { label: 'Trends', route: '/vcenter/capacity/trends', icon: TrendingUp, isActive: (p) => p.startsWith('/vcenter/capacity/trends') },
      { label: 'Failover Explorer', route: '/vcenter/capacity/explorer', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/vcenter/capacity/explorer') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'ESX Hosts', route: '/vcenter/hosts', icon: Server, isActive: (p) => p.startsWith('/vcenter/hosts') },
      { label: 'VM Inventory', route: '/vcenter/inventory', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/vcenter/inventory') },
      { label: 'Datastores', route: '/vcenter/datastores', icon: Database, isActive: (p) => p.startsWith('/vcenter/datastores') },
      { label: 'Network', route: '/vcenter/network', icon: Network, isActive: (p) => p.startsWith('/vcenter/network') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Governance', route: '/vcenter/governance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/vcenter/governance') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: '/vcenter/privacy', icon: ShieldCheck, isActive: (p) => p.startsWith('/vcenter/privacy'), requiresAi: true },
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
    { path: 'vcenter/alerts', Component: VcAlertsPage },
    { path: 'vcenter/capacity', Component: VcCapacityOverviewPage },
    { path: 'vcenter/capacity/trends', Component: VcCapacityTrendsPage },
    { path: 'vcenter/capacity/explorer', Component: VcCapacityExplorerPage },
    { path: 'vcenter/hosts', Component: VcHostsPage },
    { path: 'vcenter/inventory', Component: VcInventoryPage },
    { path: 'vcenter/datastores', Component: VcDatastoresPage },
    { path: 'vcenter/network', Component: VcNetworkPage },
    { path: 'vcenter/events', Component: VcEventsPage },
    { path: 'vcenter/governance', Component: VcGovernancePage },
    { path: 'vcenter/advisor', Component: VcAdvisorPage },
    { path: 'vcenter/privacy', Component: VcPrivacyPage },
    { path: 'vcenter/settings', Component: VcSettingsPage },
  ],
};
