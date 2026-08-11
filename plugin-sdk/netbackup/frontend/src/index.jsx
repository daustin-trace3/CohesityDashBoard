// Veritas NetBackup plugin frontend module (ICC contract C9.1). Bundled as
// an IIFE with no ESM imports at runtime — React/ReactDOM/ReactRouterDOM
// come from window globals (injected by the build banner + host, see
// plugin-sdk/build.mjs and frontend/src/main.jsx). No Tailwind, no lucide:
// styled via the injected nb- stylesheet (./ui.jsx) and Chart.js
// (window.Chart, see ./charts.jsx) exclusively.
//
// Mirrors the built-in platform's nav groups (Monitor/Protect/Reporting/
// Infrastructure/System) and routes 1:1 — see
// frontend/src/platforms/netbackup/index.jsx (host, pre-removal) for the
// source of truth this was ported from. The manifest's navSections list
// (backend/platforms/netbackup/index.js) omits 'object-360' (it's reached
// via search/deep-link as well as a direct nav item on the host); it is
// kept here as both a route and a Reporting nav item to match the host UI.

import { injectStyles } from './ui.jsx';

import OverviewPage from './pages/overview.jsx';
import AlertsPage from './pages/alerts.jsx';
import AdvisorPage from './pages/advisor.jsx';
import JobsPage from './pages/jobs.jsx';
import PoliciesPage from './pages/policies.jsx';
import SlpPage from './pages/slps.jsx';
import GovernancePage from './pages/governance.jsx';
import BackupHistoryPage from './pages/backup-history.jsx';
import Object360Page from './pages/object360.jsx';
import WorkloadsPage from './pages/workloads.jsx';
import LicensingPage from './pages/licensing.jsx';
import StoragePage from './pages/storage.jsx';
import AppliancesPage from './pages/appliances.jsx';
import PrivacyPage from './pages/privacy.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#B1181E'; // Veritas red

injectStyles();

window.__ICC_REGISTER_PLUGIN__({
  id: 'netbackup',
  label: 'NetBackup',
  color: ACCENT,
  switcherRoute: '/netbackup',
  basePath: '/netbackup',
  isActive: (p) => p === '/netbackup' || p.startsWith('/netbackup/'),
  navGroups: [
    {
      label: 'Monitor',
      items: [
        { label: 'Overview', route: '/netbackup', isActive: (p) => p === '/netbackup' },
        { label: 'AI Advisor', route: '/netbackup/advisor', isActive: (p) => p.startsWith('/netbackup/advisor') },
        { label: 'Alerts', route: '/netbackup/alerts', isActive: (p) => p.startsWith('/netbackup/alerts') },
      ],
    },
    {
      label: 'Protect',
      items: [
        { label: 'Data Protection', route: '/netbackup/jobs', isActive: (p) => p.startsWith('/netbackup/jobs') },
        { label: 'Policies', route: '/netbackup/policies', isActive: (p) => p.startsWith('/netbackup/policies') },
        { label: 'SLP / Replication', route: '/netbackup/slps', isActive: (p) => p.startsWith('/netbackup/slps') },
        { label: 'Governance', route: '/netbackup/governance', isActive: (p) => p.startsWith('/netbackup/governance') },
      ],
    },
    {
      label: 'Reporting',
      items: [
        { label: 'Backup History', route: '/netbackup/backup-history', isActive: (p) => p.startsWith('/netbackup/backup-history') },
        { label: 'Object 360', route: '/netbackup/object-360', isActive: (p) => p.startsWith('/netbackup/object-360') },
        { label: 'Workloads', route: '/netbackup/workloads', isActive: (p) => p.startsWith('/netbackup/workloads') },
        { label: 'Licensing', route: '/netbackup/licensing', isActive: (p) => p.startsWith('/netbackup/licensing') },
      ],
    },
    {
      label: 'Infrastructure',
      items: [
        { label: 'Storage', route: '/netbackup/storage', isActive: (p) => p.startsWith('/netbackup/storage') },
        { label: 'Appliances', route: '/netbackup/appliances', isActive: (p) => p.startsWith('/netbackup/appliances') },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Privacy Inspector', route: '/netbackup/privacy', isActive: (p) => p.startsWith('/netbackup/privacy') },
        { label: 'Settings', route: '/netbackup/settings', isActive: (p) => p.startsWith('/netbackup/settings') },
      ],
    },
  ],
  routes: [
    { path: 'netbackup', Component: OverviewPage },
    { path: 'netbackup/alerts', Component: AlertsPage },
    { path: 'netbackup/advisor', Component: AdvisorPage },
    { path: 'netbackup/jobs', Component: JobsPage },
    { path: 'netbackup/policies', Component: PoliciesPage },
    { path: 'netbackup/slps', Component: SlpPage },
    { path: 'netbackup/governance', Component: GovernancePage },
    { path: 'netbackup/backup-history', Component: BackupHistoryPage },
    { path: 'netbackup/object-360', Component: Object360Page },
    { path: 'netbackup/workloads', Component: WorkloadsPage },
    { path: 'netbackup/licensing', Component: LicensingPage },
    { path: 'netbackup/storage', Component: StoragePage },
    { path: 'netbackup/appliances', Component: AppliancesPage },
    { path: 'netbackup/privacy', Component: PrivacyPage },
    { path: 'netbackup/settings', Component: SettingsPage },
  ],
});
