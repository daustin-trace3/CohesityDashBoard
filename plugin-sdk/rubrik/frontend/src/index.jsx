// Rubrik demo platform frontend module (ICC contract C9.4). Bundled as an
// IIFE with no ESM imports at runtime — React comes from `window.React`
// (injected by the build banner, see plugin-sdk/build.mjs). No Tailwind, no
// Chart.js: the host's CSS purge only scans host source files, and the SDK
// sandbox forbids host imports, so plugin markup uses inline styles and
// hand-rolled inline-SVG charts exclusively.
//
// v2.0.0 restructure: this file is registration only (nav groups + routes).
// Page bodies moved to ./pages/*.jsx (byte-identical v1.2.1 content). The
// v2 style/chart kit (./ui.jsx, ./charts.jsx) is installed via
// injectStyles() below and is available for page work packages to adopt —
// existing pages are intentionally left visually unchanged in this step.

import { injectStyles } from './ui';

import OverviewPage from './pages/overview';
import EventsPage from './pages/events';
import ClustersPage from './pages/clusters';
import ObjectsPage from './pages/objects';
import SlaDomainsPage from './pages/sla';
import CompliancePage from './pages/backuphistory';
import JobsPage from './pages/jobs';
import SecurityPage from './pages/security';
import ReplicationPage from './pages/replication';
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
        { label: 'Events', route: '/rubrik/events', isActive: (p) => p === '/rubrik/events' },
      ],
    },
    {
      label: 'Protection',
      items: [
        { label: 'Protected Objects', route: '/rubrik/objects', isActive: (p) => p === '/rubrik/objects' },
        { label: 'SLA Domains', route: '/rubrik/sla', isActive: (p) => p === '/rubrik/sla' },
        { label: 'Compliance', route: '/rubrik/compliance', isActive: (p) => p === '/rubrik/compliance' },
        { label: 'Jobs', route: '/rubrik/jobs', isActive: (p) => p === '/rubrik/jobs' },
      ],
    },
    {
      label: 'Security',
      items: [{ label: 'Threat Monitoring', route: '/rubrik/security', isActive: (p) => p === '/rubrik/security' }],
    },
    {
      label: 'Data Movement',
      items: [{ label: 'Replication & Archival', route: '/rubrik/replication', isActive: (p) => p === '/rubrik/replication' }],
    },
    {
      label: 'Capacity',
      items: [
        { label: 'Clusters', route: '/rubrik/clusters', isActive: (p) => p === '/rubrik/clusters' },
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
    { path: 'rubrik/events', Component: EventsPage },
    { path: 'rubrik/clusters', Component: ClustersPage },
    { path: 'rubrik/objects', Component: ObjectsPage },
    { path: 'rubrik/sla', Component: SlaDomainsPage },
    { path: 'rubrik/compliance', Component: CompliancePage },
    { path: 'rubrik/jobs', Component: JobsPage },
    { path: 'rubrik/security', Component: SecurityPage },
    { path: 'rubrik/replication', Component: ReplicationPage },
    { path: 'rubrik/forecast', Component: ForecastPage },
    { path: 'rubrik/settings', Component: RbkSettingsPage },
  ],
});
