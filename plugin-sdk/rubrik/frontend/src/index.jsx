// Rubrik demo platform frontend module (ICC contract C9.4). Bundled as an
// IIFE with no ESM imports at runtime — React comes from `window.React`
// (injected by the build banner, see plugin-sdk/build.mjs). No Tailwind, no
// Chart.js: the host's CSS purge only scans host source files, and the SDK
// sandbox forbids host imports, so plugin markup uses inline styles and
// hand-rolled inline-SVG charts exclusively.
//
// v2.0.0: registration only (nav groups + routes); page bodies in
// ./pages/*.jsx built on the ./ui.jsx + ./charts.jsx kit. Nav mirrors the
// Cohesity platform's group structure (Monitor/Protect/Reporting/
// Infrastructure/System) with a RICHER Security group — the demo's pitch is
// that only the accent color tells you which platform you're on.

import { injectStyles } from './ui';

import OverviewPage from './pages/overview';
import AlertsPage from './pages/alerts';
import LicensingPage from './pages/licensing';
import DataProtectionPage from './pages/dataprotection';
import WorkloadsPage from './pages/workloads';
import ReplicationPage from './pages/replication';
import SlaDomainsPage from './pages/sla';
import GovernancePage from './pages/governance';
import BackupHistoryPage from './pages/backuphistory';
import ReportingPage from './pages/reporting';
import AnalyticsPage from './pages/analytics';
import SourcesPage from './pages/sources';
import SecurityPage from './pages/security';
import EventsPage from './pages/events';
import ObjectsPage from './pages/objects';
import JobsPage from './pages/jobs';
import ClustersPage from './pages/clusters';
import ForecastPage from './pages/forecast';
import RbkSettingsPage from './pages/settings';

const ACCENT = '#00B388';

injectStyles();

window.__ICC_REGISTER_PLUGIN__({
  id: 'rubrik',
  label: 'Rubrik',
  color: ACCENT,
  switcherRoute: '/rubrik',
  basePath: '/rubrik',
  isActive: (p) => p.startsWith('/rubrik'),
  navGroups: [
    {
      label: 'Monitor',
      items: [
        { label: 'Overview', route: '/rubrik', isActive: (p) => p === '/rubrik' },
        { label: 'Alerts', route: '/rubrik/alerts', isActive: (p) => p === '/rubrik/alerts' },
        { label: 'Licensing', route: '/rubrik/licensing', isActive: (p) => p === '/rubrik/licensing' },
      ],
    },
    {
      label: 'Protect',
      items: [
        { label: 'Data Protection', route: '/rubrik/data-protection', isActive: (p) => p === '/rubrik/data-protection' },
        { label: 'Workloads', route: '/rubrik/workloads', isActive: (p) => p === '/rubrik/workloads' },
        { label: 'Replication', route: '/rubrik/replication', isActive: (p) => p === '/rubrik/replication' },
        { label: 'SLA Domains', route: '/rubrik/sla', isActive: (p) => p === '/rubrik/sla' },
        { label: 'Governance', route: '/rubrik/governance', isActive: (p) => p === '/rubrik/governance' },
      ],
    },
    {
      label: 'Reporting',
      items: [
        { label: 'Backup History', route: '/rubrik/backup-history', isActive: (p) => p === '/rubrik/backup-history' || p === '/rubrik/compliance' },
        { label: 'Reporting', route: '/rubrik/reporting', isActive: (p) => p === '/rubrik/reporting' },
        { label: 'Analytics', route: '/rubrik/analytics', isActive: (p) => p === '/rubrik/analytics' },
        { label: 'Sources', route: '/rubrik/sources', isActive: (p) => p === '/rubrik/sources' },
      ],
    },
    {
      label: 'Security',
      items: [
        { label: 'Threat Monitoring', route: '/rubrik/security', isActive: (p) => p === '/rubrik/security' },
        { label: 'Events', route: '/rubrik/events', isActive: (p) => p === '/rubrik/events' },
      ],
    },
    {
      label: 'Infrastructure',
      items: [
        { label: 'Clusters', route: '/rubrik/clusters', isActive: (p) => p === '/rubrik/clusters' },
        { label: 'Protected Objects', route: '/rubrik/objects', isActive: (p) => p === '/rubrik/objects' },
        { label: 'Forecast', route: '/rubrik/forecast', isActive: (p) => p === '/rubrik/forecast' },
      ],
    },
    {
      label: 'System',
      items: [{ label: 'Settings', route: '/rubrik/settings', isActive: (p) => p === '/rubrik/settings' }],
    },
  ],
  routes: [
    { path: 'rubrik', Component: OverviewPage },
    { path: 'rubrik/alerts', Component: AlertsPage },
    { path: 'rubrik/licensing', Component: LicensingPage },
    { path: 'rubrik/data-protection', Component: DataProtectionPage },
    { path: 'rubrik/workloads', Component: WorkloadsPage },
    { path: 'rubrik/replication', Component: ReplicationPage },
    { path: 'rubrik/sla', Component: SlaDomainsPage },
    { path: 'rubrik/governance', Component: GovernancePage },
    { path: 'rubrik/backup-history', Component: BackupHistoryPage },
    // Legacy v1.x path kept working — same page.
    { path: 'rubrik/compliance', Component: BackupHistoryPage },
    { path: 'rubrik/reporting', Component: ReportingPage },
    { path: 'rubrik/analytics', Component: AnalyticsPage },
    { path: 'rubrik/sources', Component: SourcesPage },
    { path: 'rubrik/security', Component: SecurityPage },
    { path: 'rubrik/events', Component: EventsPage },
    { path: 'rubrik/objects', Component: ObjectsPage },
    { path: 'rubrik/jobs', Component: JobsPage },
    { path: 'rubrik/clusters', Component: ClustersPage },
    { path: 'rubrik/forecast', Component: ForecastPage },
    { path: 'rubrik/settings', Component: RbkSettingsPage },
  ],
});
