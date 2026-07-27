import { ShieldCheck, BadgeCheck, BellRing } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#EE3124';

const TABS = [
  { slug: 'dr-readiness', label: 'DR Readiness', icon: ShieldCheck,
    blurb: 'VPG replication health, RPO/RTO posture, and disaster-recovery gaps across sites.' },
  { slug: 'capacity-licensing', label: 'Capacity & Licensing', icon: BadgeCheck,
    blurb: 'Protected VM growth, journal sizing, and license consumption trends.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-VPG alert patterns — systemic issues vs noise, and a prioritized triage order.' },
];

export default function ZertoAdvisorPage() {
  return <PlatformAdvisorPage platform="zerto" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
