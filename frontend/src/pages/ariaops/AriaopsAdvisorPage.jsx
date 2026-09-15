import { HeartPulse, BellRing, Gauge } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#78BE20';

const TABS = [
  { slug: 'resource-health', label: 'Resource Health', icon: HeartPulse,
    blurb: 'Resource health by kind across the estate — worst RED/ORANGE resources and likely causes.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Open alert patterns — systemic issues vs noise, and a prioritized triage order.' },
  { slug: 'capacity-pressure', label: 'Capacity Pressure', icon: Gauge,
    blurb: 'CPU/memory hot spots and a 14-day trend of resource and alert pressure.' },
];

export default function AriaopsAdvisorPage() {
  return <PlatformAdvisorPage platform="ariaops" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
