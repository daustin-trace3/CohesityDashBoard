import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, arr, useVisibleInterval } from './helpers';
import { GroupTree, GroupDevicesTable, StateDot, stateWord, stateBadgeTone } from './groupTree';
import { Fact } from './ui';
import LmDevice360 from './LmDevice360';

const REFRESH_MS = 60000;

export default function LmServicePage() {
  const { serviceId } = useParams();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [gone, setGone] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [device, setDevice] = useState(null);

  const load = useCallback(() => client.get(`/logicmonitor/services/${encodeURIComponent(serviceId)}`)
    .then(({ data: d }) => { setData(d || {}); setGone(false); setLastRefreshed(new Date()); })
    .catch((e) => {
      if (e?.response?.status === 404) { setGone(true); setData({}); return; }
      setData((cur) => cur || {});
      toast({ type: 'error', title: 'Failed to load the service' });
    }), [serviceId, toast]);

  useEffect(() => { setData(null); setGone(false); load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const service = data?.service || null;
  const subGroups = arr(data?.subGroups);
  const devices = arr(data?.devices);
  const related = data?.related || {};

  const treeNodes = useMemo(() => (service ? [service, ...subGroups.filter((n) => n.id !== service.id)] : []), [service, subGroups]);
  const loadTreeDevices = useCallback((node) => client.get(`/logicmonitor/groups/${node.groupId}/devices`, {
    params: { sourceId: node.sourceId, descendants: 0 },
  }).then(({ data: d }) => arr(d?.devices)), []);

  if (data == null) {
    return <div className="animate-fade-in"><LoadingPanel label="Loading service..." height={240} /></div>;
  }
  if (gone || !service) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={Layers} title="Service" description="LogicMonitor service group" />
        <Panel>
          <p className="text-sm text-ink-muted py-6 text-center">
            This service is no longer picked. <Link to="/logicmonitor/settings?section=servicegroups" className="text-brand hover:underline">Pick services in Settings</Link>.
          </p>
        </Panel>
      </div>
    );
  }

  const counts = service.counts || {};
  const alerts = related.openAlerts || {};
  const circuits = related.circuits || {};
  const sites = arr(related.sitesTouched);
  const incidents = related.openIncidents || 0;
  const label = service.label || service.name;
  const composite = service.kind === 'composite';
  const roleMembers = arr(service.members).filter((m) => m.kind === 'role');
  const rankOf = { failed: 0, degraded: 1, ok: 2, unknown: 3 };
  const memberRows = subGroups.slice().sort((a, b) => (rankOf[a.state] - rankOf[b.state]) || String(a.fullPath).localeCompare(String(b.fullPath)));
  const description = composite
    ? `Group of ${fmtNum(memberRows.length)} groups, ${fmtNum(counts.total || 0)} devices${arr(service.reasons).length ? `. ${arr(service.reasons).join('. ')}` : ''}`
    : `${service.fullPath || service.name} - ${fmtNum(counts.total || 0)} devices${arr(service.reasons).length ? `. ${arr(service.reasons).join('. ')}` : ''}`;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers}
        title={(
          <span className="inline-flex items-center gap-2.5 flex-wrap">
            <StateDot state={service.state} size={16} />
            <span>{label}</span>
            <Badge tone={stateBadgeTone(service.state)}>{stateWord(service.state)}</Badge>
          </span>
        )}
        description={description}>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Layers} label="Failed" value={fmtNum(counts.crit || 0)} tone={counts.crit ? 'crit' : 'ok'} />
        <StatCard icon={Layers} label="Degraded" value={fmtNum(counts.warn || 0)} tone={counts.warn ? 'warn' : 'ok'} />
        <StatCard icon={Layers} label="Operational" value={fmtNum(counts.ok || 0)} tone="ok" />
        <StatCard icon={Layers} label="Open incidents" value={fmtNum(incidents)} tone={incidents ? 'warn' : 'ok'}
          sub={incidents ? 'Open Ops Agent' : undefined}
          onClick={incidents ? () => navigate('/ops/agent') : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)] mb-4">
        {composite ? (
          <Panel title="Members" icon={Layers}>
            <div className="max-h-[60vh] overflow-y-auto">
              {memberRows.length === 0 && roleMembers.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">No group matches the members of this service yet.</p>
              ) : null}
              {roleMembers.map((m, i) => (
                <p key={`role-${i}`} className="text-xs text-ink py-1.5 border-b border-cohesity-border">
                  {`Role: ${m.role} (${fmtNum(m.matched || 0)} devices)`}
                  {m.sourceId != null ? <span className="text-ink-faint">{` - portal ${m.sourceId}`}</span> : null}
                </p>
              ))}
              {memberRows.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-ink-faint">
                      <th className="py-1 pr-2 font-medium">Group</th>
                      <th className="py-1 px-1 font-medium text-right">Failed</th>
                      <th className="py-1 px-1 font-medium text-right">Degraded</th>
                      <th className="py-1 pl-1 font-medium text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberRows.map((n) => (
                      <tr key={n.id} className="border-t border-cohesity-border">
                        <td className="py-1.5 pr-2">
                          <span className="inline-flex items-center gap-2 min-w-0">
                            <StateDot state={n.state} size={10} />
                            <span className="truncate" title={arr(n.reasons).join('. ') || stateWord(n.state)}>{n.fullPath}</span>
                          </span>
                        </td>
                        <td className="py-1.5 px-1 text-right tnum">{fmtNum(n.counts?.crit || 0)}</td>
                        <td className="py-1.5 px-1 text-right tnum">{fmtNum(n.counts?.warn || 0)}</td>
                        <td className="py-1.5 pl-1 text-right tnum">{fmtNum(n.counts?.total || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        ) : (
          <Panel title="Sub-groups" icon={Layers}>
            <div className="max-h-[60vh] overflow-y-auto">
              <GroupTree nodes={treeNodes} rootId={service.id} worstFirst loadDevices={loadTreeDevices}
                onSelect={() => {}} onOpenDevice={(d) => setDevice({ id: d.id, sourceId: d.sourceId })} />
            </div>
          </Panel>
        )}
        <Panel title="Devices" icon={Layers}>
          <GroupDevicesTable rows={devices} lastCol="site" showCsv csvName={`${label}-devices`}
            onOpen={(d) => setDevice({ id: d.id, sourceId: d.sourceId })} />
        </Panel>
      </div>

      <Panel title="Related" icon={Layers}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Fact label="Open alerts">{`${fmtNum(alerts.critical || 0)} critical, ${fmtNum(alerts.warning || 0)} warning`}</Fact>
          <Fact label="Circuits in branch">{`${fmtNum(circuits.total || 0)} total, ${fmtNum(circuits.down || 0)} down`}</Fact>
          <div className="min-w-0" title={sites.join(', ')}>
            <Fact label="Sites touched">{fmtNum(sites.length)}</Fact>
          </div>
          <Fact label="Open incidents">
            {incidents ? <Link to="/ops/agent" className="text-brand hover:underline">{fmtNum(incidents)}</Link> : '0'}
          </Fact>
        </div>
      </Panel>

      {device && (
        <LmDevice360 deviceId={device.id} sourceId={device.sourceId} onClose={() => setDevice(null)}
          onSwitchDevice={(id) => setDevice((cur) => ({ id, sourceId: cur?.sourceId || null }))} />
      )}
    </div>
  );
}
