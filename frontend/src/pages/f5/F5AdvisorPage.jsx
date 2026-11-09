import { HeartPulse, Gauge, ShieldCheck, Layers, GitCompare, Repeat, TrendingUp } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';
import { BRAND } from './f5Shared';

// Slugs match the backend preset keys (GET /api/f5/advisor/<slug>).
const TABS = [
  { slug: 'f5_health', label: 'Device health', icon: HeartPulse,
    blurb: 'Device state, failover pairs, sync state and daemons that exited, with the reason ICC holds for each.' },
  { slug: 'f5_capacity', label: 'Capacity', icon: Gauge,
    blurb: 'CPU, memory, client and server connections and pool member load against the thresholds.' },
  { slug: 'f5_cert_audit', label: 'Certificate audit', icon: ShieldCheck,
    blurb: 'SSL certificates on virtual servers expiring inside 30, 60 and 90 days.' },
  { slug: 'f5_pool_review', label: 'Pool review', icon: Layers,
    blurb: 'Degraded pools and the members that are down, by device and site.' },
  { slug: 'f5_change_review', label: 'Change review', icon: GitCompare,
    blurb: 'Config ledger changes recorded for F5 devices. Says so when the ledger holds none.' },
  { slug: 'f5_ha_review', label: 'HA review', icon: Repeat,
    blurb: 'HA pairs: both or neither active, sync state, failover headroom and standby share.' },
  { slug: 'f5_forecast', label: 'Forecast', icon: TrendingUp,
    blurb: 'CPU, memory and filesystem forecasts with the basis of each fit; insufficient data is called out.' },
];

export default function F5AdvisorPage() {
  return <PlatformAdvisorPage platform="f5" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
