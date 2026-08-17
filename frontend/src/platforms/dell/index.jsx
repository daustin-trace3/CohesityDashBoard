import { lazy } from 'react';
import { Gauge, Server, Settings, AlertTriangle, Wrench, BadgeCheck, Sparkles, ShieldCheck, ClipboardCheck, ListChecks, ScrollText, FileBarChart } from 'lucide-react';

const DellOverviewPage = lazy(() => import('../../pages/dell/DellOverviewPage'));
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const DellPrivacyPage = () => <PrivacyInspectorPage platform="dell" />;
const DellDevicesPage = lazy(() => import('../../pages/dell/DellDevicesPage'));
const DellAlertsPage = lazy(() => import('../../pages/dell/DellAlertsPage'));
const DellHardwarePage = lazy(() => import('../../pages/dell/DellHardwarePage'));
const DellSupportPage = lazy(() => import('../../pages/dell/DellSupportPage'));
const DellSettingsPage = lazy(() => import('../../pages/dell/DellSettingsPage'));
const DellAdvisorPage = lazy(() => import('../../pages/dell/DellAdvisorPage'));
const DellGovernancePage = lazy(() => import('../../pages/dell/DellGovernancePage'));
const DellJobsPage = lazy(() => import('../../pages/dell/DellJobsPage'));
const DellHardwareLogsPage = lazy(() => import('../../pages/dell/DellHardwareLogsPage'));
const DellReportsPage = lazy(() => import('../../pages/dell/DellReportsPage'));

// Dell OpenManage Enterprise sidebar — shown when the OME platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/dell', icon: Gauge, isActive: (p) => p === '/dell' },
      { label: 'AI Advisor', route: '/dell/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/dell/advisor'), requiresAi: true },
      { label: 'Alerts', route: '/dell/alerts', icon: AlertTriangle, isActive: (p) => p.startsWith('/dell/alerts') },
      { label: 'Jobs', route: '/dell/jobs', icon: ListChecks, isActive: (p) => p.startsWith('/dell/jobs') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Devices', route: '/dell/devices', icon: Server, isActive: (p) => p.startsWith('/dell/devices') },
      { label: 'Hardware', route: '/dell/hardware', icon: Wrench, isActive: (p) => p.startsWith('/dell/hardware') && !p.startsWith('/dell/hardware-logs') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Governance', route: '/dell/compliance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/dell/compliance') },
      { label: 'Hardware Logs', route: '/dell/hardware-logs', icon: ScrollText, isActive: (p) => p.startsWith('/dell/hardware-logs') },
      { label: 'Reports', route: '/dell/reports', icon: FileBarChart, isActive: (p) => p.startsWith('/dell/reports') },
      { label: 'Support', route: '/dell/support', icon: BadgeCheck, isActive: (p) => p.startsWith('/dell/support') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: '/dell/privacy', icon: ShieldCheck, isActive: (p) => p.startsWith('/dell/privacy'), requiresAi: true },
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
    { path: 'dell/jobs', Component: DellJobsPage },
    { path: 'dell/compliance', Component: DellGovernancePage },
    { path: 'dell/hardware-logs', Component: DellHardwareLogsPage },
    { path: 'dell/reports', Component: DellReportsPage },
    { path: 'dell/support', Component: DellSupportPage },
    { path: 'dell/advisor', Component: DellAdvisorPage },
    { path: 'dell/privacy', Component: DellPrivacyPage },
    { path: 'dell/settings', Component: DellSettingsPage },
  ],
};
