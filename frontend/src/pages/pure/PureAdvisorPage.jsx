import { Database, Gauge, BellRing, ShieldCheck, HardDrive, Cable } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#FF6B00';

const TABS = [
  { slug: 'capacity', label: 'Capacity & Growth', icon: Database,
    blurb: 'Array capacity runway, growth trends, and where reclaimable space is hiding.' },
  { slug: 'performance', label: 'Performance Review', icon: Gauge,
    blurb: 'Latency, IOPS, and throughput patterns across volumes — hotspots and likely causes.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-array alert patterns — systemic issues vs noise, and a prioritized triage order.' },
  { slug: 'protection-posture', label: 'Protection Posture', icon: ShieldCheck,
    blurb: 'Protection group schedules and retention, replication links, and ActiveCluster pod health.' },
  { slug: 'hardware-lifecycle', label: 'Hardware & Lifecycle', icon: HardDrive,
    blurb: 'Controllers, failed drives and components, and certificates expiring within 90 days.' },
  { slug: 'host-connectivity', label: 'Host Connectivity', icon: Cable,
    blurb: 'Hosts with single connections or no volumes, and volumes mapped to no host.' },
];

export default function PureAdvisorPage() {
  return <PlatformAdvisorPage platform="pure" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
