import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Server, Box, Pencil, Check, X, HeartPulse, RefreshCw, Info,
  HardDrive, Layers, MemoryStick, Cpu, Network, Cable, Plug, Fan, Thermometer, BatteryCharging,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated, Badge, Spinner } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtWhen, componentTypeLabel, componentStatusTone, fmtHwDetail } from './helpers';

const APPLIANCE_TONE = { appliance: 'brand', flex: 'info', byo: 'neutral' };
const APPLIANCE_LABEL = { appliance: 'Appliance', flex: 'Flex', byo: 'BYO' };

function ModelCell({ a, editable, onSaved }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(a.model || '');
  const [saving, setSaving] = useState(false);

  const start = () => { setValue(a.model || ''); setEditing(true); };
  const cancel = () => setEditing(false);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await client.put('/netbackup/appliances/model', { sourceId: a.sourceId, name: a.name, model: value.trim() });
      onSaved(data);
      setEditing(false);
      toast({ type: 'success', title: 'Model updated' });
    } catch (err) {
      toast({ type: 'error', title: 'Update failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  };

  if (!editable) {
    return (
      <span className="text-ink-muted">
        {a.model || '—'}
        {a.modelSource === 'override' && (
          <span className="text-[10px] text-ink-faint ml-1" title={a.modelRaw || ''}>(custom)</span>
        )}
      </span>
    );
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown}
          disabled={saving}
          className="w-40 bg-surface-overlay border border-cohesity-border rounded-md px-2 py-1 text-xs text-ink focus:border-brand/60 outline-none" />
        <button onClick={save} disabled={saving} title="Save" className="flex items-center justify-center h-6 w-6 rounded-md text-status-ok hover:bg-status-ok/10 cursor-pointer disabled:opacity-50">
          <Check size={13} />
        </button>
        <button onClick={cancel} disabled={saving} title="Cancel" className="flex items-center justify-center h-6 w-6 rounded-md text-ink-faint hover:text-ink cursor-pointer disabled:opacity-50">
          <X size={13} />
        </button>
      </div>
    );
  }

  return (
    <button onClick={start} title="Edit model" className="group inline-flex items-center gap-1.5 text-ink-muted hover:text-ink cursor-pointer">
      <span>
        {a.model || '—'}
        {a.modelSource === 'override' && (
          <span className="text-[10px] text-ink-faint ml-1" title={a.modelRaw || ''}>(custom)</span>
        )}
      </span>
      <Pencil size={11} className="opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

const SUMMARY_TONE = { ok: 'ok', warning: 'warn', critical: 'crit', unknown: 'neutral' };
const SUMMARY_LABEL = { ok: 'OK', warning: 'Warning', critical: 'Critical', unknown: 'Unknown' };

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-3xl max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

const COMPONENT_TYPE_ORDER = ['disk', 'raid', 'memory', 'cpu', 'network', 'fc', 'psu', 'fan', 'temperature', 'battery', 'other'];
const COMPONENT_TYPE_ICON = {
  disk: HardDrive, raid: Layers, memory: MemoryStick, cpu: Cpu, network: Network,
  fc: Cable, psu: Plug, fan: Fan, temperature: Thermometer, battery: BatteryCharging, other: Box,
};

function ComponentSection({ type, rows }) {
  const Icon = COMPONENT_TYPE_ICON[type] || Box;
  if (!rows.length) return null;
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><Icon size={13} className="text-brand" /> {componentTypeLabel(type)} ({rows.length})</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            <th className="py-1.5 pr-3">Name</th>
            <th className="py-1.5 pr-3">Status</th>
            <th className="py-1.5 pr-3">State</th>
            <th className="py-1.5 pr-3">Detail</th>
          </tr></thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={`${c.componentType}-${c.componentName}-${i}`} className="border-b border-cohesity-border/40">
                <td className="py-1.5 pr-3 text-ink max-w-[200px] truncate" title={c.componentName || ''}>{c.componentName || '—'}</td>
                <td className="py-1.5 pr-3"><Badge tone={componentStatusTone(c.status)}>{SUMMARY_LABEL[c.status] || c.status}</Badge></td>
                <td className="py-1.5 pr-3 text-ink-muted">{c.stateRaw || '—'}</td>
                <td className="py-1.5 pr-3 text-ink-muted max-w-[260px] truncate" title={fmtHwDetail(c.detail) || ''}>{fmtHwDetail(c.detail) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function applianceHealthTone(summary) {
  const s = summary || {};
  if (s.critical > 0) return 'crit';
  if (s.warning > 0) return 'warn';
  if (s.ok > 0) return 'ok';
  return 'neutral';
}
function applianceHealthLabel(summary) {
  const s = summary || {};
  if (s.critical > 0) return 'Critical';
  if (s.warning > 0) return 'Warning';
  if (s.ok > 0) return 'OK';
  return 'Unknown';
}

function ApplianceDetailModal({ conn, components, onClose }) {
  return (
    <ModalShell
      title={conn.name}
      subtitle={`${conn.host} · last poll ${fmtWhen(conn.lastPollAt)}`}
      icon={Server} onClose={onClose}>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Badge tone={applianceHealthTone(conn.summary)}>{applianceHealthLabel(conn.summary)}</Badge>
        <Badge tone={conn.lastPollStatus === 'error' ? 'crit' : conn.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
          {conn.lastPollStatus === 'error' ? 'Unreachable' : conn.lastPollStatus === 'success' ? 'Up' : 'Pending'}
        </Badge>
        {['ok', 'warning', 'critical', 'unknown'].map((k) => (
          conn.summary?.[k] ? <Badge key={k} tone={SUMMARY_TONE[k]}>{conn.summary[k]} {SUMMARY_LABEL[k]}</Badge> : null
        ))}
      </div>
      {components.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No hardware components reported yet.</div>
      ) : (
        COMPONENT_TYPE_ORDER.map((t) => (
          <ComponentSection key={t} type={t} rows={components.filter((c) => c.componentType === t)} />
        ))
      )}
    </ModalShell>
  );
}

function HardwareHealthSection() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [detailConnId, setDetailConnId] = useState(null);

  const load = useCallback(() => client.get('/netbackup/appliance-hardware')
    .then(({ data }) => setData({ connections: data.connections || [], components: data.components || [] }))
    .catch(() => setData({ connections: [], components: [] })), []);

  useEffect(() => { load(); }, [load]);

  const refresh = async (c) => {
    setRefreshingId(c.id);
    try {
      await client.post(`/netbackup/appliance-connections/${c.id}/refresh`, {}, { timeout: 300000 });
      await load();
      toast({ type: 'success', title: `${c.name} refresh triggered` });
    } catch (err) {
      toast({ type: 'error', title: `Refresh failed for ${c.name}`, message: err?.response?.data?.error });
    } finally {
      setRefreshingId(null);
    }
  };

  const connections = data?.connections || [];
  const componentsByConn = useMemo(() => {
    const map = {};
    for (const c of data?.components || []) {
      (map[c.connId] = map[c.connId] || []).push(c);
    }
    return map;
  }, [data]);

  const connCtl = useTableControls(connections, {
    searchKeys: ['name', 'host'],
    defaultSortKey: 'name', paginate: true,
  });

  const detailConn = detailConnId != null ? connections.find((c) => c.id === detailConnId) : null;

  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><HeartPulse size={15} className="text-brand" /> Hardware Health</p>
      <p className="text-[11px] text-ink-muted mb-3 leading-relaxed flex items-start gap-1.5">
        <Info size={12} className="mt-0.5 flex-shrink-0" />
        BYO servers: hardware monitoring isn't exposed by NetBackup — covered by the Dell platform (OME) for Dell hardware, or vendor BMC tooling (documented gap).
      </p>

      {data == null ? (
        <LoadingPanel label="Loading…" height={100} />
      ) : connections.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">
          No appliance management connections registered — add your NetBackup appliances under Settings → Appliance Hardware to monitor disk, memory, network, PSU and fan health.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="name" label="Appliance" ctl={connCtl} />
              <SortTh k="host" label="Host" ctl={connCtl} />
              <th className="py-2 pr-3">Poll status</th>
              <th className="py-2 pr-3">Health</th>
              <th className="py-2 pr-3 text-right">Components</th>
              <th className="py-2 pr-3 text-right">OK</th>
              <th className="py-2 pr-3 text-right">Warning</th>
              <th className="py-2 pr-3 text-right">Critical</th>
              <SortTh k="lastPollAt" label="Last poll" ctl={connCtl} />
              <th className="py-2 pr-3" />
            </tr></thead>
            <tbody>
              {connCtl.pageRows.map((c) => {
                const s = c.summary || {};
                const total = (s.ok || 0) + (s.warning || 0) + (s.critical || 0) + (s.unknown || 0);
                return (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetailConnId(c.id)} className="text-brand hover:underline cursor-pointer text-left">{c.name}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{c.host}</td>
                    <td className="py-2 pr-3">
                      <span title={c.lastPollStatus === 'error' ? (c.lastPollError || '') : undefined}>
                        <Badge tone={c.lastPollStatus === 'error' ? 'crit' : c.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                          {c.lastPollStatus === 'error' ? 'Unreachable' : c.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                        </Badge>
                      </span>
                    </td>
                    <td className="py-2 pr-3"><Badge tone={applianceHealthTone(s)}>{applianceHealthLabel(s)}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{total}</td>
                    <td className="py-2 pr-3 text-right tnum text-status-ok">{s.ok || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-status-warn">{s.warning || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-status-crit">{s.critical || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint tnum">{fmtWhen(c.lastPollAt)}</td>
                    <td className="py-2 pr-3">
                      <button onClick={() => refresh(c)} disabled={refreshingId === c.id} title="Poll now" aria-label={`Poll ${c.name} now`}
                        className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
                        <RefreshCw size={13} className={refreshingId === c.id ? 'animate-spin' : ''} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <TablePager ctl={connCtl} />
        </div>
      )}

      {detailConn && (
        <ApplianceDetailModal conn={detailConn} components={componentsByConn[detailConn.id] || []} onClose={() => setDetailConnId(null)} />
      )}
    </div>
  );
}

export default function NbAppliancesPage() {
  const { toast } = useToast();
  const [appliances, setAppliances] = useState(null);
  const [mediaServers, setMediaServers] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/netbackup/appliances').then(({ data }) => setAppliances(data.appliances || [])),
    client.get('/netbackup/media-servers').then(({ data }) => setMediaServers(data.mediaServers || [])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setAppliances([]); setMediaServers([]); toast({ type: 'error', title: 'Failed to load appliances' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const applianceList = appliances || [];
  const serverList = mediaServers || [];

  const applianceCtl = useTableControls(applianceList, {
    searchKeys: ['name', 'model', 'serialNumber', 'sourceName'],
    defaultSortKey: 'name', paginate: true,
  });
  const serverCtl = useTableControls(serverList, {
    searchKeys: ['name', 'sourceName'],
    defaultSortKey: 'name', paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Appliances" description="NetBackup appliances, Flex nodes and bring-your-own hosts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <HardwareHealthSection />

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Box size={15} className="text-brand" /> Hosts &amp; Appliances</p>
        <TableControls ctl={applianceCtl} rows={applianceList} searchPlaceholder="Filter by name, model or serial…"
          filters={[{ k: 'applianceType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
        {appliances == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : applianceList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No appliances found — register a NetBackup source under Settings.</div>
        ) : applianceCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No appliances match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={applianceCtl} />
                <SortTh k="applianceType" label="Type" ctl={applianceCtl} />
                <SortTh k="model" label="Model" ctl={applianceCtl} />
                <SortTh k="serialNumber" label="Serial" ctl={applianceCtl} />
                <SortTh k="osType" label="OS" ctl={applianceCtl} />
                <SortTh k="nbuVersion" label="NBU Version" ctl={applianceCtl} />
                <SortTh k="sourceName" label="Source" ctl={applianceCtl} />
              </tr></thead>
              <tbody>
                {applianceCtl.pageRows.map((a) => (
                  <tr key={a.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{a.name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={APPLIANCE_TONE[a.applianceType] || 'neutral'}>{APPLIANCE_LABEL[a.applianceType] || a.applianceType || 'BYO'}</Badge></td>
                    <td className="py-2 pr-3">
                      <ModelCell a={a} editable={a.applianceType === 'byo'}
                        onSaved={(updated) => setAppliances((prev) => (prev || []).map((row) => (row.id === a.id ? { ...row, ...updated } : row)))} />
                    </td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{a.serialNumber || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.osType ? `${a.osType}${a.osVersion ? ` ${a.osVersion}` : ''}` : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{a.nbuVersion || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.sourceName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={applianceCtl} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Media Servers</p>
        <TableControls ctl={serverCtl} rows={serverList} searchPlaceholder="Filter by name or source…"
          filters={[{ k: 'state', label: 'States' }, { k: 'sourceName', label: 'Sources' }]} />
        {mediaServers == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : serverList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No media servers found.</div>
        ) : serverCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No media servers match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={serverCtl} />
                <SortTh k="state" label="State" ctl={serverCtl} />
                <SortTh k="version" label="Version" ctl={serverCtl} />
                <SortTh k="sourceName" label="Source" ctl={serverCtl} />
              </tr></thead>
              <tbody>
                {serverCtl.pageRows.map((m) => {
                  const up = !m.state || ['active', 'online', 'up'].includes(String(m.state).toLowerCase());
                  return (
                    <tr key={m.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{m.name || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone={up ? 'ok' : 'warn'}>{m.state || 'Unknown'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{m.version || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{m.sourceName}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={serverCtl} />
      </div>
    </div>
  );
}
