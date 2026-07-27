import { Database, Gauge, BellRing } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#FF6B00';

const TABS = [
  { slug: 'capacity', label: 'Capacity & Growth', icon: Database,
    blurb: 'Array capacity runway, growth trends, and where reclaimable space is hiding.' },
  { slug: 'performance', label: 'Performance Review', icon: Gauge,
    blurb: 'Latency, IOPS, and throughput patterns across volumes — hotspots and likely causes.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-array alert patterns — systemic issues vs noise, and a prioritized triage order.' },
];

export default function PureAdvisorPage() {
  return <PlatformAdvisorPage platform="pure" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
