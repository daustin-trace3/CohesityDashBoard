import { Database, ArrowLeftRight, BellRing } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#0067C5';

const TABS = [
  { slug: 'capacity', label: 'Capacity & Headroom', icon: Database,
    blurb: 'Volume and aggregate headroom, growth trends, and a procurement timeline.' },
  { slug: 'replication-health', label: 'SnapMirror Health', icon: ArrowLeftRight,
    blurb: 'SnapMirror relationship health, lag, and disaster-recovery coverage gaps.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-cluster alert patterns — systemic issues vs noise, and a prioritized triage order.' },
];

export default function NetAppAdvisorPage() {
  return <PlatformAdvisorPage platform="netapp" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
