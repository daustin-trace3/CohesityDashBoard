import { ClipboardCheck, Layers, FileCog } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner, Modal,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtNum, fmtWhen,
} from '../ui.jsx';

const statusTone = (s) => (s === 'compliant' ? 'ok' : s === 'noncompliant' ? 'crit' : s === 'not_inventoried' ? 'warn' : 'neutral');
const statusLabel = (s) => (s === 'noncompliant' ? 'not compliant' : s === 'not_inventoried' ? 'not inventoried' : s || 'unknown');
const rollupTone = (s) => (s === 'OK' ? 'ok' : s === 'CRITICAL' ? 'crit' : s === 'WARNING' ? 'warn' : 'neutral');

/** Attribute-level drift for one device: which settings differ from the
 *  baseline template, their expected vs current values, and OME's reason.
 *  Exported — the Devices page opens it from its compliance column too. */
export function DriftModal({ reportId, onClose }) {
  const [data, setData] = React.useState(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setData(null); setFailed(false);
    apiFetch(`/dell/compliance/${reportId}/detail`)
      .then((json) => setData(json))
      .catch(() => setFailed(true));
  }, [reportId]);

  return (
    <Modal
      title={data ? (data.device_name || data.service_tag || 'Device') : 'Compliance detail'}
      subtitle={data ? `${data.baseline_name} · ${data.model || ''} · ${data.ome_name}` : null}
      icon={ClipboardCheck} onClose={onClose} maxWidth="min(90rem,94vw)">
      {failed ? (
        <div className="text-sm text-status-crit py-6 text-center">Failed to load compliance detail.</div>
      ) : data == null ? (
        <div className="flex items-center justify-center py-10"><Spinner size={20} /></div>
      ) : (data.detail || []).length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">
          No attribute-level drift stored for this device — the poller records detail for non-compliant devices only.
        </div>
      ) : (
        <>
          <p className="text-[11px] text-ink-faint mb-2">
            Config inventoried {fmtWhen(data.inventory_time)} — "Detected" is when the dashboard first
            observed the drift (OME does not report the change moment itself).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Component / Group</th>
                <th className="py-2 pr-3">Attribute</th>
                <th className="py-2 pr-3">Expected</th>
                <th className="py-2 pr-3">Current</th>
                <th className="py-2 pr-3">Detected</th>
                <th className="py-2 pr-3">Reason</th>
              </tr></thead>
              <tbody>
                {data.detail.map((d, i) => (
                  <tr key={i} className="border-b border-cohesity-border/50 align-top">
                    <td className="py-2 pr-3 text-ink">{d.group || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted break-words max-w-[280px]">{d.attribute || '—'}</td>
                    <td className="py-2 pr-3 text-status-ok text-xs break-words max-w-[260px]">{d.expected ?? '—'}</td>
                    <td className="py-2 pr-3 text-status-warn text-xs break-words max-w-[260px]">{d.current ?? '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-xs tnum whitespace-nowrap">{d.detectedAt ? fmtWhen(d.detectedAt) : '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-xs">{d.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function Tile({ label, value, tone, active, onClick }) {
  const toneClass = tone === 'crit' ? 'text-status-crit' : tone === 'warn' ? 'text-status-warn' : tone === 'ok' ? 'text-status-ok' : 'text-ink';
  return (
    <button onClick={onClick}
      className={`panel px-4 py-3 text-left transition-colors ${active ? 'ring-1 ring-brand' : 'hover:bg-surface-overlay'}`}
      style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className={`text-xl font-semibold tnum ${toneClass}`}>{fmtNum(value)}</p>
      <p className="text-[11px] text-ink-faint mt-0.5">{label}</p>
    </button>
  );
}

function BaselinesSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'template_name', 'ome_name'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Layers size={15} className="text-brand" /> Compliance Baselines</p>
      <p className="text-[11px] text-ink-faint mb-3">Configuration baselines defined on the OME appliances and their compliance rollup. Empty until a baseline is created in OME (Configuration &gt; Configuration Compliance).</p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-4 text-center">No configuration baselines reported.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by baseline, template…"
            filters={[{ k: 'ome_name', label: 'OME instances' }, { k: 'compliance_status', label: 'Status' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Baseline" ctl={ctl} />
                <SortTh k="template_name" label="Template" ctl={ctl} />
                <SortTh k="compliance_status" label="Rollup" ctl={ctl} />
                <SortTh k="n_critical" label="Critical" ctl={ctl} align="center" />
                <SortTh k="n_warning" label="Warning" ctl={ctl} align="center" />
                <SortTh k="n_normal" label="Compliant" ctl={ctl} align="center" />
                <SortTh k="last_run" label="Last Run" ctl={ctl} />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((b) => (
                  <tr key={b.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{b.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{b.template_name || (b.template_id != null ? `#${b.template_id}` : '—')}</td>
                    <td className="py-2 pr-3"><Badge tone={rollupTone(b.compliance_status)}>{b.compliance_status || 'unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-center tnum text-status-crit">{fmtNum(b.n_critical)}</td>
                    <td className="py-2 pr-3 text-center tnum text-status-warn">{fmtNum(b.n_warning)}</td>
                    <td className="py-2 pr-3 text-center tnum text-status-ok">{fmtNum(b.n_normal)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-xs tnum whitespace-nowrap">{fmtWhen(b.last_run)}</td>
                    <td className="py-2 pr-3 text-ink-muted">{b.ome_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </div>
  );
}

function DevicesSection({ rows, onOpenDetail }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['device_name', 'service_tag', 'model', 'baseline_name', 'ome_name'],
    defaultSortKey: 'status', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ClipboardCheck size={15} className="text-brand" /> Device Compliance</p>
      <p className="text-[11px] text-ink-faint mb-3">Every device evaluated against a baseline. Click a non-compliant row to see exactly which settings drifted, their expected vs current values, and why.</p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-4 text-center">No device compliance reports yet.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by device, service tag, baseline…"
            filters={[{ k: 'ome_name', label: 'OME instances' }, { k: 'baseline_name', label: 'Baselines' }, { k: 'status', label: 'Status' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="device_name" label="Device" ctl={ctl} />
                <SortTh k="service_tag" label="Service Tag" ctl={ctl} />
                <SortTh k="model" label="Model" ctl={ctl} />
                <SortTh k="baseline_name" label="Baseline" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="drift_count" label="Drifted Settings" ctl={ctl} align="center" />
                <SortTh k="inventory_time" label="Inventoried" ctl={ctl} />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => {
                  const clickable = r.status === 'noncompliant';
                  return (
                    <tr key={r.id}
                      className={`border-b border-cohesity-border/50 ${clickable ? 'cursor-pointer hover:bg-surface-overlay' : ''}`}
                      onClick={clickable ? () => onOpenDetail(r.id) : undefined}>
                      <td className="py-2 pr-3 text-ink whitespace-nowrap">{r.device_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{r.service_tag || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.model || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.baseline_name || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge></td>
                      <td className="py-2 pr-3 text-center tnum">
                        {r.status === 'noncompliant'
                          ? <span className="text-status-warn font-semibold underline decoration-dotted underline-offset-2"
                              title="Show expected vs current values">{r.has_detail ? `${fmtNum(r.drift_count)} · view` : 'view'}</span>
                          : '—'}
                      </td>
                      <td className="py-2 pr-3 text-ink-faint text-xs tnum whitespace-nowrap">{fmtWhen(r.inventory_time)}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.ome_name}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </div>
  );
}

function ProfilesSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'template_name', 'target_name', 'ome_name'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  const stateTone = (s) => (s === 'deployed' ? 'ok' : s === 'assigned' ? 'info' : 'neutral');
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><FileCog size={15} className="text-brand" /> Configuration Profiles</p>
      <p className="text-[11px] text-ink-faint mb-3">Server configuration profiles created from templates (Configuration &gt; Profiles) and where they are deployed. "Modified" marks a profile that drifted from its source template.</p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-4 text-center">No configuration profiles reported.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by profile, template, target…"
            filters={[{ k: 'ome_name', label: 'OME instances' }, { k: 'state', label: 'State' }, { k: 'template_name', label: 'Templates' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Profile" ctl={ctl} />
                <SortTh k="template_name" label="Template" ctl={ctl} />
                <SortTh k="target_name" label="Target" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="last_run_status" label="Last Deploy Status" ctl={ctl} />
                <SortTh k="last_deploy_date" label="Last Deployed" ctl={ctl} />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink whitespace-nowrap">
                      {p.name || '—'}
                      {p.profile_modified ? <Badge tone="warn" className="ml-2">modified</Badge> : null}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{p.template_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.target_name || p.chassis_name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={stateTone(p.state)}>{p.state || 'unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-xs">{p.last_run_status || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-xs tnum whitespace-nowrap">{p.last_deploy_date ? fmtWhen(p.last_deploy_date) : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.ome_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </div>
  );
}

export default function DellGovernancePage() {
  const [data, setData] = React.useState(null);
  const [profiles, setProfiles] = React.useState([]);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [statusFilter, setStatusFilter] = React.useState(null);
  const [detailId, setDetailId] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiFetch('/dell/compliance'),
    apiFetch('/dell/profiles'),
  ]).then(([c, p]) => {
    // A stale backend answers unknown /api paths with the SPA's index.html
    // (200, string body) — never let a non-JSON response reach the tables.
    const d = c && typeof c === 'object' ? c : {};
    setData({ baselines: Array.isArray(d.baselines) ? d.baselines : [], reports: Array.isArray(d.reports) ? d.reports : [], summary: d.summary || {} });
    setProfiles(Array.isArray(p) ? p : []);
    setLastRefreshed(new Date());
  }).catch(() => {
    setData({ baselines: [], reports: [], summary: {} }); setProfiles([]);
  }), []);

  React.useEffect(() => { load(); }, [load]);

  const summary = data?.summary || {};
  const reports = data?.reports || [];
  const visibleReports = statusFilter ? reports.filter((r) => r.status === statusFilter) : reports;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ClipboardCheck} title="Governance" description="Configuration compliance against OME baselines — which devices drifted, which settings, and why">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading governance data…" height={200} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Tile label="Devices Evaluated" value={summary.total || 0} active={statusFilter == null} onClick={() => setStatusFilter(null)} />
            <Tile label="Compliant" value={summary.compliant || 0} tone="ok" active={statusFilter === 'compliant'}
              onClick={() => setStatusFilter(statusFilter === 'compliant' ? null : 'compliant')} />
            <Tile label="Not Compliant" value={summary.noncompliant || 0} tone="crit" active={statusFilter === 'noncompliant'}
              onClick={() => setStatusFilter(statusFilter === 'noncompliant' ? null : 'noncompliant')} />
            <Tile label="Not Inventoried" value={summary.not_inventoried || 0} tone="warn" active={statusFilter === 'not_inventoried'}
              onClick={() => setStatusFilter(statusFilter === 'not_inventoried' ? null : 'not_inventoried')} />
          </div>

          <BaselinesSection rows={data.baselines || []} />
          <DevicesSection rows={visibleReports} onOpenDetail={setDetailId} />
          <ProfilesSection rows={profiles} />

          {detailId != null && <DriftModal reportId={detailId} onClose={() => setDetailId(null)} />}
        </>
      )}
    </div>
  );
}
