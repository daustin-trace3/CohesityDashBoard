import {
  Network, Gauge, BellOff, Cpu, Layers, Radar, Activity, Newspaper, AlertTriangle, GitCommit,
  Crosshair, DatabaseBackup, Repeat, Boxes, BellRing, EyeOff, ScanSearch, Cable,
} from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';
import { BRAND } from './helpers';

// Slugs map to the advisor preset keys with '-' -> '_' (routes/eon.js
// advisorReportKey pattern). site_brief is scoped and opens from Site 360.
// The shared page has no tab groups, so the list is flat, ordered by theme:
// daily, reachability and capacity, correlation, alerting, monitoring health.
const TABS = [
  { slug: 'network-brief', label: 'Network Brief', icon: Newspaper,
    blurb: 'The Overview as a morning brief: what changed in 24 hours, sites to look at first, and monitoring health.' },
  { slug: 'network-health', label: 'Network Health', icon: Network,
    blurb: 'Device status by vendor and group, dead and dead-collector devices, interfaces down, open alerts and collectors down.' },
  { slug: 'availability-review', label: 'Availability Review', icon: Activity,
    blurb: 'Dead episodes, interface flaps and check outages over the last 30 days.' },
  { slug: 'site-reachability', label: 'Site Reachability', icon: Radar,
    blurb: 'Worst links over 7 days, latency and loss anomalies, down episodes and baseline versus now per location.' },
  { slug: 'circuit-capacity', label: 'Circuit Capacity', icon: Cable,
    blurb: 'WAN circuits by p95 utilization in and out, saturated and fast-growing circuits and the sites they serve.' },
  { slug: 'interface-capacity', label: 'Interface Capacity', icon: Gauge,
    blurb: 'Busiest interfaces over 7 and 30 days, repeat hot ports, speed classes and ports that never carry traffic.' },
  { slug: 'interface-errors', label: 'Interface Errors', icon: AlertTriangle,
    blurb: 'Interfaces whose error and discard rates grew over 7 days, flapping ports and their baselines, grouped by device.' },
  { slug: 'chokepoints', label: 'Chokepoints', icon: Crosshair,
    blurb: 'Hops ICC blamed for degraded paths over 30 days, chronic versus one burst, with port state, open issues and affected apps.' },
  { slug: 'change-impact', label: 'Change Impact', icon: GitCommit,
    blurb: 'Configuration changes followed by incidents in 14 days, change volume by scope and day, and recent changes with no incident.' },
  { slug: 'backup-network-impact', label: 'Backup Network Impact', icon: DatabaseBackup,
    blurb: 'Backup windows from Cohesity overlaid on interface load, loss and latency at the same sites.' },
  { slug: 'replication-bandwidth', label: 'Replication Bandwidth', icon: Repeat,
    blurb: 'Replication flows against the circuits they cross, lag and saturation during transfer windows.' },
  { slug: 'app-network-exposure', label: 'App Network Exposure', icon: Boxes,
    blurb: 'Watched app services with their servers, switch ports, reachability checks and path blame, and where redundancy is missing.' },
  { slug: 'alert-noise', label: 'Alert Noise', icon: BellOff,
    blurb: 'Alert volume per day, conditions that keep re-firing, acked alerts left open and candidates to tune or mute.' },
  { slug: 'alert-delivery', label: 'Alert Delivery', icon: BellRing,
    blurb: 'Poll cadence and webhook events per portal, webhook lag against alert start time, and alerts only polling saw.' },
  { slug: 'suppression-review', label: 'Suppression Review', icon: EyeOff,
    blurb: 'Alerts shadowed by an upstream failure, devices in scheduled downtime, long-running or open-ended SDTs.' },
  { slug: 'collector-health', label: 'Collector Health', icon: Cpu,
    blurb: 'Collector builds, load per collector, down collectors and the devices they strand.' },
  { slug: 'monitoring-coverage', label: 'Monitoring Coverage', icon: ScanSearch,
    blurb: 'Data quality score and gap lists: devices with no site, undescribed interfaces, checks with no baseline, webhook state.' },
  { slug: 'device-lifecycle', label: 'Device Lifecycle', icon: Layers,
    blurb: 'Code levels per vendor and model, devices behind the newest version seen, single-unit models and new devices.' },
];

export default function LmAdvisorPage() {
  return <PlatformAdvisorPage platform="logicmonitor" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
