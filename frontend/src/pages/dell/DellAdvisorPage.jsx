import { HardDrive, BadgeCheck, BellRing } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#007DB8';

const TABS = [
  { slug: 'hardware-health', label: 'Hardware Health', icon: HardDrive,
    blurb: 'Device health status across the fleet — failing components and likely root causes.' },
  { slug: 'lifecycle-compliance', label: 'Warranty & Firmware', icon: BadgeCheck,
    blurb: 'Warranty expiry and firmware-version drift, with an ordered remediation plan.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-device alert patterns — systemic issues vs noise, and a prioritized triage order.' },
];

export default function DellAdvisorPage() {
  return <PlatformAdvisorPage platform="dell" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
