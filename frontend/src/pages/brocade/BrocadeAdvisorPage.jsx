import { Waypoints, Router, Network, Cable } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#CC092F';

const TABS = [
  { slug: 'fabric-health', label: 'Fabric Health', icon: Waypoints,
    blurb: 'Fabric and switch health scores across the estate, with the switches needing attention soonest.' },
  { slug: 'switch-lifecycle', label: 'Switch Lifecycle', icon: Router,
    blurb: 'Firmware-version drift and End of Support status, plus chassis certificates expiring soonest.' },
  { slug: 'zoning-review', label: 'Zoning Review', icon: Network,
    blurb: 'Zone configs, unzoned device ports, and default-access or drift risks per fabric.' },
  { slug: 'port-health', label: 'Port Health', icon: Cable,
    blurb: 'Port state and CRC error hotspots, plus the noisiest event patterns in the last 24 hours.' },
];

export default function BrocadeAdvisorPage() {
  return <PlatformAdvisorPage platform="brocade" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
