import { Fragment, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Database, ChevronDown, ChevronUp, MonitorSmartphone, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtBytes, fmtWhen } from './helpers';

const WARN_PCT = 85;
const CRIT_PCT = 95;

function UsageBar({ pct }) {
  if (pct == null) return <span className="text-ink-faint">—</span>;
  const color = pct >= CRIT_PCT ? '#C75D5D' : pct >= WARN_PCT ? '#D4A24E' : '#6CB33F';
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="w-24 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
      </div>
      <span className="tnum text-xs" style={{ color: pct >= WARN_PCT ? color : undefined }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

function ContentsRow({ colSpan, storage }) {
  const [contents, setContents] = useState(null);

  useEffect(() => {
    client.get('/proxmox/storage-content', { params: { storage: storage.storage } })
      .then(({ data }) => setContents((data || []).filter(c => c.serverId === storage.serverId && c.node === storage.node)))
      .catch(() => setContents([]));
  }, [storage.storage, storage.serverId, storage.node]);

  return (
    <tr className="border-b border-cohesity-border/50">
      <td colSpan={colSpan} className="bg-surface-overlay px-4 py-3">
        {contents == null ? (
          <div className="py-3 flex justify-center"><Spinner size={16} /></div>
        ) : contents.length === 0 ? (
          <p className="text-[11px] text-ink-faint">No content items on this storage.</p>
        ) : (
          <div className="max-h-56 overflow-y-auto pr-1">
            <table className="w-full text-[11px]">
              <thead><tr className="text-left text-ink-faint uppercase tracking-wide">
                <th className="py-1 pr-3">Volume</th>
                <th className="py-1 pr-3">Content</th>
                <th className="py-1 pr-3">Format</th>
                <th className="py-1 pr-3">VMID</th>
                <th className="py-1 pr-3 text-right">Size</th>
                <th className="py-1 pr-3">Created</th>
              </tr></thead>
              <tbody>
                {contents.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/30">
                    <td className="py-1 pr-3 text-ink tnum max-w-[260px] truncate" title={c.volid}>{c.volid}</td>
                    <td className="py-1 pr-3 text-ink-muted">{c.content}</td>
                    <td className="py-1 pr-3 text-ink-muted">{c.format || '—'}</td>
                    <td className="py-1 pr-3 text-ink-muted tnum">{c.vmid ?? '—'}</td>
                    <td className="py-1 pr-3 text-right tnum text-ink-muted">{fmtBytes(c.sizeBytes)}</td>
                    <td className="py-1 pr-3 text-ink-faint tnum">{fmtWhen(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </td>
    </tr>
  );
}

function GuestsModal({ storage, onClose }) {
  const [guests, setGuests] = useState(null);

  useEffect(() => {
    client.get(`/proxmox/storage/${storage.id}/guests`)
      .then(({ data }) => setGuests(Array.isArray(data) ? data : []))
      .catch(() => setGuests([]));
  }, [storage.id]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-2xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <MonitorSmartphone size={15} className="text-brand" /> Guests on {storage.storage}
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">
              {storage.node} · {storage.serverName} — guests with disks or volumes on this storage pool
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto pr-1">
          {guests == null ? (
            <div className="py-8 flex justify-center"><Spinner size={18} /></div>
          ) : guests.length === 0 ? (
            <p className="text-sm text-ink-muted py-6 text-center">No guests have disks on this storage.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Guest</th>
                <th className="py-2 pr-3">VMID</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Disks on this storage</th>
              </tr></thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.id} className="border-b border-cohesity-border/50 align-top">
                    <td className="py-2 pr-3">
                      <Link to={`/proxmox/guests/${g.id}`} className="text-brand hover:underline" onClick={onClose}>{g.name}</Link>
                      {g.isTemplate ? <span className="ml-1.5 text-[10px] text-ink-faint">(template)</span> : null}
                    </td>
                    <td className="py-2 pr-3 tnum text-ink-muted">{g.vmid}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{g.type === 'lxc' ? 'LXC' : 'VM'}</td>
                    <td className="py-2 pr-3"><Badge tone={g.status === 'running' ? 'ok' : 'neutral'}>{g.status}</Badge></td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-col gap-0.5">
                        {g.devices.map((d) => (
                          <span key={d.key} className="text-[11px] text-ink-muted tnum">
                            <span className="text-ink">{d.key}</span>
                            {d.size ? ` · ${d.size}` : ''}
                            {d.cdrom ? <span className="text-ink-faint"> · cdrom</span> : ''}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function PxStoragePage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [guestsFor, setGuestsFor] = useState(null);

  const load = useCallback(() => client.get('/proxmox/storage')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load storage' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const toggle = (key) => setOpen(s => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const list = (rows || []).map(s => ({
    ...s,
    used_pct: s.totalBytes > 0 && s.usedBytes != null ? (s.usedBytes / s.totalBytes) * 100 : null,
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['storage', 'node', 'serverName', 'type', 'content'],
    defaultSortKey: 'used_pct', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="Storage" description="Storage pool utilization across all registered Proxmox servers — warning above 85%, critical above 95%">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Storage Pools</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by storage, node or type…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'type', label: 'Types' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading storage…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No storage pools found — register a Proxmox server under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No storage pools match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3 w-6" />
                <SortTh k="storage" label="Storage" ctl={ctl} />
                <SortTh k="type" label="Type" ctl={ctl} />
                <SortTh k="node" label="Node" ctl={ctl} />
                <SortTh k="serverName" label="Server" ctl={ctl} />
                <th className="py-2 pr-3">Content</th>
                <SortTh k="active" label="Active" ctl={ctl} />
                <SortTh k="totalBytes" label="Capacity" ctl={ctl} align="right" />
                <SortTh k="used_pct" label="Used" ctl={ctl} align="right" />
                <th className="py-2 pr-3" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((s) => {
                  const key = `${s.serverId}|${s.node}|${s.storage}`;
                  const isOpen = open.has(key);
                  return (
                    <Fragment key={key}>
                      <tr className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay/60" onClick={() => toggle(key)}>
                        <td className="py-2 pr-3 text-ink-faint">{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</td>
                        <td className="py-2 pr-3 text-ink">{s.storage}{s.shared ? <span className="ml-1.5 text-[10px] text-ink-faint">(shared)</span> : ''}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[11px]">{s.type || '—'}</td>
                        <td className="py-2 pr-3 text-ink-muted">{s.node}</td>
                        <td className="py-2 pr-3 text-ink-muted">{s.serverName}</td>
                        <td className="py-2 pr-3 text-ink-faint text-[11px] max-w-[200px] truncate" title={s.content}>{s.content || '—'}</td>
                        <td className="py-2 pr-3"><Badge tone={s.active ? 'ok' : 'neutral'}>{s.active ? 'active' : 'inactive'}</Badge></td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(s.totalBytes)}</td>
                        <td className="py-2 pr-3"><UsageBar pct={s.used_pct} /></td>
                        <td className="py-2 pr-3">
                          <button
                            onClick={(e) => { e.stopPropagation(); setGuestsFor(s); }}
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand transition-colors cursor-pointer"
                            title="Show guests with disks on this storage">
                            <MonitorSmartphone size={12} /> VMs
                          </button>
                        </td>
                      </tr>
                      {isOpen && <ContentsRow colSpan={10} storage={s} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
      {guestsFor && <GuestsModal storage={guestsFor} onClose={() => setGuestsFor(null)} />}
    </div>
  );
}
