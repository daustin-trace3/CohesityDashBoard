import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  FileBarChart, KeyRound, GitCompareArrows, Timer, UserCog, Activity, HardDrive,
  TrendingUp, Layers, Thermometer, EyeOff, FileCog, FileDown, CalendarClock,
  Recycle, History, Download,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, fmtWhen, healthTone } from './helpers';

const sevTone = (s) => {
  const n = String(s || '').toLowerCase();
  if (n === 'critical' || n === 'fatal' || n === 'failed') return 'crit';
  if (n === 'warning' || n === 'open') return 'warn';
  if (n === 'ok' || n === 'resolved' || n === 'completed' || n === 'compliant') return 'ok';
  return 'info';
};

// Cell renderers by column kind.
const cell = (row, col) => {
  const v = row[col.k];
  if (col.kind === 'when') return <span className="tnum text-xs whitespace-nowrap text-ink-faint">{v ? fmtWhen(v) : '—'}</span>;
  if (col.kind === 'sev') return v ? <Badge tone={sevTone(v)}>{String(v)}</Badge> : '—';
  if (col.kind === 'health') return v ? <Badge tone={healthTone(v)}>{String(v)}</Badge> : '—';
  if (col.kind === 'num') return <span className="tnum">{fmtNum(v)}</span>;
  if (col.kind === 'bytes') return <span className="tnum">{v != null ? fmtBytes(v) : '—'}</span>;
  if (col.kind === 'pct') return <span className="tnum">{v != null ? `${v}%` : '—'}</span>;
  if (col.kind === 'wide') return <span className="text-xs block max-w-[420px] truncate" title={v ?? ''}>{v ?? '—'}</span>;
  return v == null || v === '' ? '—' : String(v);
};

/** Report registry: one entry per report, columns drive both the table and the
 *  CSV export. `extras` renders report-specific summary panels above the table. */
const REPORTS = [
  {
    key: 'idrac-access', group: 'Audit', icon: KeyRound, title: 'iDRAC Access',
    description: 'Every iDRAC login/logout captured in the hardware logs — who, from which IP, over which protocol.',
    days: 7,
    columns: [
      { k: 'created_at', label: 'Time', kind: 'when' },
      { k: 'device_name', label: 'Device' },
      { k: 'user', label: 'User' },
      { k: 'sourceIp', label: 'Source IP' },
      { k: 'protocol', label: 'Protocol' },
      { k: 'message', label: 'Event', kind: 'wide' },
      { k: 'ome_name', label: 'OME' },
    ],
    extras: (s) => s && (
      <div className="flex items-center gap-4 flex-wrap mb-3 text-xs text-ink-muted">
        <span><b className="text-ink tnum">{fmtNum(s.total)}</b> events</span>
        <span><b className="text-ink tnum">{fmtNum(s.uniqueUsers)}</b> distinct users</span>
        <span><b className={`tnum ${s.offHours ? 'text-status-warn' : 'text-ink'}`}>{fmtNum(s.offHours)}</b> off-hours (22:00–06:00 UTC)</span>
        {(s.byUser || []).slice(0, 6).map((u) => (
          <span key={u.user} className="bg-surface-overlay rounded-full px-2.5 py-1">{u.user} · <span className="tnum">{u.count}</span></span>
        ))}
      </div>
    ),
  },
  {
    key: 'config-changes', group: 'Audit', icon: GitCompareArrows, title: 'Config Change Timeline',
    description: 'Configuration-category hardware log entries merged with config-drift detections and resolutions.',
    days: 7,
    columns: [
      { k: 'at', label: 'Time', kind: 'when' },
      { k: 'severity', label: 'Severity', kind: 'sev' },
      { k: 'device_name', label: 'Device' },
      { k: 'source', label: 'Source' },
      { k: 'ref', label: 'Ref' },
      { k: 'event', label: 'Event', kind: 'wide' },
      { k: 'ome_name', label: 'OME' },
    ],
  },
  {
    key: 'remediation', group: 'Audit', icon: Timer, title: 'Drift Remediation',
    description: 'Every config-drift episode with how long it stayed open. MTTR counts resolved episodes only.',
    columns: [
      { k: 'status', label: 'Status', kind: 'sev' },
      { k: 'device_name', label: 'Device' },
      { k: 'attr_group', label: 'Group' },
      { k: 'attribute', label: 'Attribute' },
      { k: 'expected', label: 'Expected' },
      { k: 'current', label: 'Found' },
      { k: 'first_seen', label: 'Detected', kind: 'when' },
      { k: 'resolved_at', label: 'Resolved', kind: 'when' },
      { k: 'duration_days', label: 'Days Open', kind: 'num' },
    ],
    extras: (s) => s && (
      <div className="mb-3">
        <div className="flex items-center gap-4 flex-wrap text-xs text-ink-muted mb-2">
          <span><b className={`tnum ${s.open ? 'text-status-warn' : 'text-ink'}`}>{fmtNum(s.open)}</b> open</span>
          <span><b className="text-ink tnum">{fmtNum(s.resolved)}</b> resolved</span>
          <span>MTTR <b className="text-ink tnum">{s.mttrDays != null ? `${s.mttrDays}d` : '—'}</b></span>
        </div>
        {(s.offenders || []).length > 0 && (
          <p className="text-[11px] text-ink-faint">
            Most-drifted settings: {s.offenders.slice(0, 5).map((o) => `${o.attribute} (${o.devices} device${o.devices === 1 ? '' : 's'})`).join(' · ')}
          </p>
        )}
      </div>
    ),
  },
  {
    key: 'job-accountability', group: 'Audit', icon: UserCog, title: 'Job Accountability',
    description: 'Appliance jobs by the account that created them — firmware pushes, config deploys, discoveries.',
    columns: [
      { k: 'created_by', label: 'User' },
      { k: 'name', label: 'Job' },
      { k: 'job_type', label: 'Type' },
      { k: 'last_run_status', label: 'Last Run', kind: 'sev' },
      { k: 'last_run', label: 'When', kind: 'when' },
      { k: 'targets', label: 'Targets', kind: 'wide' },
      { k: 'ome_name', label: 'OME' },
    ],
    extras: (s) => s && (
      <div className="flex items-center gap-2 flex-wrap mb-3 text-xs text-ink-muted">
        {(s.byUser || []).map((u) => (
          <span key={u.user} className="bg-surface-overlay rounded-full px-2.5 py-1">
            {u.user || 'unknown'} · <span className="tnum">{u.jobs}</span>{u.failed ? <span className="text-status-crit"> ({u.failed} failed)</span> : null}
          </span>
        ))}
      </div>
    ),
  },
  {
    key: 'job-health', group: 'Operations', icon: Activity, title: 'Job Health',
    description: 'Failure rate by job type, plus schedules that silently stopped firing and disabled jobs.',
    columns: [
      { k: 'job_type', label: 'Job Type' },
      { k: 'total', label: 'Jobs', kind: 'num' },
      { k: 'failed', label: 'Failed', kind: 'num' },
      { k: 'warning', label: 'Warning', kind: 'num' },
    ],
    extras: (s) => s && (
      <div className="mb-3 flex flex-col gap-2">
        {(s.stalled || []).length > 0 && (
          <div className="text-xs">
            <p className="font-semibold text-status-warn mb-1">Stalled schedules (next run already passed)</p>
            {s.stalled.map((j, i) => (
              <p key={i} className="text-ink-muted">{j.name} — was due {fmtWhen(j.next_run)} <span className="text-ink-faint">· {j.ome_name}</span></p>
            ))}
          </div>
        )}
        {(s.disabled || []).length > 0 && (
          <div className="text-xs">
            <p className="font-semibold text-ink mb-1">Disabled jobs</p>
            {s.disabled.map((j, i) => (
              <p key={i} className="text-ink-muted">{j.name} ({j.job_type}) <span className="text-ink-faint">· {j.ome_name}</span></p>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    key: 'predictive-watchlist', group: 'Operations', icon: HardDrive, title: 'Disk Watchlist',
    description: 'Predictive-failure flags, unhealthy disks, and SSDs below 30% write endurance — replace before they fail.',
    columns: [
      { k: 'device_name', label: 'Device' },
      { k: 'slot', label: 'Slot' },
      { k: 'name', label: 'Disk', kind: 'wide' },
      { k: 'serial', label: 'Serial' },
      { k: 'media', label: 'Media' },
      { k: 'size_bytes', label: 'Size', kind: 'bytes' },
      { k: 'endurance_pct', label: 'Endurance Left', kind: 'pct' },
      { k: 'predictive_failure', label: 'Predictive' },
      { k: 'status', label: 'Status', kind: 'health' },
      { k: 'ome_name', label: 'OME' },
    ],
  },
  {
    key: 'hw-event-trends', group: 'Operations', icon: TrendingUp, title: 'Hardware Event Trends',
    description: 'Noisiest servers by warning/critical/fatal hardware-log volume (routine info entries such as OME login audits are excluded); the trend column compares the last 7 days to the 7 before.',
    days: 7,
    columns: [
      { k: 'device_name', label: 'Device' },
      { k: 'model', label: 'Model' },
      { k: 'critical', label: 'Critical', kind: 'num' },
      { k: 'warning', label: 'Warning', kind: 'num' },
      { k: 'total', label: 'Events', kind: 'num' },
      { k: 'bad_7d', label: 'Last 7d', kind: 'num' },
      { k: 'trend', label: 'Trend vs prior 7d', kind: 'num' },
      { k: 'ome_name', label: 'OME' },
    ],
  },
  {
    key: 'firmware-currency', group: 'Operations', icon: Layers, title: 'Firmware Currency',
    description: 'Devices behind their firmware baseline, worst first, plus the iDRAC version spread across the fleet.',
    columns: [
      { k: 'device_name', label: 'Device' },
      { k: 'service_tag', label: 'Service Tag' },
      { k: 'device_model', label: 'Model' },
      { k: 'baseline_name', label: 'Baseline' },
      { k: 'noncompliant_components', label: 'Components Behind', kind: 'num' },
      { k: 'ome_name', label: 'OME' },
    ],
    extras: (s) => s && (s.sprawl || []).length > 0 && (
      <div className="flex items-center gap-2 flex-wrap mb-3 text-xs text-ink-muted">
        <span className="text-ink-faint">iDRAC versions:</span>
        {s.sprawl.map((v, i) => (
          <span key={i} className="bg-surface-overlay rounded-full px-2.5 py-1">{v.firmware_version || 'unknown'} · <span className="tnum">{v.devices}</span></span>
        ))}
      </div>
    ),
  },
  {
    key: 'thermal-power', group: 'Operations', icon: Thermometer, title: 'Thermal & Power Outliers',
    description: 'Hottest inlets first; power delta compares each server against the average of its model peers.',
    columns: [
      { k: 'device_name', label: 'Device' },
      { k: 'model', label: 'Model' },
      { k: 'inlet_temp_c', label: 'Inlet °C', kind: 'num' },
      { k: 'power_w', label: 'Watts', kind: 'num' },
      { k: 'model_avg_power', label: 'Model Avg W', kind: 'num' },
      { k: 'power_delta_pct', label: 'Δ vs peers', kind: 'pct' },
      { k: 'ome_name', label: 'OME' },
    ],
  },
  {
    key: 'stale-management', group: 'Operations', icon: EyeOff, title: 'Stale Management',
    description: 'Monitoring blind spots: devices disconnected from OME or with an aging inventory. Exception report — empty means every device is connected and freshly inventoried.',
    days: 7,
    emptyText: (s) => `All ${fmtNum(s?.checked)} devices are connected with fresh inventory — an empty result here is the healthy one.`,
    columns: [
      { k: 'device_name', label: 'Device' },
      { k: 'service_tag', label: 'Service Tag' },
      { k: 'model', label: 'Model' },
      { k: 'connection_state', label: 'Connected' },
      { k: 'last_inventory_time', label: 'Last Inventory', kind: 'when' },
      { k: 'inventory_age_days', label: 'Age (days)', kind: 'num' },
      { k: 'ome_name', label: 'OME' },
    ],
  },
  {
    key: 'profile-hygiene', group: 'Operations', icon: FileCog, title: 'Profile Hygiene',
    description: 'Configuration profiles that drifted from their template, failed to deploy, or sit unassigned. Exception report — empty means every profile is deployed and unmodified (the full list lives on Governance).',
    emptyText: (s) => `All ${fmtNum(s?.checked)} profile(s) are deployed and unmodified — an empty result here is the healthy one.`,
    columns: [
      { k: 'issue', label: 'Issue', kind: 'sev' },
      { k: 'name', label: 'Profile' },
      { k: 'template_name', label: 'Template' },
      { k: 'target_name', label: 'Target' },
      { k: 'state', label: 'State' },
      { k: 'last_run_status', label: 'Deploy Status' },
      { k: 'last_deploy_date', label: 'Last Deploy', kind: 'when' },
      { k: 'ome_name', label: 'OME' },
    ],
  },
  {
    key: 'support-packet', group: 'Support', icon: FileDown, title: 'Support Case Packet',
    description: 'One text file with everything Dell support asks for: identity, serials, firmware, contract, 30 days of logs and alerts.',
    needsDevice: true, packet: true,
  },
  {
    key: 'warranty-forecast', group: 'Support', icon: CalendarClock, title: 'Warranty Forecast',
    description: 'Renewals by quarter and coverage mix. The table is the risk overlap: active hardware faults on boxes with ≤90 days of support left — empty means no at-risk overlap.',
    emptyText: (s) => (s?.contracts
      ? `No failing hardware on boxes with ≤90 days of support — the risk overlap is clear (${fmtNum(s.tags)} service tag(s) under ${fmtNum(s.contracts)} contract(s) checked).`
      : 'OME returned no warranty data at all — the appliance needs internet access / SupportAssist for WarrantyService to populate.'),
    columns: [
      { k: 'device_name', label: 'Device' },
      { k: 'service_tag', label: 'Service Tag' },
      { k: 'model', label: 'Model' },
      { k: 'warranty_days_left', label: 'Support Days Left', kind: 'num' },
      { k: 'failing_components', label: 'Failing Parts', kind: 'num' },
      { k: 'failing_detail', label: 'What', kind: 'wide' },
      { k: 'ome_name', label: 'OME' },
    ],
    extras: (s) => s && (
      <div className="mb-3 flex flex-col gap-2 text-xs text-ink-muted">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-ink-faint">Expiring by quarter:</span>
          {(s.byQuarter || []).map((q) => (
            <span key={q.quarter} className="bg-surface-overlay rounded-full px-2.5 py-1">{q.quarter} · <span className="tnum">{q.count}</span></span>
          ))}
          <span className="bg-surface-overlay rounded-full px-2.5 py-1 text-status-crit">already expired · <span className="tnum">{fmtNum(s.expired)}</span></span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-ink-faint">Coverage mix:</span>
          {(s.byLevel || []).map((l) => (
            <span key={l.level} className="bg-surface-overlay rounded-full px-2.5 py-1">{l.level} · <span className="tnum">{l.count}</span></span>
          ))}
        </div>
      </div>
    ),
  },
  {
    key: 'refresh-planning', group: 'Support', icon: Recycle, title: 'Refresh Planning',
    description: 'Ranked refresh candidates: age (warranty start as ship-date proxy) + support runway + failing parts. The score is a sort key, not a verdict.',
    columns: [
      { k: 'refresh_score', label: 'Score', kind: 'num' },
      { k: 'device_name', label: 'Device' },
      { k: 'model', label: 'Model' },
      { k: 'age_years', label: 'Age (yrs)', kind: 'num' },
      { k: 'warranty_days_left', label: 'Support Days Left', kind: 'num' },
      { k: 'failing_components', label: 'Failing Parts', kind: 'num' },
      { k: 'fw_noncompliant', label: 'FW Behind', kind: 'num' },
      { k: 'ome_name', label: 'OME' },
    ],
  },
  {
    key: 'server-timeline', group: 'Support', icon: History, title: 'Server Timeline',
    description: 'One server, one chronology: alerts, hardware log, config drift and matching jobs merged.',
    needsDevice: true, days: 7,
    columns: [
      { k: 'at', label: 'Time', kind: 'when' },
      { k: 'severity', label: 'Severity', kind: 'sev' },
      { k: 'source', label: 'Source' },
      { k: 'ref', label: 'Ref' },
      { k: 'event', label: 'Event', kind: 'wide' },
    ],
  },
];

const DAY_CHOICES = [7, 30, 90, 365];

function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(','),
    ...rows.map((r) => columns.map((c) => esc(r[c.k])).join(','))].join('\r\n');
}

export default function DellReportsPage() {
  const { toast } = useToast();
  const [active, setActive] = useState(REPORTS[0]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [daysSel, setDaysSel] = useState(null);
  const [devices, setDevices] = useState(null);
  const [deviceSel, setDeviceSel] = useState('');

  // Server list for the per-device reports, fetched once on demand.
  useEffect(() => {
    if (active.needsDevice && devices == null) {
      client.get('/dell/devices')
        .then(({ data }) => setDevices((Array.isArray(data) ? data : []).filter((d) => /server/i.test(d.device_type || ''))))
        .catch(() => setDevices([]));
    }
  }, [active, devices]);

  const effDays = daysSel ?? active.days ?? null;

  const load = useCallback(() => {
    if (active.packet) { setData(null); return; }
    if (active.needsDevice && !deviceSel) { setData(null); return; }
    setLoading(true);
    const params = {
      ...(effDays ? { days: effDays } : {}),
      ...(active.needsDevice ? { deviceId: deviceSel } : {}),
    };
    // Longer ranges pull far more rows — stretch past the 30s client default.
    const timeout = effDays >= 365 ? 180000 : effDays >= 90 ? 120000 : effDays >= 30 ? 60000 : undefined;
    client.get(`/dell/reports/${active.key}`, { params, ...(timeout ? { timeout } : {}) })
      .then(({ data }) => {
        setData({ rows: Array.isArray(data?.rows) ? data.rows : [], summary: data?.summary || null, device: data?.device || null });
        setLastRefreshed(new Date());
      })
      .catch(() => { setData({ rows: [], summary: null, error: true }); toast({ type: 'error', title: `Failed to load ${active.title}` }); })
      .finally(() => setLoading(false));
  }, [active, effDays, deviceSel, toast]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const ctl = useTableControls(rows, { paginate: true });

  const selectReport = (r) => { setActive(r); setData(null); setDaysSel(null); };

  const exportCsv = () => {
    const csv = toCsv(active.columns, ctl.rows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dell-${active.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const downloadPacket = async () => {
    try {
      const { data } = await client.get('/dell/reports/support-packet', { params: { deviceId: deviceSel }, responseType: 'blob' });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      const dev = (devices || []).find((d) => String(d.id) === String(deviceSel));
      a.href = url; a.download = `support-packet-${dev?.service_tag || deviceSel}.txt`;
      a.click(); URL.revokeObjectURL(url);
    } catch { toast({ type: 'error', title: 'Failed to build the support packet' }); }
  };

  const groups = useMemo(() => ['Audit', 'Operations', 'Support'].map((g) => ({ g, items: REPORTS.filter((r) => r.group === g) })), []);
  const selectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={FileBarChart} title="Reports" description="Audit, operations and support reports built from the data already collected from OME">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex gap-4 items-start">
        {/* Report picker rail */}
        <div className="w-56 shrink-0 flex flex-col gap-3">
          {groups.map(({ g, items }) => (
            <div key={g} className="panel p-2" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint px-2 pt-1 pb-1.5">{g}</p>
              {items.map((r) => {
                const Icon = r.icon;
                const isActive = active.key === r.key;
                return (
                  <button key={r.key} onClick={() => selectReport(r)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors cursor-pointer ${isActive ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:bg-surface-overlay/60 hover:text-ink'}`}>
                    <Icon size={13} className={isActive ? 'text-brand' : 'text-ink-faint'} />
                    {r.title}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Report body */}
        <div className="flex-1 min-w-0 panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-start justify-between gap-3 mb-1 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-ink flex items-center gap-2">
                <active.icon size={15} className="text-brand" /> {active.title}
              </p>
              <p className="text-[11px] text-ink-faint mt-0.5 max-w-2xl">{active.description}</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {active.needsDevice && (
                <select value={deviceSel} onChange={(e) => setDeviceSel(e.target.value)} className={selectCls} aria-label="Server">
                  <option value="">Select a server…</option>
                  {(devices || []).map((d) => <option key={d.id} value={d.id}>{d.name || d.service_tag}</option>)}
                </select>
              )}
              {active.days != null && (
                <select value={effDays} onChange={(e) => setDaysSel(Number(e.target.value))} className={selectCls} aria-label="Timeframe">
                  {DAY_CHOICES.map((n) => <option key={n} value={n}>Last {n} days</option>)}
                </select>
              )}
              {active.packet ? (
                <button onClick={downloadPacket} disabled={!deviceSel}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${deviceSel ? 'border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 cursor-pointer' : 'border-cohesity-border/50 text-ink-faint cursor-not-allowed'}`}>
                  <Download size={13} /> Download Packet
                </button>
              ) : (
                <button onClick={exportCsv} disabled={!rows.length}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${rows.length ? 'border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 cursor-pointer' : 'border-cohesity-border/50 text-ink-faint cursor-not-allowed'}`}>
                  <Download size={13} /> CSV
                </button>
              )}
            </div>
          </div>

          <div className="mt-3">
            {active.packet ? (
              <div className="text-sm text-ink-muted py-8 text-center">
                {deviceSel
                  ? 'Ready — Download Packet builds the file from the latest polled data.'
                  : 'Pick a server to build its support packet.'}
              </div>
            ) : active.needsDevice && !deviceSel ? (
              <div className="text-sm text-ink-muted py-8 text-center">Pick a server to build its timeline.</div>
            ) : loading || data == null ? (
              <LoadingPanel label={`Loading ${active.title}…`} height={180} />
            ) : data.error ? (
              // A failed fetch must NOT render the healthy "clean" empty state.
              <div className="text-sm text-status-crit py-8 text-center">
                Failed to load {active.title} — the request errored or timed out.{' '}
                <button type="button" onClick={load} className="underline text-ink hover:text-brand">Retry</button>
              </div>
            ) : (
              <>
                {data.device && (
                  <p className="text-xs text-ink-muted mb-2">
                    <b className="text-ink">{data.device.name}</b> · {data.device.model} · {data.device.serviceTag} · {data.device.omeName}
                  </p>
                )}
                {active.extras ? active.extras(data.summary) : null}
                {rows.length === 0 ? (
                  <div className="text-sm text-status-ok py-8 text-center">
                    {active.emptyText ? active.emptyText(data.summary) : 'Nothing to report — clean.'}
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                          {active.columns.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} />)}
                        </tr></thead>
                        <tbody>
                          {ctl.pageRows.map((r, i) => (
                            <tr key={i} className="border-b border-cohesity-border/50 align-top">
                              {active.columns.map((c) => (
                                <td key={c.k} className="py-2 pr-3 text-ink-muted">{cell(r, c)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <TablePager ctl={ctl} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
