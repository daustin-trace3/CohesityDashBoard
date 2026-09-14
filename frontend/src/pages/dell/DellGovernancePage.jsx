import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardCheck, Layers, FileCog, X, ShieldCheck, ShieldOff, AlertTriangle } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen } from './helpers';

// effective_status comes from the API: 'accepted' when a non-compliant device
// carries an active variance; otherwise the raw OME status.
const statusTone = (s) => (s === 'compliant' ? 'ok' : s === 'noncompliant' ? 'crit' : s === 'accepted' ? 'info' : s === 'not_inventoried' ? 'warn' : 'neutral');
const statusLabel = (s) => (s === 'noncompliant' ? 'not compliant' : s === 'accepted' ? 'accepted variance' : s === 'not_inventoried' ? 'not inventoried' : s || 'unknown');
const rollupTone = (s) => (s === 'OK' ? 'ok' : s === 'CRITICAL' ? 'crit' : s === 'WARNING' ? 'warn' : 'neutral');
const isStale = (r) => r.status === 'noncompliant' && r.variance_state === 'stale';
// Default table order: needs-attention first, accepted variances after.
const STATUS_RANK = { noncompliant: 0, not_inventoried: 1, unknown: 2, accepted: 3, compliant: 4 };

const btnBase = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimary = `${btnBase} bg-brand text-cohesity-black hover:bg-brand-bright`;
const btnGhost = `${btnBase} border border-cohesity-border text-ink-muted hover:text-ink hover:bg-surface-overlay`;

/** Reason prompt for accepting one or many non-compliant devices as an
 *  approved variance. */
function AcceptVarianceModal({ count, initialReason = '', onSubmit, onClose }) {
  const [reason, setReason] = useState(initialReason);
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 3;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try { await onSubmit(reason.trim()); } finally { setBusy(false); }
  };
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-lg flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2">
            <ShieldCheck size={17} className="text-brand" />
            <p className="text-sm font-semibold text-ink">Accept variance for {count} device{count === 1 ? '' : 's'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay cursor-pointer"><X size={15} /></button>
        </div>
        <div className="p-4">
          <p className="text-[11px] text-ink-faint mb-3">
            The device stays out of compliance in OME but leaves the not-compliant report here. The acceptance is pinned to the
            drifted settings as they are right now. If the configuration changes again, the device comes back on the report
            until someone re-accepts it.
          </p>
          <label className="block text-xs font-medium text-ink-muted mb-1">Reason</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} autoFocus
            placeholder="Why this variance is approved: change ticket, design decision, decommission plan..."
            className="w-full rounded-md bg-surface-base border border-cohesity-border px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-brand" />
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose} className={btnGhost}>Cancel</button>
            <button onClick={submit} disabled={!ok || busy} className={btnPrimary}>
              {busy ? <Spinner size={12} /> : <ShieldCheck size={13} />} Accept variance
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Attribute-level drift for one device: which settings differ from the
 *  baseline template, their expected vs current values, and OME's reason.
 *  Also the single-device place to accept or revoke a variance.
 *  Exported — the Devices page opens it from its compliance column too. */
export function DriftModal({ reportId, onClose, onChanged }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const load = useCallback(() => {
    client.get(`/dell/compliance/${reportId}/detail`)
      .then(({ data }) => setData(data))
      .catch(() => setFailed(true));
  }, [reportId]);
  useEffect(() => { setData(null); setFailed(false); load(); }, [load]);

  const accept = async (reason) => {
    try {
      const { data: r } = await client.post('/dell/compliance/variances', { reportIds: [reportId], reason });
      if (r.accepted) toast({ type: 'success', title: 'Variance accepted' });
      else toast({ type: 'error', title: 'Not accepted', message: r.skipped?.[0]?.why });
      setAccepting(false); load(); onChanged?.();
    } catch { toast({ type: 'error', title: 'Failed to accept variance' }); }
  };
  const revoke = async () => {
    try {
      await client.post('/dell/compliance/variances/revoke', { reportIds: [reportId] });
      toast({ type: 'success', title: 'Variance revoked' });
      load(); onChanged?.();
    } catch { toast({ type: 'error', title: 'Failed to revoke variance' }); }
  };

  const accepted = data?.effective_status === 'accepted';
  const stale = data && isStale(data);

  // Portal to <body>: the page wrapper's fade-in animation leaves a transform
  // applied, which would re-anchor position:fixed and clip the modal.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* Wide table modal: six columns of attribute data — scale with the
          viewport (up to 90rem) instead of the narrow 3xl detail-modal width. */}
      <div className="relative panel w-full max-w-[min(90rem,94vw)] max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardCheck size={17} className="text-brand shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{data ? (data.device_name || data.service_tag || 'Device') : 'Compliance detail'}</p>
              {data && <p className="text-[11px] text-ink-faint truncate">{data.baseline_name} · {data.model || ''} · {data.ome_name}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {data && data.status === 'noncompliant' && (accepted ? (
              <button onClick={revoke} className={btnGhost} title="Put this device back on the not-compliant report"><ShieldOff size={13} /> Revoke variance</button>
            ) : (
              <button onClick={() => setAccepting(true)} disabled={!data.detail?.length} className={btnPrimary}
                title={data.detail?.length ? (stale ? 'Re-pin the acceptance to the current drift' : 'Accept this drift as an approved variance') : 'No drift detail stored yet'}>
                <ShieldCheck size={13} /> {stale ? 'Re-accept variance' : 'Accept variance'}
              </button>
            ))}
            <button onClick={onClose} aria-label="Close"
              className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="p-4 overflow-y-auto">
          {failed ? (
            <div className="text-sm text-status-crit py-6 text-center">Failed to load compliance detail.</div>
          ) : data == null ? (
            <div className="flex items-center justify-center py-10"><Spinner size={20} /></div>
          ) : (
            <>
              {data.variance_id != null && (
                <div className={`rounded-md border px-3 py-2.5 mb-3 text-xs ${accepted ? 'border-status-info/30 bg-status-info/5' : 'border-status-warn/30 bg-status-warn/5'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {accepted ? <ShieldCheck size={14} className="text-status-info" /> : <AlertTriangle size={14} className="text-status-warn" />}
                    <span className={`font-semibold ${accepted ? 'text-status-info' : 'text-status-warn'}`}>
                      {accepted ? 'Accepted variance' : 'Variance no longer matches'}
                    </span>
                    <span className="text-ink-faint">
                      accepted by {data.variance_by || 'unknown'} {fmtWhen(data.variance_at)}
                      {data.variance_drift_count != null ? ` covering ${data.variance_drift_count} drifted setting${data.variance_drift_count === 1 ? '' : 's'}` : ''}
                      {stale && data.variance_stale_at ? ` · drift changed ${fmtWhen(data.variance_stale_at)}` : ''}
                    </span>
                  </div>
                  <p className="text-ink whitespace-pre-wrap">{data.variance_reason}</p>
                  {stale && <p className="text-ink-faint mt-1">The configuration drifted further after acceptance, so the device is back on the not-compliant report. Review the current drift and re-accept if it is still approved.</p>}
                </div>
              )}
              {(data.detail || []).length === 0 ? (
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
            </>
          )}
        </div>
      </div>
      {accepting && (
        <AcceptVarianceModal count={1} initialReason={stale ? (data?.variance_reason || '') : ''}
          onSubmit={accept} onClose={() => setAccepting(false)} />
      )}
    </div>,
    document.body
  );
}

function Tile({ label, value, tone, active, onClick }) {
  const toneClass = tone === 'crit' ? 'text-status-crit' : tone === 'warn' ? 'text-status-warn' : tone === 'ok' ? 'text-status-ok' : tone === 'info' ? 'text-status-info' : 'text-ink';
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

function DevicesSection({ rows: rawRows, onOpenDetail, selected, onToggle, onToggleMany, onAccept, onRevoke }) {
  const rows = useMemo(() => rawRows.map((r) => ({ ...r, status_rank: STATUS_RANK[r.effective_status] ?? 9 })), [rawRows]);
  const ctl = useTableControls(rows, {
    searchKeys: ['device_name', 'service_tag', 'model', 'baseline_name', 'ome_name', 'variance_reason', 'variance_by'],
    defaultSortKey: 'status_rank', defaultSortDir: 'asc',
    paginate: true,
  });
  // Only non-compliant rows (accepted or not) can be selected; the bulk
  // actions act on whichever of the selection they apply to.
  const selectable = (r) => r.status === 'noncompliant';
  const pageSelectable = ctl.pageRows.filter(selectable);
  const allPageSelected = pageSelectable.length > 0 && pageSelectable.every((r) => selected.has(r.id));
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const nAcceptable = selectedRows.filter((r) => r.effective_status !== 'accepted').length;
  const nRevocable = selectedRows.filter((r) => r.variance_id != null).length;

  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ClipboardCheck size={15} className="text-brand" /> Device Compliance</p>
      <p className="text-[11px] text-ink-faint mb-3">Every device evaluated against a baseline. Click a non-compliant row to see exactly which settings drifted, their expected vs current values, and why. Tick rows to accept a variance in bulk; an accepted device leaves the not-compliant count until its configuration changes again.</p>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-4 text-center">No device compliance reports yet.</div>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by device, service tag, baseline, reason…"
            filters={[{ k: 'ome_name', label: 'OME instances' }, { k: 'baseline_name', label: 'Baselines' }, { k: 'effective_status', label: 'Status' }]} />
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-3 rounded-md border border-cohesity-border bg-surface-raised px-3 py-2">
              <span className="text-xs text-ink-muted mr-auto">{selected.size} selected</span>
              <button onClick={onAccept} disabled={nAcceptable === 0} className={btnPrimary}
                title={nAcceptable === 0 ? 'All selected devices are already accepted' : undefined}>
                <ShieldCheck size={13} /> Accept variance{nAcceptable > 0 ? ` (${nAcceptable})` : ''}
              </button>
              <button onClick={onRevoke} disabled={nRevocable === 0} className={btnGhost}>
                <ShieldOff size={13} /> Revoke{nRevocable > 0 ? ` (${nRevocable})` : ''}
              </button>
              <button onClick={() => onToggleMany(selectedRows, false)} className={btnGhost}>Clear</button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-2 w-6">
                  <input type="checkbox" aria-label="Select all non-compliant rows on this page" className="accent-brand cursor-pointer"
                    checked={allPageSelected} disabled={pageSelectable.length === 0}
                    onChange={(e) => onToggleMany(pageSelectable, e.target.checked)} />
                </th>
                <SortTh k="device_name" label="Device" ctl={ctl} />
                <SortTh k="service_tag" label="Service Tag" ctl={ctl} />
                <SortTh k="model" label="Model" ctl={ctl} />
                <SortTh k="baseline_name" label="Baseline" ctl={ctl} />
                <SortTh k="effective_status" label="Status" ctl={ctl} />
                <SortTh k="drift_count" label="Drifted Settings" ctl={ctl} align="center" />
                <SortTh k="variance_reason" label="Variance" ctl={ctl} />
                <SortTh k="inventory_time" label="Inventoried" ctl={ctl} />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => {
                  const clickable = r.status === 'noncompliant';
                  const stale = isStale(r);
                  return (
                    <tr key={r.id}
                      className={`border-b border-cohesity-border/50 ${clickable ? 'cursor-pointer hover:bg-surface-overlay' : ''} ${selected.has(r.id) ? 'bg-brand/5' : ''}`}
                      onClick={clickable ? () => onOpenDetail(r.id) : undefined}>
                      <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}>
                        {selectable(r) && (
                          <input type="checkbox" aria-label={`Select ${r.device_name || r.service_tag}`} className="accent-brand cursor-pointer"
                            checked={selected.has(r.id)} onChange={() => onToggle(r.id)} />
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink whitespace-nowrap">{r.device_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{r.service_tag || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.model || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.baseline_name || '—'}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Badge tone={statusTone(r.effective_status)}>{statusLabel(r.effective_status)}</Badge>
                        {stale && <span title="The drift changed after the variance was accepted"><Badge tone="warn" className="ml-1.5">changed since accepted</Badge></span>}
                      </td>
                      <td className="py-2 pr-3 text-center tnum">
                        {r.status === 'noncompliant'
                          ? <span className={`font-semibold underline decoration-dotted underline-offset-2 ${r.effective_status === 'accepted' ? 'text-ink-muted' : 'text-status-warn'}`}
                              title="Show expected vs current values">{r.has_detail ? `${fmtNum(r.drift_count)} · view` : 'view'}</span>
                          : '—'}
                      </td>
                      <td className="py-2 pr-3 max-w-[280px]">
                        {r.variance_id != null ? (
                          <div className="min-w-0">
                            <p className="text-xs text-ink truncate" title={r.variance_reason}>{r.variance_reason}</p>
                            <p className="text-[10px] text-ink-faint truncate">{r.variance_by || 'unknown'} · {fmtWhen(r.variance_at)}</p>
                          </div>
                        ) : <span className="text-ink-faint text-xs">—</span>}
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
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [accepting, setAccepting] = useState(false);

  const load = useCallback(() => Promise.all([
    client.get('/dell/compliance'),
    client.get('/dell/profiles'),
  ]).then(([c, p]) => {
    // A stale backend answers unknown /api paths with the SPA's index.html
    // (200, string body) — never let a non-JSON response reach the tables.
    const d = c.data && typeof c.data === 'object' ? c.data : {};
    setData({ baselines: Array.isArray(d.baselines) ? d.baselines : [], reports: Array.isArray(d.reports) ? d.reports : [], summary: d.summary || {} });
    setProfiles(Array.isArray(p.data) ? p.data : []);
    setLastRefreshed(new Date());
  }).catch(() => {
    setData({ baselines: [], reports: [], summary: {} }); setProfiles([]);
    toast({ type: 'error', title: 'Failed to load governance data' });
  }), [toast]);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary || {};
  const reports = useMemo(() => data?.reports || [], [data]);
  const visibleReports = statusFilter ? reports.filter((r) => r.effective_status === statusFilter) : reports;

  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleMany = (rows, on) => setSelected((s) => { const n = new Set(s); for (const r of rows) { if (on) n.add(r.id); else n.delete(r.id); } return n; });
  const selectedRows = reports.filter((r) => selected.has(r.id));

  const bulkAccept = async (reason) => {
    const ids = selectedRows.filter((r) => r.effective_status !== 'accepted').map((r) => r.id);
    try {
      const { data: r } = await client.post('/dell/compliance/variances', { reportIds: ids, reason });
      const skipped = r.skipped?.length || 0;
      toast({ type: skipped ? 'warning' : 'success', title: `Accepted variance on ${r.accepted} device${r.accepted === 1 ? '' : 's'}`,
        message: skipped ? `${skipped} skipped: ${r.skipped[0].why}` : undefined });
      setAccepting(false); setSelected(new Set()); load();
    } catch { toast({ type: 'error', title: 'Failed to accept variances' }); }
  };
  const bulkRevoke = async () => {
    const ids = selectedRows.filter((r) => r.variance_id != null).map((r) => r.id);
    try {
      const { data: r } = await client.post('/dell/compliance/variances/revoke', { reportIds: ids });
      toast({ type: 'success', title: `Revoked ${r.revoked} variance${r.revoked === 1 ? '' : 's'}` });
      setSelected(new Set()); load();
    } catch { toast({ type: 'error', title: 'Failed to revoke variances' }); }
  };

  const filterTile = (key) => () => setStatusFilter(statusFilter === key ? null : key);

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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Tile label="Devices Evaluated" value={summary.total || 0} active={statusFilter == null} onClick={() => setStatusFilter(null)} />
            <Tile label="Compliant" value={summary.compliant || 0} tone="ok" active={statusFilter === 'compliant'} onClick={filterTile('compliant')} />
            <Tile label="Not Compliant" value={summary.noncompliant || 0} tone="crit" active={statusFilter === 'noncompliant'} onClick={filterTile('noncompliant')} />
            <Tile label="Accepted Variance" value={summary.accepted || 0} tone="info" active={statusFilter === 'accepted'} onClick={filterTile('accepted')} />
            <Tile label="Not Inventoried" value={summary.not_inventoried || 0} tone="warn" active={statusFilter === 'not_inventoried'} onClick={filterTile('not_inventoried')} />
          </div>

          <BaselinesSection rows={data.baselines || []} />
          <DevicesSection rows={visibleReports} onOpenDetail={setDetailId}
            selected={selected} onToggle={toggle} onToggleMany={toggleMany}
            onAccept={() => setAccepting(true)} onRevoke={bulkRevoke} />
          <ProfilesSection rows={profiles} />

          {detailId != null && <DriftModal reportId={detailId} onClose={() => setDetailId(null)} onChanged={load} />}
          {accepting && (
            <AcceptVarianceModal count={selectedRows.filter((r) => r.effective_status !== 'accepted').length}
              onSubmit={bulkAccept} onClose={() => setAccepting(false)} />
          )}
        </>
      )}
    </div>
  );
}
