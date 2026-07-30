import { ShieldCheck, Database, RefreshCcw } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#B1181E';

const TABS = [
  { slug: 'backup-health', label: 'Backup Health', icon: ShieldCheck,
    blurb: '7-day job stats by policy and state, failing policies, stale clients, and open issues.' },
  { slug: 'capacity-planning', label: 'Capacity Planning', icon: Database,
    blurb: 'Storage unit and disk pool usage, growth trend, and front-end capacity by workload.' },
  { slug: 'resilience-review', label: 'Resilience Review', icon: RefreshCcw,
    blurb: 'SLP/replication outcomes, catalog backup age, media server/appliance health, and single-copy policies.' },
];

export default function NbAdvisorPage() {
  return <PlatformAdvisorPage platform="netbackup" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
