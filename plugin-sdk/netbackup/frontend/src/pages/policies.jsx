// NetBackup Policies — ports host frontend/src/pages/netbackup/NbPoliciesPage.jsx.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner,
  useTableControls, SortTh, TableControls, TablePager, CsvExportButton,
  ShieldIcon, XIcon, UsersIcon, CalendarIcon, DbIcon,
} from '../ui.jsx';
import { BRAND, fmtNum, apiGet } from './helpers.js';

injectStyles();

const fmtFrequency = (s) => {
  if (!s) return null;
  if (s % 604800 === 0) { const w = s / 604800; return w === 1 ? 'Weekly' : `Every ${w} weeks`; }
  if (s % 86400 === 0) { const d = s / 86400; return d === 1 ? 'Daily' : `Every ${d} days`; }
  if (s % 3600 === 0) return `Every ${s / 3600}h`;
  return `Every ${s}s`;
};


// window.ReactDOM is react-dom/client on current hosts — it has NO
// createPortal, so an unguarded call crashes the page (campaign trap #1).
// Fall back to inline rendering: the overlay is position:fixed, so it
// still covers the viewport without a portal.
function __portalOrInline(node) {
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(node, document.body);
  return node;
}

function DetailSection({ icon: Icon, title, count, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon size={13} style={{ color: 'var(--nb-brand)' }} /> {title}
        <span className="nb-tnum" style={{ color: 'var(--nb-ink-faint)', fontWeight: 400 }}>({count})</span>
      </p>
      {children}
    </div>
  );
}

function PolicyDetailModal({ policy, onClose }) {
  const [detail, setDetail] = React.useState(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    apiGet(`/policies/${policy.id}`).then((d) => { if (!cancelled) setDetail(d); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [policy.id]);

  return __portalOrInline(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', padding: 16 }}>
      <div className="nb-panel" onClick={(e) => e.stopPropagation()} style={{ width: 'auto', minWidth: 560, maxWidth: '92vw', padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--nb-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{policy.name}</h2>
            <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', margin: '2px 0 0' }}>
              {policy.policyType || '—'} · {policy.sourceName}{' '}
              <Badge tone={policy.active ? 'ok' : 'neutral'}>{policy.active ? 'Active' : 'Inactive'}</Badge>
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--nb-ink-faint)', cursor: 'pointer', flexShrink: 0 }}><XIcon size={16} /></button>
        </div>
        <div className="nb-scroll" style={{ overflowY: 'auto', minHeight: 120 }}>
          {error ? (
            <div style={{ fontSize: 13, color: 'var(--nb-crit)', padding: '24px 0', textAlign: 'center' }}>Failed to load policy detail.</div>
          ) : !detail ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><Spinner size={20} /></div>
          ) : !detail.hasDetail ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>
              No stored detail for this policy yet — it will populate on the next poll of {policy.sourceName}.
            </div>
          ) : (
            <>
              <DetailSection icon={UsersIcon} title="Clients" count={detail.clients.length}>
                {detail.clients.length === 0 ? <p style={{ fontSize: 12, color: 'var(--nb-ink-faint)' }}>None</p> : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {detail.clients.map((c) => (
                      <ReactRouterDOM.Link key={c} to={`/ops/server360?name=${encodeURIComponent(c)}`} title="Open Server 360"
                        style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, background: 'var(--nb-surface-overlay)', border: '1px solid var(--nb-border)', color: 'var(--nb-ink)', textDecoration: 'none' }}>
                        {c}
                      </ReactRouterDOM.Link>
                    ))}
                  </div>
                )}
              </DetailSection>
              <DetailSection icon={CalendarIcon} title="Schedules" count={detail.schedules.length}>
                {detail.schedules.length === 0 ? <p style={{ fontSize: 12, color: 'var(--nb-ink-faint)' }}>None</p> : (
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead><tr style={{ textAlign: 'left', fontSize: 10, textTransform: 'uppercase', color: 'var(--nb-ink-faint)', borderBottom: '1px solid var(--nb-border)' }}>
                      <th style={{ padding: '6px 12px 6px 0' }}>Name</th><th style={{ padding: '6px 12px 6px 0' }}>Type</th><th style={{ padding: '6px 12px 6px 0' }}>Frequency</th><th style={{ padding: '6px 0' }}>Retention Level</th>
                    </tr></thead>
                    <tbody>
                      {detail.schedules.map((s, i) => (
                        <tr key={`${s.name}-${i}`} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                          <td style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink)' }}>{s.name || '—'}</td>
                          <td style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink-muted)' }}>{s.type || '—'}</td>
                          <td style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink-muted)' }}>{fmtFrequency(s.frequencySeconds) || '—'}</td>
                          <td className="nb-tnum" style={{ padding: '6px 0', color: 'var(--nb-ink-muted)' }}>{s.retentionLevel ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </DetailSection>
              <DetailSection icon={DbIcon} title="Backup Selections" count={detail.selections.length}>
                {detail.selections.length === 0 ? <p style={{ fontSize: 12, color: 'var(--nb-ink-faint)' }}>None</p> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {detail.selections.map((sel, i) => (
                      <div key={i} style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--nb-ink-muted)', background: 'var(--nb-surface-overlay)', border: '1px solid var(--nb-border)', borderRadius: 6, padding: '4px 8px', wordBreak: 'break-all' }}>{sel}</div>
                    ))}
                  </div>
                )}
              </DetailSection>
            </>
          )}
        </div>
      </div>
    </div>);
}

export default function NbPoliciesPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailPolicy, setDetailPolicy] = React.useState(null);

  const load = React.useCallback(() => apiGet('/policies')
    .then((d) => { setRows(d.policies || []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, { searchKeys: ['name', 'sourceName'], defaultSortKey: 'name', defaultSortDir: 'asc', paginate: true });

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={ShieldIcon} title="Policies" description="Backup policies across all registered NetBackup sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={rows == null} />
      </PageHeader>

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', margin: 0 }}>Policies</p>
          <CsvExportButton filename="netbackup-policies" rows={ctl.rows} columns={[
            { label: 'Name', get: 'name' }, { label: 'Source', get: 'sourceName' }, { label: 'Type', get: 'policyType' },
            { label: 'Active', get: (r) => (r.active ? 'Yes' : 'No') }, { label: 'Clients', get: 'clientCount' },
            { label: 'Schedules', get: 'scheduleCount' }, { label: 'Selections', get: 'selectionCount' }, { label: 'Failed (24h)', get: 'failed24h' },
          ]} />
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by policy or source…"
          filters={[{ k: 'policyType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading policies…" height={140} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No policies found — register a NetBackup source under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No policies match your filters.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="policyType" label="Type" ctl={ctl} />
                <SortTh k="active" label="Active" ctl={ctl} />
                <SortTh k="sourceName" label="Source" ctl={ctl} />
                <SortTh k="clientCount" label="Clients" ctl={ctl} align="right" />
                <SortTh k="scheduleCount" label="Schedules" ctl={ctl} align="right" />
                <SortTh k="selectionCount" label="Selections" ctl={ctl} align="right" />
                <SortTh k="failed24h" label="Failed (24h)" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((p) => (
                  <tr key={p.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <button onClick={() => setDetailPolicy(p)} title="View clients, schedules and selections"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--nb-ink)', fontWeight: 500, textAlign: 'left' }}>{p.name}</button>
                    </td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{p.policyType || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge></td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{p.sourceName}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(p.clientCount)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(p.scheduleCount)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(p.selectionCount)}</td>
                    <td style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>
                      {p.failed24h ? <Badge tone="crit">{p.failed24h}</Badge> : <span className="nb-tnum" style={{ color: 'var(--nb-ink-faint)' }}>0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
      {detailPolicy && <PolicyDetailModal policy={detailPolicy} onClose={() => setDetailPolicy(null)} />}
    </div>
  );
}
