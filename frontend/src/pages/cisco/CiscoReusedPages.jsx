// The LogicMonitor firewall, wireless, voice and ISE pages read their data through apiBase;
// here they read /api/cisco, which serves the same payloads for Cisco and Meraki devices only.
import LmFirewallsPage from '../logicmonitor/LmFirewallsPage';
import LmWirelessOverviewPage from '../logicmonitor/LmWirelessOverviewPage';
import LmWirelessControllersPage from '../logicmonitor/LmWirelessControllersPage';
import LmWirelessApsPage from '../logicmonitor/LmWirelessApsPage';
import LmWirelessRfPage from '../logicmonitor/LmWirelessRfPage';
import LmWirelessSsidsPage from '../logicmonitor/LmWirelessSsidsPage';
import LmVoicePage from '../logicmonitor/LmVoicePage';
import LmIsePage from '../logicmonitor/LmIsePage';

const A = '/cisco';

export const CiscoFirewallsPage = () => (
  <LmFirewallsPage apiBase={A} title="Firewalls" description="Cisco ASA and Meraki MX firewalls with HA, sessions, tunnels and load, from the DataSource metrics tier" />
);
export const CiscoWirelessOverviewPage = () => (
  <LmWirelessOverviewPage apiBase={A} title="Wireless" description="Cisco controllers, access points, RF and clients from the WLC DataSources in LogicMonitor" />
);
export const CiscoWirelessControllersPage = () => (
  <LmWirelessControllersPage apiBase={A} title="Wireless Controllers" description="Cisco AireOS and Catalyst 9800 controllers with HA, AP and radio health, clients and RADIUS" />
);
export const CiscoWirelessApsPage = () => (
  <LmWirelessApsPage apiBase={A} title="Access Points" description="Every Cisco AP joined to a monitored controller, with radio state, clients, channel utilization and uplink health" />
);
export const CiscoWirelessRfPage = () => (
  <LmWirelessRfPage apiBase={A} title="RF Analytics" description="Channel utilization, client load, transmit power and RRM verdicts per band, across every Cisco AP radio" />
);
export const CiscoWirelessSsidsPage = () => (
  <LmWirelessSsidsPage apiBase={A} title="SSIDs and Clients" description="Client counts per WLAN across every Cisco controller, with 24 hour trends" />
);
export const CiscoVoicePage = () => (
  <LmVoicePage apiBase={A} title="Voice" description="Cisco voice gateways and CUBE routers, from the DataSource metrics tier" />
);
export const CiscoIsePage = () => (
  <LmIsePage apiBase={A} title="Identity Services" description="Cisco ISE nodes with sessions, resources, application and certificate health, from the DataSource metrics tier" />
);
