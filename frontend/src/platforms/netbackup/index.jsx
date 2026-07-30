import { lazy } from 'react';
import { Gauge, Bell, ClipboardList, ShieldCheck, HardDrive, Server, Settings } from 'lucide-react';

const NbOverviewPage = lazy(() => import('../../pages/netbackup/NbOverviewPage'));
const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const NbAlertsPage = () => <IssueAlertsPage platform="netbackup" />;
const NbJobsPage = lazy(() => import('../../pages/netbackup/NbJobsPage'));
const NbPoliciesPage = lazy(() => import('../../pages/netbackup/NbPoliciesPage'));
const NbStoragePage = lazy(() => import('../../pages/netbackup/NbStoragePage'));
const NbAppliancesPage = lazy(() => import('../../pages/netbackup/NbAppliancesPage'));
const NbSettingsPage = lazy(() => import('../../pages/netbackup/NbSettingsPage'));

// Veritas NetBackup sidebar — shown when the NetBackup platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/netbackup', icon: Gauge, isActive: (p) => p === '/netbackup' },
      { label: 'Alerts', route: '/netbackup/alerts', icon: Bell, isActive: (p) => p.startsWith('/netbackup/alerts'), showAlertCount: true },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Data Protection', route: '/netbackup/jobs', icon: ClipboardList, isActive: (p) => p.startsWith('/netbackup/jobs') },
      { label: 'Policies', route: '/netbackup/policies', icon: ShieldCheck, isActive: (p) => p.startsWith('/netbackup/policies') },
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
    { path: 'netbackup/jobs', Component: NbJobsPage },
    { path: 'netbackup/policies', Component: NbPoliciesPage },
    { path: 'netbackup/storage', Component: NbStoragePage },
    { path: 'netbackup/appliances', Component: NbAppliancesPage },
    { path: 'netbackup/settings', Component: NbSettingsPage },
  ],
};
