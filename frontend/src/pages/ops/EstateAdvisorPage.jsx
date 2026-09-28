import { Sunrise, FileKey, UserCheck, ShieldCheck } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#8FA3B0';

const TABS = [
  { slug: 'daily-brief', label: 'Daily Brief', icon: Sunrise,
    blurb: 'The morning handoff — what needs a person today, what changed overnight, what is degraded but stable.' },
  { slug: 'certificate-audit', label: 'Certificate Audit', icon: FileKey,
    blurb: 'Every certificate ICC tracks across Pure, vCenter and Brocade — expired, 30/60/90 day buckets, renewal order.' },
  { slug: 'access-review', label: 'Access Review', icon: UserCheck,
    blurb: 'Quarterly recertification evidence — dormant accounts, wildcard holders, service accounts, direct grants.' },
  { slug: 'recovery-readiness', label: 'Recovery Readiness', icon: ShieldCheck,
    blurb: 'Per-application recovery scorecard from backup, replication and protection posture — and the weakest link.' },
];

export default function EstateAdvisorPage() {
  return <PlatformAdvisorPage platform="estate" brand={BRAND} title="Estate Advisor" tabs={TABS} />;
}
