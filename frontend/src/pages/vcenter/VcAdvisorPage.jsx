import { Database, ClipboardCheck, Gauge, HardDrive, ArrowLeftRight } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#0091DA';

const TABS = [
  { slug: 'capacity', label: 'Capacity & Pressure', icon: Database,
    blurb: 'Datastore and cluster capacity pressure, growth trends, and where headroom is tight.' },
  { slug: 'operations-review', label: 'Operations Review', icon: ClipboardCheck,
    blurb: 'Host and VM events — maintenance-mode churn, failures, and operational risk patterns.' },
  { slug: 'efficiency', label: 'Efficiency & Hygiene', icon: Gauge,
    blurb: 'Orphaned VMs, oversized allocations, and other reclaimable-resource hygiene issues.' },
  { slug: 'guest-storage', label: 'Guest Storage', icon: HardDrive,
    blurb: 'In-guest volumes over threshold and filling soonest, grouped by the owner tag, with blind spots.' },
  { slug: 'failover-readiness', label: 'Failover Readiness', icon: ArrowLeftRight,
    blurb: 'Per-site utilization and each failover pair — does a failover fit today, in both directions.' },
];

export default function VcAdvisorPage() {
  return <PlatformAdvisorPage platform="vcenter" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
