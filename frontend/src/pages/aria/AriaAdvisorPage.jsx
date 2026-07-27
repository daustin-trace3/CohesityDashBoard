import { Activity, ClipboardCheck, MonitorSmartphone } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';
import { BRAND } from './helpers';

const TABS = [
  { slug: 'operations', label: 'Operations Review', icon: Activity,
    blurb: 'Deployment and request activity — failure patterns and operational risk across instances.' },
  { slug: 'governance', label: 'Governance & Hygiene', icon: ClipboardCheck,
    blurb: 'Approval bottlenecks, stale deployments, and other governance hygiene issues.' },
  { slug: 'endpoint-health', label: 'Endpoint Health', icon: MonitorSmartphone,
    blurb: 'Endpoint and extensibility-run health — failures, expiring certs, and where to focus.' },
];

export default function AriaAdvisorPage() {
  return <PlatformAdvisorPage platform="aria" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
