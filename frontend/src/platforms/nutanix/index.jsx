import { lazy } from 'react';
import {
  Gauge, Server, Database, Settings, MonitorSmartphone, ShieldCheck, Sparkles, Bell,
  ArrowRightLeft, ClipboardCheck,
} from 'lucide-react';

const NxOverviewPage = lazy(() => import('../../pages/nutanix/NxOverviewPage'));
const NxClustersPage = lazy(() => import('../../pages/nutanix/NxClustersPage'));
const NxHostsPage = lazy(() => import('../../pages/nutanix/NxHostsPage'));
const NxVMsPage = lazy(() => import('../../pages/nutanix/NxVMsPage'));
const NxStoragePage = lazy(() => import('../../pages/nutanix/NxStoragePage'));
const NxAlertsPage = lazy(() => import('../../pages/nutanix/NxAlertsPage'));
const NxProtectionPage = lazy(() => import('../../pages/nutanix/NxProtectionPage'));
const NxMovePage = lazy(() => import('../../pages/nutanix/NxMovePage'));
const NxAdvisorPage = lazy(() => import('../../pages/nutanix/NxAdvisorPage'));
const NxSettingsPage = lazy(() => import('../../pages/nutanix/NxSettingsPage'));

const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const NxIssuesPage = () => <IssueAlertsPage platform="nutanix" />;
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const NxPrivacyPage = () => <PrivacyInspectorPage platform="nutanix" />;

// Nutanix sidebar — shown when the Nutanix platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/nutanix', icon: Gauge, isActive: (p) => p === '/nutanix' },
      { label: 'Clusters', route: '/nutanix/clusters', icon: Server, isActive: (p) => p.startsWith('/nutanix/clusters') },
      { label: 'Hosts', route: '/nutanix/hosts', icon: Server, isActive: (p) => p.startsWith('/nutanix/hosts') },
      { label: 'VMs', route: '/nutanix/vms', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/nutanix/vms') },
      { label: 'Storage', route: '/nutanix/storage', icon: Database, isActive: (p) => p.startsWith('/nutanix/storage') },
      { label: 'Alerts', route: '/nutanix/alerts', icon: Bell, isActive: (p) => p.startsWith('/nutanix/alerts') },
    ],
  },
  {
    label: 'Data Protection',
    items: [
      { label: 'Protection & Replication', route: '/nutanix/protection', icon: ShieldCheck, isActive: (p) => p.startsWith('/nutanix/protection') },
      { label: 'Move', route: '/nutanix/move', icon: ArrowRightLeft, isActive: (p) => p.startsWith('/nutanix/move'), feature: 'move' },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Issues & Alerts', route: '/nutanix/issues', icon: ClipboardCheck, isActive: (p) => p.startsWith('/nutanix/issues') },
      { label: 'AI Advisor', route: '/nutanix/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/nutanix/advisor'), requiresAi: true },
      { label: 'Privacy Inspector', route: '/nutanix/privacy', icon: ShieldCheck, isActive: (p) => p.startsWith('/nutanix/privacy'), requiresAi: true },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/nutanix/settings', icon: Settings, isActive: (p) => p.startsWith('/nutanix/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/nutanix');
}

export default {
  id: 'nutanix',
  label: 'Nutanix',
  switcherRoute: '/nutanix',
  color: '#7855FA',
  basePath: '/nutanix',
  isActive,
  navGroups,
  routes: [
    { path: 'nutanix', Component: NxOverviewPage },
    { path: 'nutanix/clusters', Component: NxClustersPage },
    { path: 'nutanix/hosts', Component: NxHostsPage },
    { path: 'nutanix/vms', Component: NxVMsPage },
    { path: 'nutanix/storage', Component: NxStoragePage },
    { path: 'nutanix/alerts', Component: NxAlertsPage },
    { path: 'nutanix/protection', Component: NxProtectionPage },
    { path: 'nutanix/move', Component: NxMovePage },
    { path: 'nutanix/issues', Component: NxIssuesPage },
    { path: 'nutanix/advisor', Component: NxAdvisorPage },
    { path: 'nutanix/privacy', Component: NxPrivacyPage },
    { path: 'nutanix/settings', Component: NxSettingsPage },
  ],
};
