import { HeartPulse, Network, Wifi, Fingerprint, BrickWall, Phone, GitCompare } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';
import { BRAND } from './ciscoShared';

// Slugs match the backend preset keys (GET /api/cisco/advisor/<slug>).
const TABS = [
  { slug: 'cisco_health', label: 'Device health', icon: HeartPulse,
    blurb: 'Failed and degraded Cisco and Meraki devices, with the reason ICC holds for each, by site and kind.' },
  { slug: 'cisco_switching_hardware', label: 'Switching hardware', icon: Network,
    blurb: 'Nexus line cards, stack members, PoE, optics, fans and power supplies from open issues and the health metrics.' },
  { slug: 'cisco_wireless_review', label: 'Wireless review', icon: Wifi,
    blurb: 'Controllers, access points that are down, hot radios and client load.' },
  { slug: 'cisco_ise_posture', label: 'ISE posture', icon: Fingerprint,
    blurb: 'ISE node state, session and resource load, application services and certificate expiry.' },
  { slug: 'cisco_firewall_review', label: 'Firewall review', icon: BrickWall,
    blurb: 'ASA and Meraki MX firewalls: HA state, sessions, tunnels and load.' },
  { slug: 'cisco_voice_review', label: 'Voice review', icon: Phone,
    blurb: 'Cisco voice gateways and CUBE routers, with call and error counters.' },
  { slug: 'cisco_change_review', label: 'Change review', icon: GitCompare,
    blurb: 'Config ledger changes recorded for Cisco and Meraki devices. Says so when the ledger holds none.' },
];

export default function CiscoAdvisorPage() {
  return <PlatformAdvisorPage platform="cisco" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
