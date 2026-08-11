// NetBackup Appliances — ports host frontend/src/pages/netbackup/NbAppliancesPage.jsx.
import {
  injectStyles, PageHeader, LoadingPanel, RefreshButton, LastUpdated, Badge,
  useTableControls, SortTh, TableControls, TablePager,
  ServerIcon, BoxesIcon, PencilIcon, CheckIcon, XIcon, HeartPulseIcon, RefreshIcon, InfoIcon,
  HardDriveIcon, LayersIcon, MemoryIcon, CpuIcon, NetworkIcon, CableIcon, PlugIcon, FanIcon, ThermometerIcon, BatteryIcon,
} from '../ui.jsx';
import { BRAND, fmtWhen, componentTypeLabel, componentStatusTone, fmtHwDetail, apiGet, apiSend } from './helpers.js';

injectStyles();

const APPLIANCE_TONE = { appliance: 'brand', flex: 'info', byo: 'neutral' };
const APPLIANCE_LABEL = { appliance: 'Appliance', flex: 'Flex', byo: 'BYO' };
const SUMMARY_TONE = { ok: 'ok', warning: 'warn', critical: 'crit', unknown: 'neutral' };
const SUMMARY_LABEL = { ok: 'OK', warning: 'Warning', critical: 'Critical', unknown: 'Unknown' };
const COMPONENT_TYPE_ORDER = ['disk', 'raid', 'memory', 'cpu', 'network', 'fc', 'psu', 'fan', 'temperature', 'battery', 'other'];
const COMPONENT_TYPE_ICON = { disk: HardDriveIcon, raid: LayersIcon, memory: MemoryIcon, cpu: CpuIcon, network: NetworkIcon, fc: CableIcon, psu: PlugIcon, fan: FanIcon, temperature: ThermometerIcon, battery: BatteryIcon, other: BoxesIcon };

function ModelCell({ a, editable, onSaved }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(a.model || '');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const start = () => { setValue(a.model || ''); setEditing(true); setErr(null); };
  const cancel = () => setEditing(false);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const data = await apiSend('/appliances/model', 'PUT', { sourceId: a.sourceId, name: a.name, model: value.trim() });
      onSaved(data);
      setEditing(false);
    } catch (e) {
      setErr(e.body?.error || 'Update failed');
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); };

  if (!editable) {
    return <span style={{ color: 'var(--nb-ink-muted)' }}>{a.model || '—'}{a.modelSource === 'override' && <span style={{ fontSize: 10, color: 'var(--nb-ink-faint)', marginLeft: 4 }} title={a.modelRaw || ''}>(custom)</span>}</span>;
  }
  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} disabled={saving}
          className="nb-input" style={{ width: 160, padding: '4px 8px', fontSize: 12 }} />
        <button onClick={save} disabled={saving} title="Save" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 24, width: 24, borderRadius: 6, border: 'none', background: 'none', color: 'var(--nb-ok)', cursor: 'pointer' }}><CheckIcon size={13} /></button>
        <button onClick={cancel} disabled={saving} title="Cancel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 24, width: 24, borderRadius: 6, border: 'none', background: 'none', color: 'var(--nb-ink-faint)', cursor: 'pointer' }}><XIcon size={13} /></button>
        {err && <span style={{ fontSize: 10, color: 'var(--nb-crit)' }}>{err}</span>}
      </div>
    );
  }
  return (
    <button onClick={start} title="Edit model" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, color: 'var(--nb-ink-muted)', cursor: 'pointer' }}>
      <span>{a.model || '—'}{a.modelSource === 'override' && <span style={{ fontSize: 10, color: 'var(--nb-ink-faint)', marginLeft: 4 }} title={a.modelRaw || ''}>(custom)</span>}</span>
      <PencilIcon size={11} />
    </button>
  );
}

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
  return ReactDOM.createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
      <div className="nb-panel" style={{ position: 'relative', width: '100%', maxWidth: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '16px 16px 12px', borderBottom: '1px solid var(--nb-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {Icon && <Icon size={17} style={{ color: 'var(--nb-brand)', flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
              {subtitle && <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 6, background: 'none', border: 'none', color: 'var(--nb-ink-muted)', cursor: 'pointer', flexShrink: 0 }}><XIcon size={15} /></button>
        </div>
        <div className="nb-scroll" style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>,
    document.body
  );
}

function ComponentSection({ type, rows }) {
  const Icon = COMPONENT_TYPE_ICON[type] || BoxesIcon;
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon size={13} style={{ color: 'var(--nb-brand)' }} /> {componentTypeLabel(type)} ({rows.length})
      </p>
      <div className="nb-scroll" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ textAlign: 'left', fontSize: 10, textTransform: 'uppercase', color: 'var(--nb-ink-faint)', borderBottom: '1px solid var(--nb-border)' }}>
            <th style={{ padding: '6px 12px 6px 0' }}>Name</th><th style={{ padding: '6px 12px 6px 0' }}>Status</th><th style={{ padding: '6px 12px 6px 0' }}>State</th><th style={{ padding: '6px 0' }}>Detail</th>
          </tr></thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={`${c.componentType}-${c.componentName}-${i}`} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <td style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.componentName || ''}>{c.componentName || '—'}</td>
                <td style={{ padding: '6px 12px 6px 0' }}><Badge tone={componentStatusTone(c.status)}>{SUMMARY_LABEL[c.status] || c.status}</Badge></td>
                <td style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink-muted)' }}>{c.stateRaw || '—'}</td>
                <td style={{ padding: '6px 0', color: 'var(--nb-ink-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fmtHwDetail(c.detail) || ''}>{fmtHwDetail(c.detail) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function applianceHealthTone(summary) { const s = summary || {}; if (s.critical > 0) return 'crit'; if (s.warning > 0) return 'warn'; if (s.ok > 0) return 'ok'; return 'neutral'; }
function applianceHealthLabel(summary) { const s = summary || {}; if (s.critical > 0) return 'Critical'; if (s.warning > 0) return 'Warning'; if (s.ok > 0) return 'OK'; return 'Unknown'; }

function ApplianceDetailModal({ conn, components, onClose }) {
  return (
    <ModalShell title={conn.name} subtitle={`${conn.host} · last poll ${fmtWhen(conn.lastPollAt)}`} icon={ServerIcon} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Badge tone={applianceHealthTone(conn.summary)}>{applianceHealthLabel(conn.summary)}</Badge>
        <Badge tone={conn.lastPollStatus === 'error' ? 'crit' : conn.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
          {conn.lastPollStatus === 'error' ? 'Unreachable' : conn.lastPollStatus === 'success' ? 'Up' : 'Pending'}
        </Badge>
        {['ok', 'warning', 'critical', 'unknown'].map((k) => (conn.summary?.[k] ? <Badge key={k} tone={SUMMARY_TONE[k]}>{conn.summary[k]} {SUMMARY_LABEL[k]}</Badge> : null))}
      </div>
      {components.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No hardware components reported yet.</div>
      ) : (
        COMPONENT_TYPE_ORDER.map((t) => <ComponentSection key={t} type={t} rows={components.filter((c) => c.componentType === t)} />)
      )}
    </ModalShell>
  );
}

function HardwareHealthSection() {
  const [data, setData] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [detailConnId, setDetailConnId] = React.useState(null);
  const [rowMsg, setRowMsg] = React.useState({});

  const load = React.useCallback(() => apiGet('/appliance-hardware')
    .then((d) => setData({ connections: d.connections || [], components: d.components || [] }))
    .catch(() => setData({ connections: [], components: [] })), []);

  React.useEffect(() => { load(); }, [load]);

  const refresh = async (c) => {
    setRefreshingId(c.id);
    try {
      await apiSend(`/appliance-connections/${c.id}/refresh`, 'POST', {});
      await load();
    } catch (err) {
      setRowMsg((m) => ({ ...m, [c.id]: err.body?.error || 'Refresh failed' }));
    } finally {
      setRefreshingId(null);
    }
  };

  const connections = data?.connections || [];
  const componentsByConn = React.useMemo(() => {
    const map = {};
    for (const c of data?.components || []) (map[c.connId] = map[c.connId] || []).push(c);
    return map;
  }, [data]);

  const connCtl = useTableControls(connections, { searchKeys: ['name', 'host'], defaultSortKey: 'name', paginate: true });
  const detailConn = detailConnId != null ? connections.find((c) => c.id === detailConnId) : null;

  return (
    <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <HeartPulseIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Hardware Health
      </p>
      <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', marginBottom: 12, lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <InfoIcon size={12} style={{ marginTop: 2, flexShrink: 0 }} />
        BYO servers: hardware monitoring isn't exposed by NetBackup — covered by the Dell platform (OME) for Dell hardware, or vendor BMC tooling (documented gap).
      </p>
      {data == null ? (
        <LoadingPanel label="Loading…" height={100} />
      ) : connections.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>
          No appliance management connections registered — add your NetBackup appliances under Settings → Appliance Hardware to monitor disk, memory, network, PSU and fan health.
        </div>
      ) : (
        <div className="nb-scroll" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
              <SortTh k="name" label="Appliance" ctl={connCtl} />
              <SortTh k="host" label="Host" ctl={connCtl} />
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Poll status</th>
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Health</th>
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Components</th>
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>OK</th>
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Warning</th>
              <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Critical</th>
              <SortTh k="lastPollAt" label="Last poll" ctl={connCtl} />
              <th style={{ padding: '8px 0' }} />
            </tr></thead>
            <tbody>
              {connCtl.pageRows.map((c) => {
                const s = c.summary || {};
                const total = (s.ok || 0) + (s.warning || 0) + (s.critical || 0) + (s.unknown || 0);
                return (
                  <tr key={c.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <button onClick={() => setDetailConnId(c.id)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--nb-brand)', cursor: 'pointer', textAlign: 'left' }}>{c.name}</button>
                    </td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{c.host}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <span title={c.lastPollStatus === 'error' ? (c.lastPollError || '') : undefined}>
                        <Badge tone={c.lastPollStatus === 'error' ? 'crit' : c.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                          {c.lastPollStatus === 'error' ? 'Unreachable' : c.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                        </Badge>
                      </span>
                      {rowMsg[c.id] && <p style={{ fontSize: 10, color: 'var(--nb-crit)', margin: '2px 0 0' }}>{rowMsg[c.id]}</p>}
                    </td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={applianceHealthTone(s)}>{applianceHealthLabel(s)}</Badge></td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{total}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ok)' }}>{s.ok || '—'}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-warn)' }}>{s.warning || '—'}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-crit)' }}>{s.critical || '—'}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-faint)' }}>{fmtWhen(c.lastPollAt)}</td>
                    <td style={{ padding: '8px 0' }}>
                      <button onClick={() => refresh(c)} disabled={refreshingId === c.id} title="Poll now" className="nb-btn-ghost" style={{ padding: 6 }}>
                        <RefreshIcon size={13} style={refreshingId === c.id ? { animation: 'nb-spin 0.8s linear infinite' } : undefined} />
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
      {detailConn && <ApplianceDetailModal conn={detailConn} components={componentsByConn[detailConn.id] || []} onClose={() => setDetailConnId(null)} />}
    </div>
  );
}

export default function NbAppliancesPage() {
  const [appliances, setAppliances] = React.useState(null);
  const [mediaServers, setMediaServers] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiGet('/appliances').then((d) => setAppliances(d.appliances || [])),
    apiGet('/media-servers').then((d) => setMediaServers(d.mediaServers || [])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setAppliances([]); setMediaServers([]); }), []);

  React.useEffect(() => { load(); }, [load]);

  const applianceList = appliances || [];
  const serverList = mediaServers || [];

  const applianceCtl = useTableControls(applianceList, { searchKeys: ['name', 'model', 'serialNumber', 'sourceName'], defaultSortKey: 'name', paginate: true });
  const serverCtl = useTableControls(serverList, { searchKeys: ['name', 'sourceName'], defaultSortKey: 'name', paginate: true });

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={ServerIcon} title="Appliances" description="NetBackup appliances, Flex nodes and bring-your-own hosts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={appliances == null} />
      </PageHeader>

      <HardwareHealthSection />

      <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <BoxesIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Hosts &amp; Appliances
        </p>
        <TableControls ctl={applianceCtl} rows={applianceList} searchPlaceholder="Filter by name, model or serial…" filters={[{ k: 'applianceType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
        {appliances == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : applianceList.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No appliances found — register a NetBackup source under Settings.</div>
        ) : applianceCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No appliances match your filters.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
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
                  <tr key={a.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>{a.name || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={APPLIANCE_TONE[a.applianceType] || 'neutral'}>{APPLIANCE_LABEL[a.applianceType] || a.applianceType || 'BYO'}</Badge></td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <ModelCell a={a} editable={a.applianceType === 'byo'} onSaved={(updated) => setAppliances((prev) => (prev || []).map((row) => (row.id === a.id ? { ...row, ...updated } : row)))} />
                    </td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', fontSize: 11 }}>{a.serialNumber || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{a.osType ? `${a.osType}${a.osVersion ? ` ${a.osVersion}` : ''}` : '—'}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', fontSize: 11 }}>{a.nbuVersion || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{a.sourceName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={applianceCtl} />
      </div>

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Media Servers</p>
        <TableControls ctl={serverCtl} rows={serverList} searchPlaceholder="Filter by name or source…" filters={[{ k: 'state', label: 'States' }, { k: 'sourceName', label: 'Sources' }]} />
        {mediaServers == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : serverList.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No media servers found.</div>
        ) : serverCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No media servers match your filters.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <SortTh k="name" label="Name" ctl={serverCtl} />
                <SortTh k="state" label="State" ctl={serverCtl} />
                <SortTh k="version" label="Version" ctl={serverCtl} />
                <SortTh k="sourceName" label="Source" ctl={serverCtl} />
              </tr></thead>
              <tbody>
                {serverCtl.pageRows.map((m) => {
                  const up = !m.state || ['active', 'online', 'up'].includes(String(m.state).toLowerCase());
                  return (
                    <tr key={m.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>{m.name || '—'}</td>
                      <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={up ? 'ok' : 'warn'}>{m.state || 'Unknown'}</Badge></td>
                      <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', fontSize: 11 }}>{m.version || '—'}</td>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{m.sourceName}</td>
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
