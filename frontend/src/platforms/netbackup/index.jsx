import { lazy } from 'react';
import { Gauge, Bell, ClipboardList, ShieldCheck, HardDrive, Server, Settings, Sparkles, Workflow, ClipboardCheck, CalendarCheck, Layers, BadgeCheck, ShieldCheck as PrivacyIcon, Crosshair } from 'lucide-react';

const NbOverviewPage = lazy(() => import('../../pages/netbackup/NbOverviewPage'));
const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const NbAlertsPage = () => <IssueAlertsPage platform="netbackup" />;
const NbJobsPage = lazy(() => import('../../pages/netbackup/NbJobsPage'));
const NbPoliciesPage = lazy(() => import('../../pages/netbackup/NbPoliciesPage'));
const NbStoragePage = lazy(() => import('../../pages/netbackup/NbStoragePage'));
const NbAppliancesPage = lazy(() => import('../../pages/netbackup/NbAppliancesPage'));
const NbSettingsPage = lazy(() => import('../../pages/netbackup/NbSettingsPage'));
const NbAdvisorPage = lazy(() => import('../../pages/netbackup/NbAdvisorPage'));
const NbSlpPage = lazy(() => import('../../pages/netbackup/NbSlpPage'));
const NbGovernancePage = lazy(() => import('../../pages/netbackup/NbGovernancePage'));
const NbBackupHistoryPage = lazy(() => import('../../pages/netbackup/NbBackupHistoryPage'));
const NbObject360Page = lazy(() => import('../../pages/netbackup/NbObject360Page'));
const NbWorkloadsPage = lazy(() => import('../../pages/netbackup/NbWorkloadsPage'));
const NbLicensingPage = lazy(() => import('../../pages/netbackup/NbLicensingPage'));
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const NbPrivacyPage = () => <PrivacyInspectorPage platform="netbackup" />;

// Veritas NetBackup sidebar — shown when the NetBackup platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/netbackup', icon: Gauge, isActive: (p) => p === '/netbackup' },
      { label: 'AI Advisor', route: '/netbackup/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/netbackup/advisor'), requiresAi: true },
      { label: 'Alerts', route: '/netbackup/alerts', icon: Bell, isActive: (p) => p.startsWith('/netbackup/alerts'), showAlertCount: true },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Data Protection', route: '/netbackup/jobs', icon: ClipboardList, isActive: (p) => p.startsWith('/netbackup/jobs') },
      { label: 'Policies', route: '/netbackup/policies', icon: ShieldCheck, isActive: (p) => p.startsWith('/netbackup/policies') },
      { label: 'SLP / Replication', route: '/netbackup/slps', icon: Workflow, isActive: (p) => p.startsWith('/netbackup/slps') },
      { label: 'Governance', route: '/netbackup/governance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/netbackup/governance') },
    ],
  },
  {
    label: 'Reporting',
    items: [
      { label: 'Backup History', route: '/netbackup/backup-history', icon: CalendarCheck, isActive: (p) => p.startsWith('/netbackup/backup-history') },
      { label: 'Object 360', route: '/netbackup/object-360', icon: Crosshair, isActive: (p) => p.startsWith('/netbackup/object-360') },
      { label: 'Workloads', route: '/netbackup/workloads', icon: Layers, isActive: (p) => p.startsWith('/netbackup/workloads') },
      { label: 'Licensing', route: '/netbackup/licensing', icon: BadgeCheck, isActive: (p) => p.startsWith('/netbackup/licensing') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Storage', route: '/netbackup/storage', icon: HardDrive, isActive: (p) => p.startsWith('/netbackup/storage') },
      { label: 'Appliances', route: '/netbackup/appliances', icon: Server, isActive: (p) => p.startsWith('/netbackup/appliances') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: '/netbackup/privacy', icon: PrivacyIcon, isActive: (p) => p.startsWith('/netbackup/privacy'), requiresAi: true },
      { label: 'Settings', route: '/netbackup/settings', icon: Settings, isActive: (p) => p.startsWith('/netbackup/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname === '/netbackup' || pathname.startsWith('/netbackup/');
}

export default {
  id: 'netbackup',
  label: 'NetBackup',
  switcherRoute: '/netbackup',
  color: '#B1181E',
  basePath: '/netbackup',
  isActive,
  navGroups,
  routes: [
    { path: 'netbackup', Component: NbOverviewPage },
    { path: 'netbackup/alerts', Component: NbAlertsPage },
    { path: 'netbackup/advisor', Component: NbAdvisorPage },
    { path: 'netbackup/jobs', Component: NbJobsPage },
    { path: 'netbackup/policies', Component: NbPoliciesPage },
    { path: 'netbackup/slps', Component: NbSlpPage },
    { path: 'netbackup/governance', Component: NbGovernancePage },
    { path: 'netbackup/backup-history', Component: NbBackupHistoryPage },
    { path: 'netbackup/object-360', Component: NbObject360Page },
    { path: 'netbackup/workloads', Component: NbWorkloadsPage },
    { path: 'netbackup/licensing', Component: NbLicensingPage },
    { path: 'netbackup/storage', Component: NbStoragePage },
    { path: 'netbackup/appliances', Component: NbAppliancesPage },
    { path: 'netbackup/privacy', Component: NbPrivacyPage },
    { path: 'netbackup/settings', Component: NbSettingsPage },
  ],
};
