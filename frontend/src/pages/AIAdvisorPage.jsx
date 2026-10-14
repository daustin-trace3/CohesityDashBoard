// Cohesity estate AI Advisor - thin wrapper over the shared
// PlatformAdvisorPage (rail + inline reading pane since 2026-10-05; this
// page predated the shared component and carried its own tile grid).
import {
  Database, ArrowLeftRight, Newspaper, ShieldAlert, Gauge, BellRing, ShieldCheck, GitCompareArrows, ArrowUpCircle,
} from 'lucide-react';
import PlatformAdvisorPage from '../components/PlatformAdvisorPage';

const TABS = [
  { slug: 'executive-digest', label: 'Executive Digest', icon: Newspaper,
    blurb: 'A leadership brief across capacity, alerts, backup, and DR — top risks and where to focus this week.' },
  { slug: 'capacity', label: 'Capacity Planning', icon: Database,
    blurb: 'Fleet-wide capacity runway, growth trends, and a procurement timeline from 30 days of metrics history.' },
  { slug: 'dr-readiness', label: 'DR Readiness', icon: ArrowLeftRight,
    blurb: 'Replication health, off-site policy coverage, and disaster-recovery gaps across the estate.' },
  { slug: 'backup-failures', label: 'Backup Failure Analysis', icon: ShieldAlert,
    blurb: 'Fleet backup success rate plus root-cause clustering of recurring protection-job failures (7 days).' },
  { slug: 'storage-efficiency', label: 'Storage Efficiency', icon: Gauge,
    blurb: 'Data-reduction across the fleet — low-dedup outliers, likely causes, and where to reclaim space.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-cluster alert patterns — systemic issues vs noise, and a prioritized triage order.' },
  { slug: 'ransomware-resilience', label: 'Ransomware Resilience', icon: ShieldCheck,
    blurb: 'Immutability (DataLock) and off-site coverage, unprotected data, and recovery readiness vs an attack.' },
  { slug: 'what-changed', label: "What Changed", icon: GitCompareArrows,
    blurb: 'Week-over-week digest: alert spikes, backup regressions, and the biggest capacity movers.' },
  { slug: 'upgrade-advisory', label: 'Upgrade Advisory', icon: ArrowUpCircle,
    blurb: 'Software-version drift across the fleet and an ordered convergence/upgrade plan.' },
];

export default function AIAdvisorPage() {
  return <PlatformAdvisorPage platform="cohesity" title="AI Advisor" tabs={TABS} />;
}
