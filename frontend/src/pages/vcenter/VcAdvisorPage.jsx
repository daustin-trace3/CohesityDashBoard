import { Database, ClipboardCheck, Gauge } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#0091DA';

const TABS = [
  { slug: 'capacity', label: 'Capacity & Pressure', icon: Database,
    blurb: 'Datastore and cluster capacity pressure, growth trends, and where headroom is tight.' },
  { slug: 'operations-review', label: 'Operations Review', icon: ClipboardCheck,
    blurb: 'Host and VM events — maintenance-mode churn, failures, and operational risk patterns.' },
  { slug: 'efficiency', label: 'Efficiency & Hygiene', icon: Gauge,
    blurb: 'Orphaned VMs, oversized allocations, and other reclaimable-resource hygiene issues.' },
];

export default function VcAdvisorPage() {
  return <PlatformAdvisorPage platform="vcenter" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
