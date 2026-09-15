import { Network, Globe, Server } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#0057B8';

const TABS = [
  { slug: 'ip-capacity', label: 'IP Capacity', icon: Network,
    blurb: 'Network and DHCP range utilization across the estate, with the fullest blocks flagged.' },
  { slug: 'dns-hygiene', label: 'DNS Hygiene', icon: Globe,
    blurb: 'Zone and record quality issues: undeployed, unsigned, or empty zones and low TTLs.' },
  { slug: 'server-health', label: 'Server Health', icon: Server,
    blurb: 'DNS/DHCP server connectivity and deployment status across all registered BAMs.' },
];

export default function BluecatAdvisorPage() {
  return <PlatformAdvisorPage platform="bluecat" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
