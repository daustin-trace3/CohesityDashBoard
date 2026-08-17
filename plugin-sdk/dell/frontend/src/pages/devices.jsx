import { Server, X, Cpu, MemoryStick, HardDrive, Network, Plug, MonitorSmartphone, AlertTriangle, BadgeCheck, Download, Layers, Database, Cable, ClipboardCheck, ScrollText } from '../icons.jsx';
import {
  apiFetch, apiFetchBlob, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner,
  useTableControls, SortTh, TableControls, TablePager, Modal, portalOrInline,
  BRAND, fmtNum, fmtBytes, healthTone, severityTone, fmtWhen,
} from '../ui.jsx';
import { DriftModal } from './governance.jsx';

const Fact = ({ label, value }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
    <p className="text-sm text-ink tnum">{value ?? '—'}</p>
  </div>
);

const KIND_META = {
  processor: { label: 'Processors', icon: Cpu },
  memory: { label: 'Memory', icon: MemoryStick },
  raid: { label: 'RAID Controllers', icon: Layers },
  vdisk: { label: 'Virtual Disks', icon: Database },
  disk: { label: 'Physical Disks', icon: HardDrive },
  nic: { label: 'Network Interfaces', icon: Network },
  fc: { label: 'Fibre Channel', icon: Cable },
  psu: { label: 'Power Supplies', icon: Plug },
  os: { label: 'Operating System', icon: MonitorSmartphone },
};

function ComponentSection({ kind, rows }) {
  const meta = KIND_META[kind] || { label: kind, icon: Server };
  const Icon = meta.icon;
  if (!rows.length) return null;
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><Icon size={13} className="text-brand" /> {meta.label} ({rows.length})</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            <th className="py-1.5 pr-3">Name</th>
            <th className="py-1.5 pr-3">Slot</th>
            <th className="py-1.5 pr-3">Size / Speed</th>
            <th className="py-1.5 pr-3">Serial</th>
            <th className="py-1.5 pr-3">Status</th>
          </tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-cohesity-border/40">
                <td className="py-1.5 pr-3 text-ink max-w-[240px] truncate" title={c.name || c.description || ''}>{c.name || c.description || '—'}</td>
                <td className="py-1.5 pr-3 text-ink-muted tnum">{c.slot || '—'}</td>
                <td className="py-1.5 pr-3 text-ink-muted tnum whitespace-nowrap">
                  {c.size_bytes ? fmtBytes(c.size_bytes) : ''}{c.size_bytes && c.speed ? ' · ' : ''}{c.speed || (c.size_bytes ? '' : '—')}
                  {kind === 'processor' && c.extra?.cores ? ` · ${c.extra.cores}c` : ''}
                  {kind === 'disk' && c.extra?.mediaType ? ` · ${c.extra.mediaType}` : ''}
                  {kind === 'disk' && c.extra?.raidStatus ? ` · ${c.extra.raidStatus}` : ''}
                  {kind === 'disk' && c.extra?.endurance != null ? ` · ${c.extra.endurance}% endurance` : ''}
                  {kind === 'fc' && c.extra?.linkStatus ? ` · link ${c.extra.linkStatus}` : ''}
                  {kind === 'vdisk' && c.extra?.controller ? ` · on ${c.extra.controller}` : ''}
                  {kind === 'raid' && c.extra?.firmware ? ` · fw ${c.extra.firmware}` : ''}
                </td>
                <td className="py-1.5 pr-3 text-ink-faint tnum">{c.serial || '—'}</td>
                <td className="py-1.5 pr-3">{c.status ? <Badge tone={healthTone(c.status)}>{c.status}</Badge> : <span className="text-ink-faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DeviceDetailModal({ deviceId, onClose }) {
  const [dev, setDev] = React.useState(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setDev(null); setFailed(false);
    apiFetch(`/dell/devices/${deviceId}`)
      .then((json) => setDev(json))
      .catch(() => setFailed(true));
  }, [deviceId]);

  const byKind = (kind) => (dev?.components || []).filter((c) => c.kind === kind);

  return (
    <Modal
      title={dev?.name || 'Device details'}
      subtitle={dev ? `${dev.model || ''} · ${dev.service_tag || ''} · ${dev.ome_name}` : null}
      icon={Server} onClose={onClose} maxWidth="min(768px,92vw)">
      {failed ? (
        <div className="text-sm text-status-crit py-6 text-center">Failed to load device.</div>
      ) : dev == null ? (
        <div className="flex items-center justify-center py-10"><Spinner size={20} /></div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Badge tone={healthTone(dev.health)}>{dev.health}</Badge>
            <Badge tone={dev.power_state === 'on' ? 'ok' : 'neutral'}>{(dev.power_state || 'unknown').toUpperCase()}</Badge>
            {dev.connection_state === 0 && <Badge tone="crit">DISCONNECTED</Badge>}
            {dev.chassis_service_tag && <Badge tone="info">Chassis {dev.chassis_service_tag}</Badge>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Fact label="Type" value={dev.device_type} />
            <Fact label="IP" value={dev.ip_address} />
            <Fact label="Sockets / Cores" value={dev.cpu_count != null ? `${fmtNum(dev.cpu_count)} / ${fmtNum(dev.core_count)}` : null} />
            <Fact label="Memory" value={dev.memory_bytes != null ? fmtBytes(dev.memory_bytes) : null} />
            <Fact label="Raw Disk" value={dev.disk_bytes != null ? fmtBytes(dev.disk_bytes) : null} />
            {dev.power_w != null && <Fact label="Power Draw" value={`${fmtNum(Math.round(dev.power_w))} W`} />}
            {dev.inlet_temp_c != null && <Fact label="Inlet Temp" value={`${dev.inlet_temp_c.toFixed(1)} °C`} />}
            {dev.cpu_util_pct != null && <Fact label="CPU / Mem Util" value={`${dev.cpu_util_pct.toFixed(0)}% / ${dev.mem_util_pct != null ? dev.mem_util_pct.toFixed(0) : '—'}%`} />}
          </div>

          {(dev.warranty || []).length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><BadgeCheck size={13} className="text-brand" /> Warranty</p>
              {dev.warranty.map((w) => (
                <p key={w.id} className="text-xs text-ink-muted">
                  {w.service_level || 'Support'} — {w.days_remaining != null
                    ? (w.days_remaining <= 0
                      ? <span className="text-status-crit font-semibold">expired</span>
                      : <span className={w.days_remaining <= 90 ? 'text-status-warn font-semibold' : ''}>{w.days_remaining} days remaining</span>)
                    : '—'}
                  {w.end_date ? <span className="text-ink-faint"> (ends {String(w.end_date).slice(0, 10)})</span> : null}
                </p>
              ))}
            </div>
          )}

          {(dev.configCompliance || []).length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><ClipboardCheck size={13} className="text-brand" /> Configuration Compliance</p>
              {dev.configCompliance.map((c) => (
                <p key={c.id} className="text-xs text-ink-muted">
                  {c.baseline_name || `Baseline #${c.baseline_id}`} — {c.status === 'compliant'
                    ? <span className="text-status-ok">compliant</span>
                    : c.status === 'noncompliant'
                      ? <span className="text-status-crit font-semibold">not compliant{c.drift_count ? ` (${c.drift_count} drifted setting${c.drift_count === 1 ? '' : 's'})` : ''}</span>
                      : <span className="text-ink-faint">{c.status.replace('_', ' ')}</span>}
                </p>
              ))}
            </div>
          )}

          {['processor', 'memory', 'raid', 'vdisk', 'disk', 'nic', 'fc', 'psu', 'os'].map((k) => (
            <ComponentSection key={k} kind={k} rows={byKind(k)} />
          ))}

          {(dev.hardwareLogs || []).length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><ScrollText size={13} className="text-brand" /> Recent Hardware Log</p>
              <div className="flex flex-col gap-1">
                {dev.hardwareLogs.slice(0, 15).map((l) => (
                  <div key={l.id} className="flex items-start gap-2 bg-surface-overlay rounded-lg px-3 py-1.5">
                    <Badge tone={l.severity === 'critical' || l.severity === 'fatal' ? 'crit' : l.severity === 'warning' ? 'warn' : 'info'}>{l.severity}</Badge>
                    <div className="min-w-0">
                      <p className="text-xs text-ink-muted leading-snug">{l.message}</p>
                      <p className="text-[10px] text-ink-faint tnum">{l.message_id ? `${l.message_id} · ` : ''}{l.category ? `${l.category} · ` : ''}{fmtWhen(l.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(dev.alerts || []).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><AlertTriangle size={13} className="text-brand" /> Recent Alerts</p>
              <div className="flex flex-col gap-1">
                {dev.alerts.slice(0, 15).map((a) => (
                  <div key={a.id} className="flex items-start gap-2 bg-surface-overlay rounded-lg px-3 py-1.5">
                    <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    <div className="min-w-0">
                      <p className="text-xs text-ink-muted leading-snug">{a.message}</p>
                      <p className="text-[10px] text-ink-faint tnum">{fmtWhen(a.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

const GROUPS = [
  { key: 'cpu', label: 'CPU (sockets, cores, models)' },
  { key: 'memory', label: 'Memory (total, DIMM detail)' },
  { key: 'network', label: 'Network (NICs, MAC addresses)' },
];

function ExportModal({ devices, onClose }) {
  const [deviceId, setDeviceId] = React.useState('all');
  const [groups, setGroups] = React.useState({ cpu: true, memory: true, network: true });
  const [exporting, setExporting] = React.useState(false);
  const [error, setError] = React.useState(null);

  const run = async () => {
    setExporting(true);
    setError(null);
    try {
      const include = Object.keys(groups).filter((k) => groups[k]).join(',');
      const params = new URLSearchParams({ ...(include ? { include } : {}), ...(deviceId !== 'all' ? { deviceId } : {}) });
      const blob = await apiFetchBlob(`/dell/export?${params.toString()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dell-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch {
      setError('Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal title="Export inventory" subtitle="CSV — device name, model, IP and support info are always included" icon={Download} onClose={onClose}>
      <div className="mb-4">
        <label className="block text-xs font-semibold text-ink mb-1">Scope</label>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="dl-input" style={{ cursor: 'pointer' }}>
          <option value="all">All devices ({devices.length})</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>{d.name || d.service_tag}</option>
          ))}
        </select>
      </div>
      <p className="text-xs font-semibold text-ink mb-2">Include hardware detail</p>
      <div className="flex flex-col gap-2 mb-5">
        {GROUPS.map((g) => (
          <label key={g.key} className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={groups[g.key]}
              onChange={(e) => setGroups((prev) => ({ ...prev, [g.key]: e.target.checked }))}
              className="accent-brand cursor-pointer" />
            <span className="text-sm text-ink-muted">{g.label}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-status-crit mb-2">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer">
          Cancel
        </button>
        <button onClick={run} disabled={exporting}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer inline-flex items-center gap-2">
          {exporting && <Spinner size={13} />} Export CSV
        </button>
      </div>
    </Modal>
  );
}

export default function DellDevicesPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailId, setDetailId] = React.useState(null);
  const [driftReportId, setDriftReportId] = React.useState(null);
  const [showExport, setShowExport] = React.useState(false);

  const load = React.useCallback(() => apiFetch('/dell/devices')
    .then((json) => { setRows(Array.isArray(json) ? json : []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  // Power Manager is licensed per OME — hide the Watts column entirely when
  // nothing in the estate is metered.
  const hasPm = list.some((d) => d.power_w != null);
  // Compliance column only exists once at least one device sits in a config
  // baseline — no empty column on estates without compliance baselines.
  const hasCompliance = list.some((d) => d.compliance_status != null);
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'service_tag', 'model', 'device_type', 'ip_address', 'ome_name', 'chassis_service_tag'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Devices" description="Every device managed by the registered OME instances — click a device for full hardware detail">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <button onClick={() => setShowExport(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
          <Download size={13} /> Export
        </button>
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, service tag, model, type, IP or OME…"
          filters={[
            { k: 'ome_name', label: 'OME instances' },
            { k: 'device_type', label: 'Types' },
            { k: 'model', label: 'Models' },
            { k: 'health', label: 'Health' },
            ...(hasCompliance ? [{ k: 'compliance_status', label: 'Compliance' }] : []),
            { k: 'power_state', label: 'Power' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading devices…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No devices found — data appears after the next poll of a registered OME instance.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No devices match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Device" ctl={ctl} />
                <SortTh k="service_tag" label="Service Tag" ctl={ctl} />
                <SortTh k="model" label="Model" ctl={ctl} />
                <SortTh k="device_type" label="Type" ctl={ctl} />
                <SortTh k="health" label="Health" ctl={ctl} />
                {hasCompliance && <SortTh k="compliance_status" label="Compliance" ctl={ctl} />}
                <SortTh k="power_state" label="Power" ctl={ctl} />
                <SortTh k="core_count" label="Cores" ctl={ctl} align="right" />
                <SortTh k="memory_bytes" label="Memory" ctl={ctl} align="right" />
                {hasPm && <SortTh k="power_w" label="Watts" ctl={ctl} align="right" />}
                <SortTh k="ip_address" label="IP" ctl={ctl} />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((d) => (
                  <tr key={d.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetailId(d.id)} className="text-brand hover:underline cursor-pointer text-left">{d.name || d.service_tag || '—'}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{d.service_tag || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted max-w-[180px] truncate" title={d.model || ''}>{d.model || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{d.device_type || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(d.health)}>{d.health || '—'}</Badge></td>
                    {hasCompliance && (
                      <td className="py-2 pr-3">
                        {d.compliance_status === 'noncompliant' ? (
                          <button onClick={() => setDriftReportId(d.compliance_report_id)}
                            title="Show drifted settings (expected vs current)"
                            className="cursor-pointer">
                            <Badge tone="crit">not compliant{d.compliance_drift ? ` · ${d.compliance_drift}` : ''}</Badge>
                          </button>
                        ) : d.compliance_status === 'compliant' ? (
                          <Badge tone="ok">compliant</Badge>
                        ) : d.compliance_status != null ? (
                          <Badge tone="warn">{String(d.compliance_status).replace('_', ' ')}</Badge>
                        ) : (
                          <span className="text-ink-faint text-xs">—</span>
                        )}
                      </td>
                    )}
                    <td className="py-2 pr-3"><Badge tone={d.power_state === 'on' ? 'ok' : 'neutral'}>{(d.power_state || '—').toUpperCase()}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(d.core_count)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{d.memory_bytes ? fmtBytes(d.memory_bytes) : '—'}</td>
                    {hasPm && <td className="py-2 pr-3 text-right tnum text-ink-muted">{d.power_w != null ? fmtNum(Math.round(d.power_w)) : '—'}</td>}
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{d.ip_address || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{d.ome_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {detailId != null && <DeviceDetailModal deviceId={detailId} onClose={() => setDetailId(null)} />}
      {driftReportId != null && <DriftModal reportId={driftReportId} onClose={() => setDriftReportId(null)} />}
      {showExport && <ExportModal devices={list} onClose={() => setShowExport(false)} />}
    </div>
  );
}
