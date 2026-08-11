import { Database, RefreshCw, Flame, ShieldCheck } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#7855FA';

const TABS = [
  { slug: 'capacity', label: 'Capacity', icon: Database,
    blurb: 'Cluster and container storage pressure, growth trends, and runway forecasts.' },
  { slug: 'replication', label: 'Replication', icon: RefreshCw,
    blurb: 'Protection domain replication health, stalled transfers, and RPO compliance.' },
  { slug: 'hotspots', label: 'Hotspots', icon: Flame,
    blurb: 'CPU/memory hotspots and node imbalance across hosts and VMs.' },
  { slug: 'resiliency', label: 'Resiliency', icon: ShieldCheck,
    blurb: 'Fault-tolerance posture, degraded hosts, and cluster health-check results.' },
];

export default function NxAdvisorPage() {
  return <PlatformAdvisorPage platform="nutanix" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
