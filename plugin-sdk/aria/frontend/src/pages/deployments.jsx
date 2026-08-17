// Ported from the built-in AriaDeploymentsPage.jsx. The built-in detail
// modal used react-dom's createPortal directly; window.ReactDOM here is
// react-dom/client (no createPortal), so this uses the ui.jsx Modal
// primitive (portalOrInline-guarded) instead.
import { Package, X, Loader2 } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Modal,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtNum, fmtWhen, statusTone, leaseTone,
} from '../ui.jsx';

function DetailModal({ detail, loading, onClose }) {
  const facts = detail ? [
    { label: 'Instance', value: detail.instance_name },
    { label: 'Project', value: detail.project_name || detail.project_id },
    { label: 'Deployment ID', value: detail.deployment_id },
    { label: 'Created By', value: detail.created_by },
    { label: 'Created', value: detail.created_at_src ? fmtWhen(detail.created_at_src) : null },
    { label: 'Updated', value: detail.updated_at_src ? fmtWhen(detail.updated_at_src) : null },
    { label: 'Lease Expires', value: detail.lease_expire_at ? fmtWhen(detail.lease_expire_at) : null },
    { label: 'Resources', value: detail.resource_count != null ? fmtNum(detail.resource_count) : null },
  ] : [];
  return (
    <Modal
      title={loading ? 'Loading deployment…' : `Deployment "${detail?.name}"`}
      icon={Package}
      onClose={onClose}
      maxWidth="min(720px,92vw)"
    >
      {loading ? (
        <div className="p-8 flex justify-center"><Loader2 size={18} className="animate-spin text-ink-faint" /></div>
      ) : (
        <div className="flex flex-col gap-4">
          {detail.status && (
            <div><Badge tone={statusTone(detail.status)}>{detail.status}</Badge></div>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {facts.filter((f) => f.value != null && f.value !== '').map((f) => (
              <div key={f.label} className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-ink-faint">{f.label}</div>
                <div className="text-xs text-ink break-words">{f.value}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">
              Resources{detail.resources.length ? ` (${detail.resources.length})` : ''}
            </div>
            {detail.resources.length === 0 ? (
              <div className="text-xs text-ink-muted">No child resources collected for this deployment (resource collection covers a capped subset per poll).</div>
            ) : (
              <ul className="flex flex-col gap-1">
                {detail.resources.map((r) => (
                  <li key={r.id} className="text-xs text-ink bg-surface-overlay border border-cohesity-border rounded px-2 py-1.5">
                    <span className="font-medium">{r.name || r.resource_id}</span>
                    <span className="text-ink-faint"> · {r.type || 'unknown type'}{r.state ? ` · ${r.state}` : ''}{(r.ip_addresses || []).length ? ` · ${r.ip_addresses.join(', ')}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {detail.raw && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">Raw vRA Payload</div>
              <pre className="text-[11px] text-ink-muted bg-surface-overlay border border-cohesity-border rounded px-2 py-1.5 overflow-x-auto overflow-y-auto" style={{ maxHeight: 256 }}>{JSON.stringify(detail.raw, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function AriaDeploymentsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const load = React.useCallback(() => apiFetch('/aria/deployments')
    .then((json) => { setRows(json); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const openDetail = (d) => {
    setDetailLoading(true);
    setDetail(null);
    apiFetch(`/aria/deployments/${d.id}`)
      .then((json) => setDetail(json))
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  };
  const closeDetail = () => { setDetail(null); setDetailLoading(false); };

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'project_name', 'created_by', 'resource_names'],
    defaultSortKey: 'created_at_src', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Package} title="Deployments" description="Aria Automation deployments across all registered instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, resource, project or requester…"
          filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'project_name', label: 'Projects' }, { k: 'status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading deployments…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No deployments found — register an Aria instance under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No deployments match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="instance_name" label="Instance" ctl={ctl} />
                <SortTh k="resource_names" label="Resource" ctl={ctl} />
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="project_name" label="Project" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="resource_count" label="Resources" ctl={ctl} align="right" />
                <SortTh k="lease_days_left" label="Lease" ctl={ctl} align="right" />
                <SortTh k="created_by" label="Created By" ctl={ctl} />
                <SortTh k="created_at_src" label="Created" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((d) => (
                  <tr key={`${d.instance_id}|${d.deployment_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{d.instance_name}</td>
                    <td className="py-2 pr-3 text-ink-muted max-w-[220px] truncate" title={d.resource_names || ''}>{d.resource_names || '—'}</td>
                    <td className="py-2 pr-3 max-w-[280px] truncate">
                      <button onClick={() => openDetail(d)} className="text-ink hover:text-brand cursor-pointer text-left truncate" title="Show deployment details">{d.name || '—'}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{d.project_name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(d.status)}>{d.status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(d.resource_count)}</td>
                    <td className="py-2 pr-3 text-right">
                      {d.lease_days_left == null ? <span className="text-ink-faint">—</span> : (
                        <Badge tone={leaseTone(d.lease_days_left)}>
                          {d.lease_days_left < 0 ? `expired ${Math.abs(d.lease_days_left)}d` : `${d.lease_days_left}d left`}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{d.created_by || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(d.created_at_src)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
      {(detail || detailLoading) && <DetailModal detail={detail} loading={detailLoading} onClose={closeDetail} />}
    </div>
  );
}
