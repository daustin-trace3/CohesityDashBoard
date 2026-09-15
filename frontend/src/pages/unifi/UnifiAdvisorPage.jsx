import { Router, Users, Globe, ShieldAlert } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#006FFF';

const TABS = [
  { slug: 'network-health', label: 'Network Health', icon: Router,
    blurb: 'Device health across gateways, switches, and APs -- load, temperature, and firmware exceptions.' },
  { slug: 'client-experience', label: 'Client Experience', icon: Users,
    blurb: 'Wireless client counts, signal distribution, and the weakest connections by SSID.' },
  { slug: 'wan-reliability', label: 'WAN Reliability', icon: Globe,
    blurb: 'WAN/ISP latency and availability trends, with recent circuit issues.' },
  { slug: 'security-posture', label: 'Security Posture', icon: ShieldAlert,
    blurb: 'Rogue APs, weak WLAN security, and recent port/IPS/Protect issues.' },
];

export default function UnifiAdvisorPage() {
  return <PlatformAdvisorPage platform="unifi" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
