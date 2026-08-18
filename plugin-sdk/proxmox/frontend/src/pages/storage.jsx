// Proxmox Storage — ports host frontend/src/pages/proxmox/PxStoragePage.jsx.
// createPortal comes from window.ReactDOM (build-banner global, same as
// ReactRouterDOM) — no ESM import available inside the plugin bundle.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner,
  useTableControls, SortTh, TableControls, TablePager,
  DbIcon, MonitorIcon, XIcon, ChevronUpIcon, ChevronDownIcon, fmtWhen, fmtBytes,
} from '../ui.jsx';

injectStyles();


// window.ReactDOM is react-dom/client on current hosts — it has NO
// createPortal, so an unguarded call crashes the page (campaign trap #1).
// Fall back to inline rendering: the overlay is position:fixed, so it
// still covers the viewport without a portal.
function __portalOrInline(node) {
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(node, document.body);
  return node;
}

const BRAND = '#E57000';
const WARN_PCT = 85;
const CRIT_PCT = 95;

function apiGet(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api/proxmox${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function UsageBar({ pct }) {
  if (pct == null) return <span style={{ color: 'var(--px-ink-faint)' }}>—</span>;
  const color = pct >= CRIT_PCT ? '#C75D5D' : pct >= WARN_PCT ? '#D4A24E' : '#6CB33F';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      <div style={{ width: 96, height: 6, borderRadius: 999, background: 'var(--px-surface-overlay)', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 999, width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
      </div>
      <span className="px-tnum" style={{ fontSize: 12, color: pct >= WARN_PCT ? color : undefined }}>{pct.toFixed(1)}%</span>
    </div>
  );
}

function ContentsRow({ colSpan, storage }) {
  const [contents, setContents] = React.useState(null);

  React.useEffect(() => {
    apiGet('/storage-content', { storage: storage.storage })
      .then((data) => setContents((data || []).filter((c) => c.serverId === storage.serverId && c.node === storage.node)))
      .catch(() => setContents([]));
  }, [storage.storage, storage.serverId, storage.node]);

  return (
    <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
      <td colSpan={colSpan} style={{ background: 'var(--px-surface-overlay)', padding: '12px 16px' }}>
        {contents == null ? (
          <div style={{ padding: '12px 0', display: 'flex', justifyContent: 'center' }}><Spinner size={16} /></div>
        ) : contents.length === 0 ? (
          <p style={{ fontSize: 11, color: 'var(--px-ink-faint)' }}>No content items on this storage.</p>
        ) : (
          <div className="px-scroll" style={{ maxHeight: 224, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 11 }}>
              <thead>
                <tr style={{ color: 'var(--px-ink-faint)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                  <th style={{ padding: '4px 12px 4px 0', textAlign: 'left' }}>Volume</th>
                  <th style={{ padding: '4px 12px 4px 0', textAlign: 'left' }}>Content</th>
                  <th style={{ padding: '4px 12px 4px 0', textAlign: 'left' }}>Format</th>
                  <th style={{ padding: '4px 12px 4px 0', textAlign: 'left' }}>VMID</th>
                  <th style={{ padding: '4px 12px 4px 0', textAlign: 'right' }}>Size</th>
                  <th style={{ padding: '4px 0', textAlign: 'left' }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {contents.map((c) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid rgba(31,43,55,0.3)' }}>
                    <td className="px-tnum" style={{ padding: '4px 12px 4px 0', color: 'var(--px-ink)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.volid}>{c.volid}</td>
                    <td style={{ padding: '4px 12px 4px 0', color: 'var(--px-ink-muted)' }}>{c.content}</td>
                    <td style={{ padding: '4px 12px 4px 0', color: 'var(--px-ink-muted)' }}>{c.format || '—'}</td>
                    <td className="px-tnum" style={{ padding: '4px 12px 4px 0', color: 'var(--px-ink-muted)' }}>{c.vmid ?? '—'}</td>
                    <td className="px-tnum" style={{ padding: '4px 12px 4px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>{fmtBytes(c.sizeBytes)}</td>
                    <td className="px-tnum" style={{ padding: '4px 0', color: 'var(--px-ink-faint)' }}>{fmtWhen(c.createdAt)}</td>
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
  const navigate = ReactRouterDOM.useNavigate();
  const [guests, setGuests] = React.useState(null);

  React.useEffect(() => {
    apiGet(`/storage/${storage.id}/guests`)
      .then((data) => setGuests(Array.isArray(data) ? data : []))
      .catch(() => setGuests([]));
  }, [storage.id]);

  return __portalOrInline(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', padding: 16 }}>
      <div className="px-panel" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 720, padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--px-ink)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <MonitorIcon size={15} style={{ color: 'var(--px-brand)' }} /> Guests on {storage.storage}
            </h2>
            <p style={{ fontSize: 11, color: 'var(--px-ink-muted)', margin: '2px 0 0' }}>
              {storage.node} · {storage.serverName} — guests with disks or volumes on this storage pool
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--px-ink-faint)', cursor: 'pointer', flexShrink: 0 }}><XIcon size={16} /></button>
        </div>
        <div className="px-scroll" style={{ overflowY: 'auto', paddingRight: 4 }}>
          {guests == null ? (
            <div style={{ padding: '32px 0', display: 'flex', justifyContent: 'center' }}><Spinner size={18} /></div>
          ) : guests.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No guests have disks on this storage.</p>
          ) : (
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Guest</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>VMID</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Type</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Status</th>
                  <th style={{ padding: '8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Disks on this storage</th>
                </tr>
              </thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.id} style={{ borderBottom: '1px solid var(--px-border)', verticalAlign: 'top' }}>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <a onClick={(e) => { e.preventDefault(); onClose(); navigate(`/proxmox/guests/${g.id}`); }} href={`/proxmox/guests/${g.id}`} style={{ color: 'var(--px-brand)', cursor: 'pointer' }}>{g.name}</a>
                      {g.isTemplate ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--px-ink-faint)' }}>(template)</span> : null}
                    </td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{g.vmid}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{g.type === 'lxc' ? 'LXC' : 'VM'}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={g.status === 'running' ? 'ok' : 'neutral'}>{g.status}</Badge></td>
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {(g.devices || []).map((d) => (
                          <span key={d.key} className="px-tnum" style={{ fontSize: 11, color: 'var(--px-ink-muted)' }}>
                            <span style={{ color: 'var(--px-ink)' }}>{d.key}</span>
                            {d.size ? ` · ${d.size}` : ''}
                            {d.cdrom ? <span style={{ color: 'var(--px-ink-faint)' }}> · cdrom</span> : ''}
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
    </div>);
}

export default function PxStoragePage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [open, setOpen] = React.useState(() => new Set());
  const [guestsFor, setGuestsFor] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    return apiGet('/storage')
      .then((d) => { setRows(d); setLastRefreshed(new Date()); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const toggle = (key) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const list = (rows || []).map((s) => ({
    ...s,
    used_pct: s.totalBytes > 0 && s.usedBytes != null ? (s.usedBytes / s.totalBytes) * 100 : null,
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['storage', 'node', 'serverName', 'type', 'content'],
    defaultSortKey: 'used_pct', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="px-root px-fade-in">
      <PageHeader icon={DbIcon} title="Storage" description="Storage pool utilization across all registered Proxmox servers — warning above 85%, critical above 95%">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 12 }}>Storage Pools</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by storage, node or type…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'type', label: 'Types' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading storage…" height={140} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No storage pools found — register a Proxmox server under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No storage pools match your filters.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <th style={{ padding: '8px 12px 8px 0', width: 24 }} />
                  <SortTh k="storage" label="Storage" ctl={ctl} />
                  <SortTh k="type" label="Type" ctl={ctl} />
                  <SortTh k="node" label="Node" ctl={ctl} />
                  <SortTh k="serverName" label="Server" ctl={ctl} />
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Content</th>
                  <SortTh k="active" label="Active" ctl={ctl} />
                  <SortTh k="totalBytes" label="Capacity" ctl={ctl} align="right" />
                  <SortTh k="used_pct" label="Used" ctl={ctl} align="right" />
                  <th style={{ padding: '8px 0' }} />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((s) => {
                  const key = `${s.serverId}|${s.node}|${s.storage}`;
                  const isOpen = open.has(key);
                  return (
                    <React.Fragment key={key}>
                      <tr className="px-row" style={{ borderBottom: '1px solid var(--px-border)', cursor: 'pointer' }} onClick={() => toggle(key)}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)' }}>{isOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{s.storage}{s.shared ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--px-ink-faint)' }}>(shared)</span> : ''}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{s.type || '—'}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{s.node}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{s.serverName}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.content}>{s.content || '—'}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={s.active ? 'ok' : 'neutral'}>{s.active ? 'active' : 'inactive'}</Badge></td>
                        <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>{fmtBytes(s.totalBytes)}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}><UsageBar pct={s.used_pct} /></td>
                        <td style={{ padding: '8px 0' }}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setGuestsFor(s); }}
                            className="px-btn-ghost"
                            style={{ fontSize: 11, padding: '4px 8px' }}
                            title="Show guests with disks on this storage"
                          >
                            <MonitorIcon size={12} /> VMs
                          </button>
                        </td>
                      </tr>
                      {isOpen && <ContentsRow colSpan={10} storage={s} />}
                    </React.Fragment>
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
