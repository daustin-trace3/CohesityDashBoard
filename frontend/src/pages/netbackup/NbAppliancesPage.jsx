import { useEffect, useState, useCallback } from 'react';
import { Server, Box, Pencil, Check, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated, Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND } from './helpers';

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
