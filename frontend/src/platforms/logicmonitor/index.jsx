import { lazy } from 'react';
import {
  Gauge, Radar, MapPin, Bell, ClipboardCheck, Server, Cable, Waypoints, Cpu, Scale, ShieldAlert, GitMerge, LineChart, Sparkles, ShieldCheck, Settings, BrickWall, Split,
  Wifi, RadioTower, Radio, Users,
} from 'lucide-react';
import { BRAND } from '../../pages/logicmonitor/helpers';

const LmOverviewPage = lazy(() => import('../../pages/logicmonitor/LmOverviewPage'));
const LmReachabilityPage = lazy(() => import('../../pages/logicmonitor/LmReachabilityPage'));
const LmSitesPage = lazy(() => import('../../pages/logicmonitor/LmSitesPage'));
const LmCircuitsPage = lazy(() => import('../../pages/logicmonitor/LmCircuitsPage'));
const LmFirewallsPage = lazy(() => import('../../pages/logicmonitor/LmFirewallsPage'));
const LmLoadBalancersPage = lazy(() => import('../../pages/logicmonitor/LmLoadBalancersPage'));
const LmWirelessOverviewPage = lazy(() => import('../../pages/logicmonitor/LmWirelessOverviewPage'));
const LmWirelessControllersPage = lazy(() => import('../../pages/logicmonitor/LmWirelessControllersPage'));
const LmWirelessApsPage = lazy(() => import('../../pages/logicmonitor/LmWirelessApsPage'));
const LmWirelessRfPage = lazy(() => import('../../pages/logicmonitor/LmWirelessRfPage'));
const LmWirelessSsidsPage = lazy(() => import('../../pages/logicmonitor/LmWirelessSsidsPage'));
const LmAlertsPage = lazy(() => import('../../pages/logicmonitor/LmAlertsPage'));
const LmIssuesPage = lazy(() => import('../../pages/logicmonitor/LmIssuesPage'));
const LmDevicesPage = lazy(() => import('../../pages/logicmonitor/LmDevicesPage'));
const LmInterfacesPage = lazy(() => import('../../pages/logicmonitor/LmInterfacesPage'));
const LmCollectorsPage = lazy(() => import('../../pages/logicmonitor/LmCollectorsPage'));
const LmGovernancePage = lazy(() => import('../../pages/logicmonitor/LmGovernancePage'));
const LmCoveragePage = lazy(() => import('../../pages/logicmonitor/LmCoveragePage'));
const LmCorrelationPage = lazy(() => import('../../pages/logicmonitor/LmCorrelationPage'));
const LmTrendsPage = lazy(() => import('../../pages/logicmonitor/LmTrendsPage'));
const LmAdvisorPage = lazy(() => import('../../pages/logicmonitor/LmAdvisorPage'));
const LmPrivacyPage = lazy(() => import('../../pages/logicmonitor/LmPrivacyPage'));
const LmSettingsPage = lazy(() => import('../../pages/logicmonitor/LmSettingsPage'));

const B = '/logicmonitor';
const under = (route) => (p) => p === route || p.startsWith(`${route}/`);

// LogicMonitor sidebar - shown when the LogicMonitor platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: B, icon: Gauge, isActive: (p) => p === B },
      { label: 'Site Reachability', route: `${B}/reachability`, icon: Radar, isActive: under(`${B}/reachability`) },
      { label: 'Sites', route: `${B}/sites`, icon: MapPin, isActive: under(`${B}/sites`) },
      { label: 'Alerts', route: `${B}/alerts`, icon: Bell, isActive: under(`${B}/alerts`) },
      { label: 'Issues', route: `${B}/issues`, icon: ClipboardCheck, isActive: under(`${B}/issues`) },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Devices', route: `${B}/devices`, icon: Server, isActive: under(`${B}/devices`) },
      { label: 'Interfaces', route: `${B}/interfaces`, icon: Cable, isActive: under(`${B}/interfaces`) },
      { label: 'Circuits', route: `${B}/circuits`, icon: Waypoints, isActive: under(`${B}/circuits`) },
      { label: 'Firewalls', route: `${B}/firewalls`, icon: BrickWall, isActive: under(`${B}/firewalls`) },
      { label: 'Load Balancers', route: `${B}/load-balancers`, icon: Split, isActive: under(`${B}/load-balancers`) },
      { label: 'Collectors', route: `${B}/collectors`, icon: Cpu, isActive: under(`${B}/collectors`) },
    ],
  },
  {
    label: 'Wireless',
    items: [
      { label: 'Wireless Overview', route: `${B}/wireless`, icon: Wifi, isActive: (p) => p === `${B}/wireless` },
      { label: 'Controllers', route: `${B}/wireless/controllers`, icon: RadioTower, isActive: under(`${B}/wireless/controllers`) },
      { label: 'Access Points', route: `${B}/wireless/aps`, icon: Wifi, isActive: under(`${B}/wireless/aps`) },
      { label: 'RF Analytics', route: `${B}/wireless/rf`, icon: Radio, isActive: under(`${B}/wireless/rf`) },
      { label: 'SSIDs & Clients', route: `${B}/wireless/ssids`, icon: Users, isActive: under(`${B}/wireless/ssids`) },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { label: 'Governance', route: `${B}/governance`, icon: Scale, isActive: under(`${B}/governance`) },
      { label: 'Coverage', route: `${B}/coverage`, icon: ShieldAlert, isActive: under(`${B}/coverage`) },
      { label: 'Correlation', route: `${B}/correlation`, icon: GitMerge, isActive: under(`${B}/correlation`) },
      { label: 'Trends', route: `${B}/trends`, icon: LineChart, isActive: under(`${B}/trends`) },
      { label: 'AI Advisor', route: `${B}/advisor`, icon: Sparkles, isActive: under(`${B}/advisor`), requiresAi: true },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Privacy Inspector', route: `${B}/privacy`, icon: ShieldCheck, isActive: under(`${B}/privacy`), requiresAi: true },
      { label: 'Settings', route: `${B}/settings`, icon: Settings, isActive: under(`${B}/settings`) },
    ],
  },
];

function isActive(pathname) {
  return pathname === B || pathname.startsWith(`${B}/`);
}

export default {
  id: 'logicmonitor',
  label: 'LogicMonitor',
  switcherRoute: B,
  color: BRAND,
  basePath: B,
  isActive,
  navGroups,
  routes: [
    { path: 'logicmonitor', Component: LmOverviewPage },
    { path: 'logicmonitor/reachability', Component: LmReachabilityPage },
    { path: 'logicmonitor/sites', Component: LmSitesPage },
    { path: 'logicmonitor/alerts', Component: LmAlertsPage },
    { path: 'logicmonitor/issues', Component: LmIssuesPage },
    { path: 'logicmonitor/devices', Component: LmDevicesPage },
    { path: 'logicmonitor/interfaces', Component: LmInterfacesPage },
    { path: 'logicmonitor/circuits', Component: LmCircuitsPage },
    { path: 'logicmonitor/firewalls', Component: LmFirewallsPage },
    { path: 'logicmonitor/load-balancers', Component: LmLoadBalancersPage },
    { path: 'logicmonitor/wireless', Component: LmWirelessOverviewPage },
    { path: 'logicmonitor/wireless/controllers', Component: LmWirelessControllersPage },
    { path: 'logicmonitor/wireless/aps', Component: LmWirelessApsPage },
    { path: 'logicmonitor/wireless/rf', Component: LmWirelessRfPage },
    { path: 'logicmonitor/wireless/ssids', Component: LmWirelessSsidsPage },
    { path: 'logicmonitor/collectors', Component: LmCollectorsPage },
    { path: 'logicmonitor/governance', Component: LmGovernancePage },
    { path: 'logicmonitor/coverage', Component: LmCoveragePage },
    { path: 'logicmonitor/correlation', Component: LmCorrelationPage },
    { path: 'logicmonitor/trends', Component: LmTrendsPage },
    { path: 'logicmonitor/advisor', Component: LmAdvisorPage },
    { path: 'logicmonitor/privacy', Component: LmPrivacyPage },
    { path: 'logicmonitor/settings', Component: LmSettingsPage },
  ],
};
