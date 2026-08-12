import { lazy } from 'react';
import {
  Gauge, Router, Cable, Users, Wifi, Share2, Globe, ShieldCheck, ClipboardCheck, Settings, Cctv,
} from 'lucide-react';

const UnifiOverviewPage = lazy(() => import('../../pages/unifi/UnifiOverviewPage'));
const UnifiDevicesPage = lazy(() => import('../../pages/unifi/UnifiDevicesPage'));
const UnifiPortsPage = lazy(() => import('../../pages/unifi/UnifiPortsPage'));
const UnifiClientsPage = lazy(() => import('../../pages/unifi/UnifiClientsPage'));
const UnifiWifiPage = lazy(() => import('../../pages/unifi/UnifiWifiPage'));
const UnifiProtectPage = lazy(() => import('../../pages/unifi/UnifiProtectPage'));
const UnifiTopologyPage = lazy(() => import('../../pages/unifi/UnifiTopologyPage'));
const UnifiWanPage = lazy(() => import('../../pages/unifi/UnifiWanPage'));
const UnifiSecurityPage = lazy(() => import('../../pages/unifi/UnifiSecurityPage'));
const UnifiSettingsPage = lazy(() => import('../../pages/unifi/UnifiSettingsPage'));

const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const UnifiIssuesPage = () => <IssueAlertsPage platform="unifi" />;

// UniFi sidebar — shown when the Ubiquiti UniFi platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/unifi', icon: Gauge, isActive: (p) => p === '/unifi' },
      { label: 'Devices', route: '/unifi/devices', icon: Router, isActive: (p) => p.startsWith('/unifi/devices') },
      { label: 'Ports', route: '/unifi/ports', icon: Cable, isActive: (p) => p.startsWith('/unifi/ports') },
      { label: 'Clients', route: '/unifi/clients', icon: Users, isActive: (p) => p.startsWith('/unifi/clients') },
      { label: 'WiFi', route: '/unifi/wifi', icon: Wifi, isActive: (p) => p.startsWith('/unifi/wifi'), feature: 'wifi' },
      { label: 'Protect', route: '/unifi/protect', icon: Cctv, isActive: (p) => p.startsWith('/unifi/protect'), feature: 'protect' },
    ],
  },
  {
    label: 'Network',
    items: [
      { label: 'Topology', route: '/unifi/topology', icon: Share2, isActive: (p) => p.startsWith('/unifi/topology') },
      { label: 'WAN / ISP', route: '/unifi/wan', icon: Globe, isActive: (p) => p.startsWith('/unifi/wan') },
      { label: 'Security', route: '/unifi/security', icon: ShieldCheck, isActive: (p) => p.startsWith('/unifi/security'), feature: 'security' },
    ],
  },
  {
    label: 'Audit',
    items: [
      { label: 'Issue Alerts', route: '/unifi/alerts', icon: ClipboardCheck, isActive: (p) => p.startsWith('/unifi/alerts') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/unifi/settings', icon: Settings, isActive: (p) => p.startsWith('/unifi/settings') },
    ],
  },
];

function isActive(pathname) {
  return pathname.startsWith('/unifi');
}

export default {
  id: 'unifi',
  label: 'Ubiquiti UniFi',
  switcherRoute: '/unifi',
  color: '#006FFF',
  basePath: '/unifi',
  isActive,
  navGroups,
  routes: [
    { path: 'unifi', Component: UnifiOverviewPage },
    { path: 'unifi/devices', Component: UnifiDevicesPage },
    { path: 'unifi/ports', Component: UnifiPortsPage },
    { path: 'unifi/clients', Component: UnifiClientsPage },
    { path: 'unifi/wifi', Component: UnifiWifiPage },
    { path: 'unifi/protect', Component: UnifiProtectPage },
    { path: 'unifi/topology', Component: UnifiTopologyPage },
    { path: 'unifi/wan', Component: UnifiWanPage },
    { path: 'unifi/security', Component: UnifiSecurityPage },
    { path: 'unifi/alerts', Component: UnifiIssuesPage },
    { path: 'unifi/settings', Component: UnifiSettingsPage },
  ],
};
