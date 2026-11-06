import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FolderTree, Layers, ArrowUpRight } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, arr, useVisibleInterval } from './helpers';
import { GroupTree, GroupDevicesTable, StateDot, stateWord, stateBadgeTone, stateColor } from './groupTree';
import LmDevice360 from './LmDevice360';
import { sel, chipBtn } from './ui';

const REFRESH_MS = 60000;
const toNodeId = (sid) => (sid ? String(sid).replace('-', ':') : null);
const toServiceId = (node) => `${node.sourceId}-${node.groupId}`;

function Tile({ label, value, tone }) {
  return (
    <div className="rounded-lg border border-cohesity-border bg-surface-overlay px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="text-lg font-bold tnum" style={{ color: tone }}>{fmtNum(value)}</p>
    </div>
  );
}

export default function LmGroupsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const sourceId = searchParams.get('sourceId') || '';
  const selectedSid = searchParams.get('group') || '';
  const selectedId = toNodeId(selectedSid);

  const [sources, setSources] = useState(null);
  const [data, setData] = useState(null); // { summary, nodes }
  const [services, setServices] = useState([]);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [query, setQuery] = useState('');
  const [worstFirst, setWorstFirst] = useState(true);
  const [devRows, setDevRows] = useState(null);
  const [device, setDevice] = useState(null);

  const setParam = useCallback((k, v) => {
    setSearchParams((cur) => {
      const n = new URLSearchParams(cur);
      if (v) n.set(k, v); else n.delete(k);
      return n;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    client.get('/logicmonitor/sources')
      .then(({ data: d }) => setSources(Array.isArray(d) ? d : arr(d?.sources)))
      .catch(() => setSources([]));
  }, []);

  const load = useCallback(() => {
    const params = sourceId ? { sourceId } : undefined;
    return Promise.all([
      client.get('/logicmonitor/groups', { params }),
      client.get('/logicmonitor/services').catch(() => ({ data: {} })),
    ]).then(([g, s]) => {
      setData({ summary: g.data?.summary || {}, nodes: arr(g.data?.nodes) });
      setServices(arr(s.data?.services));
      setLastRefreshed(new Date());
    }).catch(() => {
      setData((cur) => cur || { summary: {}, nodes: [] });
      toast({ type: 'error', title: 'Failed to load groups' });
    });
  }, [sourceId, toast]);

  useEffect(() => { setData(null); load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const nodes = data?.nodes || [];
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);
  const service = useMemo(() => (selected ? services.find((s) => s.serviceId === toServiceId(selected) && !s.missing) : null), [services, selected]);

  const fetchDevices = useCallback((node, descendants) => client.get(`/logicmonitor/groups/${node.groupId}/devices`, {
    params: { sourceId: node.sourceId, descendants: descendants ? 1 : 0 },
  }).then(({ data: d }) => arr(d?.devices)), []);

  // Devices for the right pane follow the selection and the 60 s refresh (nodes change identity on each load).
  useEffect(() => {
    if (!selected) { setDevRows(null); return undefined; }
    let live = true;
    fetchDevices(selected, true).then((r) => { if (live) setDevRows(r); }).catch(() => { if (live) setDevRows([]); });
    return () => { live = false; };
  }, [selected?.id, data, fetchDevices]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTreeDevices = useCallback((node) => fetchDevices(node, false), [fetchDevices]);

  const loading = data == null || sources == null;
  const sm = data?.summary || {};
  const dv = sm.devices || {};
  const srcList = arr(sources);
  const noPortal = sources != null && srcList.length === 0;

  const selectNode = (n) => setParam('group', toServiceId(n));

  return (
    <div className="animate-fade-in">
      <PageHeader icon={FolderTree} title="Groups" description="Every LogicMonitor device group with the state of its members rolled up. Open a group down to its devices.">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={FolderTree} label="Failed groups" value={fmtNum(sm.failed || 0)} tone={sm.failed ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={FolderTree} label="Degraded groups" value={fmtNum(sm.degraded || 0)} tone={sm.degraded ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={FolderTree} label="Operational" value={fmtNum(sm.ok || 0)} tone="ok" loading={loading} />
        <StatCard icon={FolderTree} label="Devices" value={fmtNum(dv.total || 0)} sub={`${fmtNum(dv.crit || 0)} failed, ${fmtNum(dv.warn || 0)} degraded, ${fmtNum(dv.ok || 0)} ok`} loading={loading} />
      </div>

      {noPortal ? (
        <div className="panel p-4 text-sm text-ink-muted py-8 text-center">
          No portal connected. Add one under <Link to="/logicmonitor/settings?section=portals" className="text-brand hover:underline">Settings, Portals</Link>.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <Panel title="Groups" icon={FolderTree}
            actions={(
              <>
                <button type="button" aria-pressed={worstFirst} onClick={() => setWorstFirst((v) => !v)} className={chipBtn(worstFirst)}>Worst first</button>
              </>
            )}>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search groups..."
                className="flex-1 min-w-[160px] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-sm text-ink focus:border-brand/60 outline-none" />
              {srcList.length > 1 && (
                <select value={sourceId} onChange={(e) => { setParam('sourceId', e.target.value); setParam('group', ''); }} className={sel} aria-label="Portal">
                  <option value="">All portals</option>
                  {srcList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
            </div>
            {loading ? <LoadingPanel label="Loading groups..." height={200} /> : nodes.length === 0 ? (
              <p className="text-sm text-ink-muted py-6 text-center">No groups collected yet. They arrive with the first poll.</p>
            ) : (
              <div className="max-h-[70vh] overflow-y-auto">
                <GroupTree nodes={nodes} selectedId={selectedId} onSelect={selectNode} loadDevices={loadTreeDevices}
                  worstFirst={worstFirst} query={query} onOpenDevice={(d) => setDevice({ id: d.id, sourceId: d.sourceId })} />
              </div>
            )}
          </Panel>

          <Panel title={selected ? selected.fullPath : 'Group detail'} icon={Layers}
            actions={selected && service ? (
              <Link to={`/logicmonitor/services/${encodeURIComponent(service.serviceId)}`}
                className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-brand/30 bg-brand/10 text-brand hover:bg-brand/20">
                Open service page <ArrowUpRight size={12} />
              </Link>
            ) : null}>
            {!selected ? (
              <p className="text-sm text-ink-muted py-8 text-center">Select a group to see its devices.</p>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <StateDot state={selected.state} size={12} />
                  <Badge tone={stateBadgeTone(selected.state)}>{stateWord(selected.state)}</Badge>
                  {arr(selected.reasons).length ? <span className="text-[12px] text-ink-muted">{arr(selected.reasons).join('. ')}</span> : null}
                </div>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  <Tile label="Failed" value={selected.counts?.crit || 0} tone={stateColor('failed')} />
                  <Tile label="Degraded" value={selected.counts?.warn || 0} tone={stateColor('degraded')} />
                  <Tile label="Operational" value={selected.counts?.ok || 0} tone={stateColor('ok')} />
                </div>
                {devRows == null ? <LoadingPanel label="Loading devices..." height={120} /> : (
                  <GroupDevicesTable rows={devRows} lastCol="subGroup" onOpen={(d) => setDevice({ id: d.id, sourceId: d.sourceId })} />
                )}
              </>
            )}
          </Panel>
        </div>
      )}

      {device && (
        <LmDevice360 deviceId={device.id} sourceId={device.sourceId} onClose={() => setDevice(null)}
          onSwitchDevice={(id) => setDevice((cur) => ({ id, sourceId: cur?.sourceId || null }))} />
      )}
    </div>
  );
}
