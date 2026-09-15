import { HardDrive, BadgeCheck, BellRing, Thermometer, GitCompare, ListChecks, ScrollText, Boxes, LifeBuoy } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#007DB8';

const TABS = [
  { slug: 'hardware-health', label: 'Hardware Health', icon: HardDrive,
    blurb: 'Device health status across the fleet — failing components and likely root causes.' },
  { slug: 'lifecycle-compliance', label: 'Warranty & Firmware', icon: BadgeCheck,
    blurb: 'Warranty expiry and firmware-version drift, with an ordered remediation plan.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-device alert patterns — systemic issues vs noise, and a prioritized triage order.' },
  { slug: 'power-thermal', label: 'Power & Thermal', icon: Thermometer,
    blurb: 'Power trend, inlet temperature outliers and utilization hot spots across the fleet.' },
  { slug: 'config-drift', label: 'Config Drift', icon: GitCompare,
    blurb: 'Baseline compliance, stale accepted variances and the most common drifting settings.' },
  { slug: 'job-health', label: 'Job Health', icon: ListChecks,
    blurb: 'Failed, long-running and repeatedly failing OME jobs over the last 30 days.' },
  { slug: 'hardware-log-forensics', label: 'Hardware Log Forensics', icon: ScrollText,
    blurb: 'iDRAC/lifecycle log patterns and pre-failure signals across the fleet.' },
  { slug: 'capacity-consolidation', label: 'Capacity & Consolidation', icon: Boxes,
    blurb: 'Idle and hot devices, powered-off assets with warranty left, and model/generation mix.' },
  { slug: 'support-case-prep', label: 'Support Case Prep', icon: LifeBuoy,
    blurb: 'Case-ready summaries for every device in critical health.' },
];

export default function DellAdvisorPage() {
  return <PlatformAdvisorPage platform="dell" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
