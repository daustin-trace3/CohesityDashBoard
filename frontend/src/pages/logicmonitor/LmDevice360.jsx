import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import {
  fmtNum, fmtWhen, fmtDuration, fmtSpeed, fmtMbps, hostStatusTone, hostStatusLabel, severityTone,
  statusTextTone, titleCase, confidenceTone,
} from './helpers';
import { Modal, Tabs, Fact, UtilBar, headRow } from './ui';
import LmInterfaceHistoryModal from './LmInterfaceHistoryModal';
import EndpointsTable from './endpointsTable';
import LmMetricsTab from './LmMetricsTab';

function InterfacesTab({ rows, onOpen }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['displayName', 'description', 'instanceName'], defaultSortKey: 'ifIndex', paginate: true, deepLink: false,
    sortValues: { maxUtil: (r) => Math.max(r.inUtilPct ?? -1, r.outUtilPct ?? -1) },
  });
  if (!rows.length) return <p className="text-sm text-ink-muted py-6 text-center">No interface DataSource instances on this device.</p>;
  return (
    <>
      <div className="flex items-center gap-2 mb-2"><TableSearch ctl={ctl} placeholder="Search interface or description..." /><span className="text-[11px] text-ink-faint ml-auto">{ctl.rows.length} interface(s)</span></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            <SortTh k="displayName" label="Interface" ctl={ctl} />
            <SortTh k="statusText" label="Status" ctl={ctl} />
            <SortTh k="speedBps" label="Speed" ctl={ctl} align="right" />
            <SortTh k="inUtilPct" label="In" ctl={ctl} />
            <SortTh k="outUtilPct" label="Out" ctl={ctl} />
            <SortTh k="inErrors" label="Errors" ctl={ctl} align="right" />
            <SortTh k="inDiscards" label="Discards" ctl={ctl} align="right" />
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((i) => (
              <tr key={i.instanceId} className={`border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay ${i.stopMonitoring ? 'opacity-55' : ''}`} onClick={() => onOpen(i)}>
                <td className="py-1.5 pr-3"><p className="text-ink truncate max-w-[220px]">{i.displayName}</p><p className="text-[10px] text-ink-faint truncate max-w-[220px]">{i.description || '-'}</p></td>
                <td className="py-1.5 pr-3"><Badge tone={statusTextTone(i.statusText)}>{i.statusText || 'unknown'}</Badge></td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtSpeed(i.speedBps)}</td>
                <td className="py-1.5 pr-3"><UtilBar pct={i.inUtilPct} /><p className="text-[10px] text-ink-faint tnum">{fmtMbps(i.inMbps)}</p></td>
                <td className="py-1.5 pr-3"><UtilBar pct={i.outUtilPct} /><p className="text-[10px] text-ink-faint tnum">{fmtMbps(i.outMbps)}</p></td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum((i.inErrors || 0) + (i.outErrors || 0))}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum((i.inDiscards || 0) + (i.outDiscards || 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} />
    </>
  );
}

function AlertsTab({ rows }) {
  if (!rows.length) return <p className="text-sm text-status-ok py-6 text-center">No alerts for this device.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className={headRow}><th className="py-1.5 pr-3">Severity</th><th className="py-1.5 pr-3">DataSource</th><th className="py-1.5 pr-3">Instance</th><th className="py-1.5 pr-3">Datapoint</th><th className="py-1.5 pr-3">Value</th><th className="py-1.5 pr-3">Started</th><th className="py-1.5 pr-3">State</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className={`border-b border-cohesity-border/50 ${a.cleared ? 'opacity-60' : ''}`}>
              <td className="py-1.5 pr-3"><Badge tone={severityTone(a.severityNorm)}>{a.severityNorm || a.severity}</Badge></td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{a.datasource}</td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px] truncate max-w-[180px]">{a.instanceName || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{a.dataPointName || '-'}</td>
              <td className="py-1.5 pr-3 tnum text-ink text-[12px]">{a.alertValue ?? '-'}</td>
              <td className="py-1.5 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(a.startedAt)}</td>
              <td className="py-1.5 pr-3">{a.cleared ? <Badge tone="neutral">Cleared</Badge> : a.acked ? <Badge tone="info">Acked</Badge> : <Badge tone="crit">Open</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PropertiesTab({ properties }) {
  const rows = useMemo(() => ['system', 'auto', 'custom'].flatMap((kind) => (properties?.[kind] || []).map((p) => ({ kind, name: p.name, value: p.value }))), [properties]);
  const ctl = useTableControls(rows, { searchKeys: ['name', 'value'], defaultSortKey: 'name', paginate: true, defaultPageSize: 50, deepLink: false });
  if (!rows.length) return <p className="text-sm text-ink-muted py-6 text-center">No properties stored.</p>;
  return (
    <>
      <div className="flex items-center gap-2 mb-2"><TableSearch ctl={ctl} placeholder="Search properties..." /><span className="text-[11px] text-ink-faint ml-auto">{ctl.rows.length} propert(ies)</span></div>
      <table className="w-full text-sm">
        <thead><tr className={headRow}><SortTh k="kind" label="Kind" ctl={ctl} /><SortTh k="name" label="Name" ctl={ctl} /><th className="py-2 pr-3">Value</th></tr></thead>
        <tbody>
          {ctl.pageRows.map((p, i) => (
            <tr key={`${p.kind}-${p.name}-${i}`} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3"><Badge tone="neutral">{p.kind}</Badge></td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px] font-mono">{p.name}</td>
              <td className="py-1.5 pr-3 text-ink text-[12px] break-all">{String(p.value ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <TablePager ctl={ctl} sizes={[50, 100, 'all']} />
    </>
  );
}

function SdtTab({ rows }) {
  if (!rows.length) return <p className="text-sm text-ink-muted py-6 text-center">No scheduled downtime for this device.</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className={headRow}><th className="py-1.5 pr-3">State</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">Schedule</th><th className="py-1.5 pr-3">Start</th><th className="py-1.5 pr-3">End</th><th className="py-1.5 pr-3">Admin</th><th className="py-1.5 pr-3">Comment</th></tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id} className="border-b border-cohesity-border/40">
            <td className="py-1.5 pr-3"><Badge tone={s.isEffective ? 'warn' : 'neutral'}>{s.isEffective ? 'Active' : 'Scheduled'}</Badge></td>
            <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{s.type}</td>
            <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{s.scheduleType}</td>
            <td className="py-1.5 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(s.startAt)}</td>
            <td className="py-1.5 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(s.endAt)}</td>
            <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{s.admin || '-'}</td>
            <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{s.comment || '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UplinksTable({ rows, onDevice }) {
  return (
    <>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Uplinks to other switches</p>
      <table className="w-full text-sm mb-4">
        <thead><tr className={headRow}><th className="py-1.5 pr-3">Local port</th><th className="py-1.5 pr-3">Switch</th><th className="py-1.5 pr-3">Remote port</th><th className="py-1.5 pr-3">Source</th><th className="py-1.5 pr-3">Confidence</th><th className="py-1.5 pr-3">Local status</th><th className="py-1.5 pr-3">Far-end status</th></tr></thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={i} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3 text-ink text-[12px]">{l.srcPort || '-'}</td>
              <td className="py-1.5 pr-3 text-[12px]">
                {l.dstDeviceId ? <button onClick={() => onDevice(l.dstDeviceId)} className="text-brand hover:underline cursor-pointer">{l.dstName || `Device ${l.dstDeviceId}`}</button> : <span className="text-ink-muted">{l.dstName || '-'}</span>}
              </td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{l.dstPort || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{l.protocol || '-'}</td>
              <td className="py-1.5 pr-3">{l.confidence ? <Badge tone={confidenceTone(l.confidence)}>{l.confidence}</Badge> : '-'}</td>
              <td className="py-1.5 pr-3">{l.status ? <Badge tone={statusTextTone(l.status)}>{l.status}</Badge> : '-'}</td>
              <td className="py-1.5 pr-3">{l.farStatusText ? <Badge tone={statusTextTone(l.farStatusText)}>{l.farStatusText}</Badge> : <span className="text-[11px] text-ink-faint">unknown</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function LinksTab({ rows, uplinks, onDevice }) {
  if (!rows.length && uplinks.length) return <UplinksTable rows={uplinks} onDevice={onDevice} />;
  if (!rows.length) return <p className="text-sm text-ink-muted py-6 text-center">No neighbour links derived for this device. Links come from interface descriptions such as "to core-sw01 Gi1/0/1".</p>;
  return (
    <>
    {uplinks.length > 0 && <UplinksTable rows={uplinks} onDevice={onDevice} />}
    {uplinks.length > 0 && <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">All derived links</p>}
    <table className="w-full text-sm">
      <thead><tr className={headRow}><th className="py-1.5 pr-3">Local port</th><th className="py-1.5 pr-3">Neighbour</th><th className="py-1.5 pr-3">Remote port</th><th className="py-1.5 pr-3">Source</th><th className="py-1.5 pr-3">Confidence</th><th className="py-1.5 pr-3">Status</th></tr></thead>
      <tbody>
        {rows.map((l, i) => (
          <tr key={i} className="border-b border-cohesity-border/40">
            <td className="py-1.5 pr-3 text-ink text-[12px]">{l.srcPort || '-'}</td>
            <td className="py-1.5 pr-3 text-[12px]">
              {l.dstDeviceId ? <button onClick={() => onDevice(l.dstDeviceId)} className="text-brand hover:underline cursor-pointer">{l.dstName}</button> : <span className="text-ink-muted">{l.dstName || '-'} <span className="text-ink-faint">(unresolved)</span></span>}
            </td>
            <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{l.dstPort || '-'}</td>
            <td className="py-1.5 pr-3 text-ink-muted text-[12px]">{l.protocol}</td>
            <td className="py-1.5 pr-3"><Badge tone={l.confidence === 'high' ? 'ok' : l.confidence === 'medium' ? 'info' : 'neutral'}>{l.confidence}</Badge></td>
            <td className="py-1.5 pr-3">{l.status ? <Badge tone={statusTextTone(l.status)}>{l.status}</Badge> : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

export default function LmDevice360({ deviceId, sourceId, onClose, onSwitchDevice }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('interfaces');
  const [iface, setIface] = useState(null);
  const [metrics, setMetrics] = useState(null); // null loading, false failed

  useEffect(() => {
    setData(null);
    setError(null);
    setTab('interfaces');
    const params = sourceId ? { sourceId } : {};
    client.get(`/logicmonitor/devices/${deviceId}`, { params })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Device not found. It may have been removed from the portal.' : 'Failed to load the device.'));
    setMetrics(null);
    client.get(`/logicmonitor/devices/${deviceId}/metrics`, { params })
      .then(({ data: m }) => setMetrics(m || {}))
      .catch(() => setMetrics(false));
  }, [deviceId, sourceId]);

  const d = data?.device || {};
  const interfaces = data?.interfaces || [];
  const alerts = data?.alerts || [];
  const sdts = data?.sdts || [];
  const links = data?.links || [];
  const uplinks = Array.isArray(data?.uplinks) ? data.uplinks : [];
  const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
  const props = data?.properties || {};
  const propCount = (props.system || []).length + (props.auto || []).length + (props.custom || []).length;
  const metricDs = Array.isArray(metrics?.families) ? metrics.families.reduce((n, f) => n + (Array.isArray(f.datasources) ? f.datasources.length : 0), 0) : null;
  const openAlerts = alerts.filter((a) => !a.cleared).length;

  return (
    <Modal icon={Server} title={d.displayName || `Device ${deviceId}`} subtitle={d.name && d.name !== d.displayName ? d.name : d.description} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading device..." height={200} /> : (
        <>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Badge tone={hostStatusTone(d.hostStatus)}>{hostStatusLabel(d.hostStatus)}</Badge>
            {d.role && <Badge tone="neutral">{titleCase(d.role)}</Badge>}
            {d.isNetwork ? <Badge tone="info">Network</Badge> : null}
            {d.inSdt ? <Badge tone="warn">In SDT</Badge> : null}
            {d.alertSeverity && <Badge tone={severityTone(d.alertSeverity === 'warn' ? 'warning' : d.alertSeverity)}>Alert: {d.alertSeverity}</Badge>}
            {openAlerts > 0 && (
              <button onClick={() => navigate(`/logicmonitor/alerts?deviceId=${deviceId}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open alerts page ({openAlerts})</button>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-4">
            <Fact label="Vendor">{d.vendor}</Fact>
            <Fact label="Model">{d.model}</Fact>
            <Fact label="Version">{d.version}</Fact>
            <Fact label="Serial">{d.serial}</Fact>
            <Fact label="IPs">{(d.ips || []).join(', ') || '-'}</Fact>
            <Fact label="Sysname">{d.sysname}</Fact>
            <Fact label="Collector">{data.collector ? `${data.collector.hostname}${data.collector.isDown ? ' (down)' : ''}` : d.collectorName}</Fact>
            <Fact label="Collector build">{data.collector?.build}</Fact>
            <Fact label="Groups">{(d.groups || []).join(', ') || '-'}</Fact>
            <Fact label="Site">{d.siteKey ? <button onClick={() => navigate(`/logicmonitor/sites?site=${encodeURIComponent(d.siteKey)}`)} className="text-brand hover:underline cursor-pointer">{d.siteName || d.siteKey}</button> : (d.siteName || '-')}</Fact>
            <Fact label="Tier">{d.tier != null ? ({ 4: 'WAN edge', 3: 'Core', 2: 'Distribution', 1: 'Access' }[d.tier] || d.tier) : '-'}</Fact>
            <Fact label="Uptime">{fmtDuration(d.uptimeSeconds)}</Fact>
            <Fact label="Interfaces up">{`${fmtNum(d.ifUp)} / ${fmtNum(d.ifCount)}`}</Fact>
            <Fact label="First seen">{fmtWhen(d.firstSeen)}</Fact>
          </div>
          {d.sysinfo && <p className="text-[11px] text-ink-faint mb-3 line-clamp-2" title={d.sysinfo}>{d.sysinfo}</p>}
          <Tabs active={tab} onSelect={setTab} tabs={[
            { key: 'interfaces', label: 'Interfaces', count: interfaces.length },
            { key: 'alerts', label: 'Alerts', count: alerts.length },
            { key: 'metrics', label: 'Metrics', count: metricDs },
            { key: 'properties', label: 'Properties', count: propCount },
            { key: 'sdt', label: 'SDT', count: sdts.length },
            { key: 'endpoints', label: 'Endpoints', count: endpoints.length },
            { key: 'links', label: 'Links', count: links.length + uplinks.length },
          ]} />
          {tab === 'interfaces' && <InterfacesTab rows={interfaces} onOpen={setIface} />}
          {tab === 'alerts' && <AlertsTab rows={alerts} />}
          {tab === 'metrics' && <LmMetricsTab payload={metrics} deviceId={deviceId} sourceId={sourceId || d.sourceId} />}
          {tab === 'properties' && <PropertiesTab properties={props} />}
          {tab === 'sdt' && <SdtTab rows={sdts} />}
          {tab === 'endpoints' && (
            <>
            {endpoints.some((e) => Number(e.backupRuns7d) > 0) && (
              <div className="mb-3 rounded-lg border border-cohesity-border p-2.5">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Backup load (7d)</p>
                <div className="flex flex-wrap gap-1.5">
                  {endpoints.filter((e) => Number(e.backupRuns7d) > 0).map((e, i) => (
                    <span key={`${e.port}-${e.endpoint}-${i}`} title={e.backupLastWindow ? `Last window: ${fmtWhen(e.backupLastWindow)}` : 'No window time recorded'}>
                      <Badge tone="info">{e.port} {e.endpoint ? `(${e.endpoint})` : ''}: {fmtNum(e.backupRuns7d)} window(s)</Badge>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <EndpointsTable rows={endpoints} showSwitch={false}
              emptyText="No servers or appliances matched to this device's ports. Endpoints come from vCenter CDP or LLDP hints and from interface descriptions that name a host ICC knows." />
            </>
          )}
          {tab === 'links' && <LinksTab rows={links} uplinks={uplinks} onDevice={(id) => onSwitchDevice && onSwitchDevice(id)} />}
        </>
      )}
      {iface && <LmInterfaceHistoryModal deviceId={deviceId} sourceId={sourceId || d.sourceId} iface={iface} deviceName={d.displayName} onClose={() => setIface(null)} />}
    </Modal>
  );
}
