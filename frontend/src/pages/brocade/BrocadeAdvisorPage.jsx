import { Waypoints, Router, Network, Cable, History, Share2 } from 'lucide-react';
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
  { slug: 'change-audit', label: 'Change Audit', icon: History,
    blurb: '30 days of zoning changes correlated in time with new issues — what changed before what broke.' },
  { slug: 'path-redundancy', label: 'Path Redundancy', icon: Share2,
    blurb: 'Hosts with a single login, one switch, or one fabric — the single points of failure by name.' },
];

export default function BrocadeAdvisorPage() {
  return <PlatformAdvisorPage platform="brocade" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
