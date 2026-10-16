import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate, Navigate } from 'react-router-dom';
import {
  Scale, Layers, Cpu, Skull, BellRing, Repeat, Waypoints, History,
  ListTree, Plug, EyeOff, ShieldCheck, Radar,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen } from './helpers';
import {
  ListSection, codeLevelColumns, buildColumns, deadColumns, alertColumns, noisyColumns,
  topologyColumns, changeColumns, shadowedColumns,
} from './governanceSections';
import DataQualitySection from './dataQualitySection';
import { ModelReviewSection, EndpointsSection } from './inventorySections';
import LmDevice360 from './LmDevice360';

// Round 10: neighbours LogicMonitor's CDP/LLDP discovery sees that nothing monitors.
const unmonitoredColumns = [
  { k: 'name', label: 'Neighbour' },
  { k: 'kind', label: 'Seen by', render: (r) => (r.kind === 'lldp' ? 'LLDP' : 'CDP') },
  { k: 'portsSeen', label: 'Ports seen', align: 'right', render: (r) => fmtNum(r.portsSeen) },
  { k: 'devicesSeen', label: 'Devices seen', align: 'right', render: (r) => fmtNum(r.devicesSeen) },
  { k: 'firstSeen', label: 'First seen', render: (r) => fmtWhen(r.firstSeen) },
  { k: 'sampleDevice', label: 'Sample switch', render: (r) => r.sampleDevice || '-' },
  { k: 'samplePort', label: 'Sample port', render: (r) => <span className="font-mono text-[11px]">{r.samplePort || '-'}</span> },
];

function NavChip({ count, tone }) {
  if (!count) return null;
  const cls = tone === 'crit' ? 'bg-status-crit/15 text-status-crit'
    : tone === 'warn' ? 'bg-status-warn/15 text-status-warn'
    : 'bg-surface-overlay text-ink-faint';
  return <span className={`ml-auto tnum text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${cls}`}>{count}</span>;
}

const DEFAULT_SECTION = 'modelReview';

export default function LmGovernancePage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [device, setDevice] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/governance')
    .then(({ data: d }) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch(() => { setData((cur) => cur || {}); toast({ type: 'error', title: 'Failed to load governance data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const g = data || {};
  const hyg = g.alertHygiene || {};
  const behindLevels = (g.codeLevels || []).filter((r) => r.behind).reduce((s, r) => s + (r.count || 0), 0);
  const behindBuilds = (g.collectorBuilds || []).filter((r) => r.behind).reduce((s, r) => s + (r.count || 0), 0);
  const openDevice = (r) => r.id && navigate(`/logicmonitor/devices?device=${r.id}`);
  const showDevice = (id, sourceId) => id && setDevice({ id, sourceId: sourceId || null });
  const modelReview = Array.isArray(g.modelReview) ? g.modelReview : [];
  const endpoints = Array.isArray(g.endpoints) ? g.endpoints : [];
  const behindModels = modelReview.filter((r) => r.behind).length;
  const shadowedAlerts = Array.isArray(g.shadowedAlerts) ? g.shadowedAlerts : [];
  const dq = g.dataQuality && typeof g.dataQuality === 'object' ? g.dataQuality : {};
  const dqGaps = ['portsNoDescription', 'switchesNoNeighbors', 'devicesNoSite', 'checksNoBaseline'].reduce((n, k) => n + (Array.isArray(dq[k]) ? dq[k].length : 0), 0);

  const navGroups = [
    { label: 'Inventory', items: [
      { id: 'modelReview', label: 'Model Review', icon: ListTree, count: modelReview.length, tone: behindModels ? 'warn' : 'default' },
      { id: 'endpoints', label: 'Switch Ports to Endpoints', icon: Plug, count: g.endpointsSummary?.total ?? endpoints.length, tone: 'default' },
    ] },
    { label: 'Lifecycle', items: [
      { id: 'codeLevels', label: 'Code Levels', icon: Layers, count: behindLevels, tone: behindLevels ? 'warn' : 'default' },
      { id: 'collectorBuilds', label: 'Collector Builds', icon: Cpu, count: behindBuilds, tone: behindBuilds ? 'warn' : 'default' },
      { id: 'deadDevices', label: 'Dead and Lost', icon: Skull, count: (g.deadDevices || []).length, tone: (g.deadDevices || []).length ? 'crit' : 'default' },
    ] },
    { label: 'Alert Hygiene', items: [
      { id: 'ackedOpenOver7d', label: 'Acked, Open 7d+', icon: BellRing, count: (hyg.ackedOpenOver7d || []).length, tone: 'warn' },
      { id: 'noisyConditions', label: 'Noisy Conditions', icon: Repeat, count: (hyg.noisyConditions || []).length, tone: 'default' },
      { id: 'shadowedAlerts', label: 'Shadowed Alerts', icon: EyeOff, count: shadowedAlerts.length, tone: 'default' },
    ] },
    { label: 'Data Quality', items: [
      { id: 'dataQuality', label: 'Data Quality', icon: ShieldCheck, count: dqGaps, tone: 'warn' },
    ] },
    { label: 'Topology and Change', items: [
      { id: 'topologyUnmatched', label: 'Unmatched Links', icon: Waypoints, count: (g.topologyUnmatched || []).length, tone: 'default' },
      { id: 'unmonitoredNeighbors', label: 'Unmonitored Neighbours', icon: Radar, count: (g.unmonitoredNeighbors || []).length, tone: 'default' },
      { id: 'configChanges', label: 'Config Changes', icon: History, count: (g.configChanges || []).length, tone: 'default' },
    ] },
  ];
  const ids = navGroups.flatMap((x) => x.items.map((i) => i.id));
  const raw = searchParams.get('section') || DEFAULT_SECTION;
  const section = ids.includes(raw) ? raw : DEFAULT_SECTION;
  const selectSection = (id) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', id);
    setSearchParams(next, { replace: true });
  };

  const moved = { noInterfaceDatasource: 'coverage', inSdt: 'coverage', alertingDisabled: 'coverage', notPolled24h: 'coverage', backupWindows: 'correlation' }[raw];
  if (moved) return <Navigate to={`/logicmonitor/${moved}?section=${raw}`} replace />;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Scale} title="Governance" description="Model review, switch port endpoints, code levels, collector builds, monitoring coverage, alert hygiene and change history across LogicMonitor portals">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? <LoadingPanel label="Loading governance data..." height={200} /> : (
        <div className="flex gap-4 items-start">
          <div className="panel p-2 w-56 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
            {navGroups.map((grp, gi) => (
              <div key={grp.label} className={gi > 0 ? 'mt-2 pt-2 border-t border-cohesity-border/50' : ''}>
                <p className="px-2.5 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">{grp.label}</p>
                {grp.items.map((n) => (
                  <button key={n.id} type="button" onClick={() => selectSection(n.id)}
                    className={`flex items-center gap-2 w-full text-left text-xs rounded-lg px-2.5 py-2 transition-colors cursor-pointer ${section === n.id ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay/60'}`}>
                    <n.icon size={14} className={section === n.id ? 'text-brand' : 'text-ink-faint'} />
                    <span className="truncate">{n.label}</span>
                    <NavChip count={n.count} tone={n.tone} />
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="flex-1 min-w-0">
            {section === 'modelReview' && (
              <ModelReviewSection key={section} rows={modelReview} rollups={g.rollups} onDevice={showDevice} />
            )}
            {section === 'endpoints' && (
              <EndpointsSection key={section} rows={endpoints} summary={g.endpointsSummary} onDevice={showDevice} />
            )}
            {section === 'codeLevels' && (
              <ListSection key={section} section={section} icon={Layers} title="Code Levels" rows={g.codeLevels}
                blurb="Software versions per vendor and model, parsed from sysinfo. Behind means not on the newest version seen in this estate; no vendor end-of-support dates are used."
                columns={codeLevelColumns} searchKeys={['vendor', 'model', 'version']} defaultSortKey="vendor" emptyText="No versions parsed yet." emptyTone="muted" />
            )}
            {section === 'collectorBuilds' && (
              <ListSection key={section} section={section} icon={Cpu} title="Collector Builds" rows={g.collectorBuilds}
                blurb="Collector builds in service, compared with the portal's current mandatory general release (MGD)."
                columns={buildColumns} defaultSortKey="count" defaultSortDir="desc" emptyText="No collectors reported." emptyTone="muted" />
            )}
            {section === 'deadDevices' && (
              <ListSection key={section} section={section} icon={Skull} title="Dead and Lost Devices" rows={g.deadDevices} onRow={openDevice}
                blurb="Devices LogicMonitor reports dead (no data) or dead-collector (their collector is down), with how long they have been that way."
                columns={deadColumns} searchKeys={['displayName', 'collectorName']} defaultSortKey="sinceMs" emptyText="No dead devices." />
            )}
            {section === 'ackedOpenOver7d' && (
              <ListSection key={section} section={section} icon={BellRing} title="Acknowledged but Open for 7+ Days" rows={hyg.ackedOpenOver7d}
                blurb={`Alerts someone acknowledged and nobody fixed. ${fmtNum(hyg.unrouted || 0)} open alert(s) have no escalation rule at all.`}
                columns={alertColumns} searchKeys={['monitorObjectName', 'datasource', 'dataPointName', 'ackedBy']} defaultSortKey="startedAt" emptyText="No stale acknowledged alerts." />
            )}
            {section === 'noisyConditions' && (
              <ListSection key={section} section={section} icon={Repeat} title="Noisy Conditions" rows={hyg.noisyConditions}
                blurb="The same resource, DataSource and datapoint firing again and again over 30 days. Candidates for a threshold change or a fix at the source."
                columns={noisyColumns} searchKeys={['monitorObjectName', 'datasource', 'dataPointName']} defaultSortKey="count30d" defaultSortDir="desc" emptyText="No repeat offenders." />
            )}
            {section === 'shadowedAlerts' && (
              <ListSection key={section} section={section} icon={EyeOff} title="Shadowed Alerts" rows={shadowedAlerts}
                blurb="Open alerts on devices that sit behind an upstream device or port that is itself down. They are held back from the alert feed and the Ops Agent so the upstream failure is the one incident."
                columns={shadowedColumns} searchKeys={['monitorObjectName', 'deviceName', 'datasource', 'dataPointName']} defaultSortKey="startedAt" defaultSortDir="desc" emptyText="No alerts are shadowed right now." emptyTone="muted" />
            )}
            {section === 'dataQuality' && <DataQualitySection key={section} data={dq} />}
            {section === 'topologyUnmatched' && (
              <ListSection key={section} section={section} icon={Waypoints} title="Unmatched Link Descriptions" rows={g.topologyUnmatched}
                blurb="Interface descriptions that look like a link (contain 'to' or 'uplink') but name no device ICC knows. Fix the description or the device name and the link appears on the topology map."
                columns={topologyColumns} searchKeys={['deviceName', 'displayName', 'description']} defaultSortKey="deviceName" emptyText="Every link description resolved." />
            )}
            {section === 'unmonitoredNeighbors' && (
              <ListSection key={section} section={section} icon={Radar} title="Neighbours LogicMonitor does not monitor" rows={g.unmonitoredNeighbors}
                blurb="Devices that CDP or LLDP report on a monitored switch port but that match no LogicMonitor device or ICC host by name, serial or MAC. Add them to LogicMonitor to see their links on the topology map."
                columns={unmonitoredColumns} searchKeys={['name', 'sampleDevice', 'samplePort']} defaultSortKey="firstSeen" defaultSortDir="desc" emptyText="Every neighbour LogicMonitor discovers is monitored." />
            )}
            {section === 'configChanges' && (
              <ListSection key={section} section={section} icon={History} title="Config Changes" rows={g.configChanges}
                blurb="The last 50 changes the config ledger recorded for LogicMonitor: device inventory (model, version, collector, groups), collector builds and admin accounts. The first snapshot is a silent baseline."
                columns={changeColumns} searchKeys={['scope', 'system', 'item']} defaultSortKey="detectedAt" defaultSortDir="desc" emptyText="No changes recorded yet." emptyTone="muted" />
            )}
          </div>
        </div>
      )}
      {device && (
        <LmDevice360 deviceId={device.id} sourceId={device.sourceId} onClose={() => setDevice(null)}
          onSwitchDevice={(id) => setDevice((cur) => ({ id, sourceId: cur?.sourceId || null }))} />
      )}
    </div>
  );
}
