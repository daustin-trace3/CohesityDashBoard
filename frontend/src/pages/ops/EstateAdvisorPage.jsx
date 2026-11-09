import { Sunrise, FileKey, UserCheck, ShieldCheck, History, Network, Coins, CalendarClock, Gauge, Bot } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#8FA3B0';

const TABS = [
  { slug: 'daily-brief', label: 'Daily Brief', icon: Sunrise,
    blurb: 'The morning handoff - what needs a person today, what changed overnight, what is degraded but stable, with LogicMonitor services, site WAN, agent watches, EON findings and Hyper-V.' },
  { slug: 'certificate-audit', label: 'Certificate Audit', icon: FileKey,
    blurb: 'Every certificate ICC tracks across Pure, vCenter, Brocade, Hyper-V, Okta SAML, ISE and F5 - expired, 30/60/90 day buckets, renewal order.' },
  { slug: 'access-review', label: 'Access Review', icon: UserCheck,
    blurb: 'Quarterly recertification evidence - dormant accounts, wildcard holders, service accounts, direct grants, identity providers and directory sync.' },
  { slug: 'recovery-readiness', label: 'Recovery Readiness', icon: ShieldCheck,
    blurb: 'Per-application recovery scorecard from backup, replication and protection posture, now with Hyper-V, Cohesity runs, Zerto events and EON restores - and the weakest link.' },
  { slug: 'network-dependency', label: 'Network Dependency', icon: Network,
    blurb: 'How much each application leans on the network under it - sites, WAN circuits and their events, single-switch servers, open latency episodes, LogicMonitor services.' },
  { slug: 'change-ledger', label: 'Change Ledger', icon: History,
    blurb: '30 days of recorded config changes across every scope the ledger tracks, plus Aria deployments added and removed, with access-widening flags.' },
  { slug: 'cloud-cost-posture', label: 'Cloud Cost Posture', icon: Coins,
    blurb: 'AWS spend, forecast, budgets, anomalies, Savings Plan and RI coverage, EON cost, Lightsail, and the savings worth doing first.' },
  { slug: 'lifecycle-support', label: 'Lifecycle and Support', icon: CalendarClock,
    blurb: 'Hardware and software past or near end of support - Pure1, NetApp ONTAP, Dell warranty, guest OS, LogicMonitor code levels - with the source of every date.' },
  { slug: 'capacity-outlook', label: 'Capacity Outlook', icon: Gauge,
    blurb: 'Days to full from 30 days of history - datastores, clusters, Hyper-V volumes, NetApp, Pure, Cohesity - ranked, with no guess where growth is flat.' },
  { slug: 'ops-agent-review', label: 'Ops Agent Review', icon: Bot,
    blurb: 'How the Operations Agent did over 30 days - what it opened, healed, escalated and what keeps repeating - with setting changes where the data shows noise.' },
];

export default function EstateAdvisorPage() {
  return <PlatformAdvisorPage platform="estate" brand={BRAND} title="Estate Advisor" tabs={TABS} />;
}
