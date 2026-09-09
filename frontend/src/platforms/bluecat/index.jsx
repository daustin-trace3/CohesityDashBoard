import { lazy } from 'react';
import {
  Gauge, Network, Globe, HardDrive, Server, ClipboardCheck, Settings,
} from 'lucide-react';

const BluecatOverviewPage = lazy(() => import('../../pages/bluecat/BluecatOverviewPage'));
const BluecatIpSpacesPage = lazy(() => import('../../pages/bluecat/BluecatIpSpacesPage'));
const BluecatDnsPage = lazy(() => import('../../pages/bluecat/BluecatDnsPage'));
const BluecatDevicesPage = lazy(() => import('../../pages/bluecat/BluecatDevicesPage'));
const BluecatServersPage = lazy(() => import('../../pages/bluecat/BluecatServersPage'));
const BluecatSettingsPage = lazy(() => import('../../pages/bluecat/BluecatSettingsPage'));

const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const BluecatIssuesPage = () => <IssueAlertsPage platform="bluecat" />;

// BlueCat Address Manager sidebar - shown when the BlueCat platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/bluecat', icon: Gauge, isActive: (p) => p === '/bluecat' },
      { label: 'IP Spaces', route: '/bluecat/ipspaces', icon: Network, isActive: (p) => p.startsWith('/bluecat/ipspaces') },
      { label: 'DNS', route: '/bluecat/dns', icon: Globe, isActive: (p) => p.startsWith('/bluecat/dns') },
      { label: 'Devices', route: '/bluecat/devices', icon: HardDrive, isActive: (p) => p.startsWith('/bluecat/devices') },
      { label: 'Servers', route: '/bluecat/servers', icon: Server, isActive: (p) => p.startsWith('/bluecat/servers') },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Issue Alerts', route: '/bluecat/alerts', icon: ClipboardCheck, isActive: (p) => p.startsWith('/bluecat/alerts') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/bluecat/settings', icon: Settings, isActive: (p) => p.startsWith('/bluecat/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/bluecat');
}

export default {
  id: 'bluecat',
  label: 'BlueCat Address Manager',
  switcherRoute: '/bluecat',
  color: '#0057B8',
  basePath: '/bluecat',
  isActive,
  navGroups,
  routes: [
    { path: 'bluecat', Component: BluecatOverviewPage },
    { path: 'bluecat/ipspaces', Component: BluecatIpSpacesPage },
    { path: 'bluecat/dns', Component: BluecatDnsPage },
    { path: 'bluecat/devices', Component: BluecatDevicesPage },
    { path: 'bluecat/servers', Component: BluecatServersPage },
    { path: 'bluecat/alerts', Component: BluecatIssuesPage },
    { path: 'bluecat/settings', Component: BluecatSettingsPage },
  ],
};
