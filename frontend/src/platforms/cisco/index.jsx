import { lazy } from 'react';
import {
  Gauge, Bell, ClipboardCheck, Sparkles, Server, BrickWall, Wifi, RadioTower, Radio, Users,
  Phone, Fingerprint, ShieldCheck, Settings, Cpu, Cable, Zap, PlugZap, Route as RouteIcon, Radar,
} from 'lucide-react';
import { BRAND } from '../../pages/cisco/ciscoShared';

// Cisco is a derived platform: no sources and no poller of its own. The rail entry
// appears while the LogicMonitor connector has devices ICC classified as Cisco or Meraki.
// Firewalls, wireless, voice and ISE are the LogicMonitor pages rendered through apiBase '/cisco'.
const CiscoOverviewPage = lazy(() => import('../../pages/cisco/CiscoOverviewPage'));
const CiscoDevicesPage = lazy(() => import('../../pages/cisco/CiscoDevicesPage'));
const CiscoAlertsPage = lazy(() => import('../../pages/cisco/CiscoAlertsPage'));
const CiscoAdvisorPage = lazy(() => import('../../pages/cisco/CiscoAdvisorPage'));
const CiscoSettingsPage = lazy(() => import('../../pages/cisco/CiscoSettingsPage'));
const lazyReused = (name) => lazy(() => import('../../pages/cisco/CiscoReusedPages').then((m) => ({ default: m[name] })));
const CiscoFirewallsPage = lazyReused('CiscoFirewallsPage');
const CiscoWirelessOverviewPage = lazyReused('CiscoWirelessOverviewPage');
const CiscoWirelessControllersPage = lazyReused('CiscoWirelessControllersPage');
const CiscoWirelessApsPage = lazyReused('CiscoWirelessApsPage');
const CiscoWirelessRfPage = lazyReused('CiscoWirelessRfPage');
const CiscoWirelessSsidsPage = lazyReused('CiscoWirelessSsidsPage');
const CiscoVoicePage = lazyReused('CiscoVoicePage');
const CiscoIsePage = lazyReused('CiscoIsePage');
const CiscoHardwarePage = lazy(() => import('../../pages/cisco/CiscoHardwarePage'));
const CiscoInterfacesPage = lazy(() => import('../../pages/cisco/CiscoInterfacesPage'));
const CiscoOpticsPage = lazy(() => import('../../pages/cisco/CiscoOpticsPage'));
const CiscoPoePage = lazy(() => import('../../pages/cisco/CiscoPoePage'));
const CiscoRoutingPage = lazy(() => import('../../pages/cisco/CiscoRoutingPage'));
const CiscoResourcesPage = lazy(() => import('../../pages/cisco/CiscoResourcesPage'));
const CiscoReachabilityPage = lazy(() => import('../../pages/cisco/CiscoReachabilityPage'));
const IssueAlertsPage = lazy(() => import('../../components/IssueAlertsPage'));
const CiscoIssuesPage = () => <IssueAlertsPage platform="cisco" />;
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const CiscoPrivacyPage = () => <PrivacyInspectorPage platform="cisco" />;

const B = '/cisco';
const under = (base) => (p) => p === base || p.startsWith(`${base}/`);

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: B, icon: Gauge, isActive: (p) => p === B },
      { label: 'Alerts', route: `${B}/alerts`, icon: Bell, isActive: under(`${B}/alerts`) },
      { label: 'Issues', route: `${B}/issues`, icon: ClipboardCheck, isActive: under(`${B}/issues`) },
      { label: 'AI Advisor', route: `${B}/advisor`, icon: Sparkles, isActive: under(`${B}/advisor`), requiresAi: true },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Devices', route: `${B}/devices`, icon: Server, isActive: under(`${B}/devices`) },
      { label: 'Firewalls', route: `${B}/firewalls`, icon: BrickWall, isActive: under(`${B}/firewalls`), requiresFamily: 'firewall' },
    ],
  },
  {
    label: 'Switching & Routing',
    items: [
      { label: 'Hardware', route: `${B}/hardware`, icon: Cpu, isActive: under(`${B}/hardware`), requiresFamily: 'health' },
      { label: 'Interfaces', route: `${B}/interfaces`, icon: Cable, isActive: under(`${B}/interfaces`) },
      { label: 'Optics', route: `${B}/optics`, icon: Zap, isActive: under(`${B}/optics`), requiresFamily: 'optics' },
      { label: 'PoE', route: `${B}/poe`, icon: PlugZap, isActive: under(`${B}/poe`), requiresFamily: 'health' },
      { label: 'Routing', route: `${B}/routing`, icon: RouteIcon, isActive: under(`${B}/routing`), requiresFamily: 'routing' },
      { label: 'Resources', route: `${B}/resources`, icon: Gauge, isActive: under(`${B}/resources`) },
      { label: 'Reachability', route: `${B}/reachability`, icon: Radar, isActive: under(`${B}/reachability`), requiresFamily: 'ipsla' },
    ],
  },
  {
    label: 'Wireless',
    items: [
      { label: 'Wireless Overview', route: `${B}/wireless`, icon: Wifi, isActive: (p) => p === `${B}/wireless`, requiresFamily: 'wireless' },
      { label: 'Controllers', route: `${B}/wireless/controllers`, icon: RadioTower, isActive: under(`${B}/wireless/controllers`), requiresFamily: 'wireless' },
      { label: 'Access Points', route: `${B}/wireless/aps`, icon: Wifi, isActive: under(`${B}/wireless/aps`), requiresFamily: 'wireless' },
      { label: 'RF Analytics', route: `${B}/wireless/rf`, icon: Radio, isActive: under(`${B}/wireless/rf`), requiresFamily: 'wireless' },
      { label: 'SSIDs & Clients', route: `${B}/wireless/ssids`, icon: Users, isActive: under(`${B}/wireless/ssids`), requiresFamily: 'wireless' },
    ],
  },
  {
    label: 'Services',
    items: [
      { label: 'Voice', route: `${B}/voice`, icon: Phone, isActive: under(`${B}/voice`), requiresFamily: 'voice' },
      { label: 'Identity Services', route: `${B}/ise`, icon: Fingerprint, isActive: under(`${B}/ise`), requiresFamily: 'security' },
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

export default {
  id: 'cisco',
  label: 'Cisco',
  switcherRoute: B,
  color: BRAND,
  basePath: B,
  derived: true,
  isActive: (pathname) => pathname === B || pathname.startsWith(`${B}/`),
  navGroups,
  routes: [
    { path: 'cisco', Component: CiscoOverviewPage },
    { path: 'cisco/alerts', Component: CiscoAlertsPage },
    { path: 'cisco/issues', Component: CiscoIssuesPage },
    { path: 'cisco/advisor', Component: CiscoAdvisorPage },
    { path: 'cisco/devices', Component: CiscoDevicesPage },
    { path: 'cisco/firewalls', Component: CiscoFirewallsPage },
    { path: 'cisco/hardware', Component: CiscoHardwarePage },
    { path: 'cisco/interfaces', Component: CiscoInterfacesPage },
    { path: 'cisco/optics', Component: CiscoOpticsPage },
    { path: 'cisco/poe', Component: CiscoPoePage },
    { path: 'cisco/routing', Component: CiscoRoutingPage },
    { path: 'cisco/resources', Component: CiscoResourcesPage },
    { path: 'cisco/reachability', Component: CiscoReachabilityPage },
    { path: 'cisco/wireless', Component: CiscoWirelessOverviewPage },
    { path: 'cisco/wireless/controllers', Component: CiscoWirelessControllersPage },
    { path: 'cisco/wireless/aps', Component: CiscoWirelessApsPage },
    { path: 'cisco/wireless/rf', Component: CiscoWirelessRfPage },
    { path: 'cisco/wireless/ssids', Component: CiscoWirelessSsidsPage },
    { path: 'cisco/voice', Component: CiscoVoicePage },
    { path: 'cisco/ise', Component: CiscoIsePage },
    { path: 'cisco/privacy', Component: CiscoPrivacyPage },
    { path: 'cisco/settings', Component: CiscoSettingsPage },
  ],
};
