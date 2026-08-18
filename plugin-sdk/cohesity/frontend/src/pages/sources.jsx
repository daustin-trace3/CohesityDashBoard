// Cohesity plugin — Sources page. Ported from frontend/src/pages/SourcesPage.jsx.
// Per-object inventory table with workload-type filter tiles and CSV export.
import {
  apiFetch, useToast, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, TableControls, SortTh, TablePager,
} from '../ui.jsx';
import { Download } from '../icons.jsx';

// Not in the shared icon kit — added locally (same 24x24 stroke style as icons.jsx).
function Boxes(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M2.97 12.92 12 18l9.03-5.08M2.97 8.08 12 3l9.03 5.08L12 13.16 2.97 8.08Z" />
      <path d="M2.97 8.08v9.79L12 23l9.03-5.13V8.08M12 13.16V23" />
    </svg>
  );
}

const gb = (b) => b == null ? '' : (b / 1024 ** 3).toFixed(2);
const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};
const runTone = (s) => s === 'Succeeded' || s === 'SucceededWithWarning' ? 'ok'
  : s === 'Failed' ? 'crit' : s === 'Running' ? 'info' : s ? 'warn' : 'neutral';

const cellMuted = { padding: '8px 12px 8px 0', color: 'var(--co-ink-muted)' };
const cellSmall = { padding: '8px 12px 8px 0', color: 'var(--co-ink-muted)', fontSize: 11 };

const COLUMNS = [
  { k: 'name', label: 'Object', always: true, csvLabel: 'Object',
    render: (o) => {
      const { Link } = window.ReactRouterDOM;
      return (
        <td key="name" className="truncate" style={{ padding: '8px 12px 8px 0', maxWidth: 220 }} title={o.name || ''}>
          {o.name
            ? <Link to={`/ops/server360?name=${encodeURIComponent(o.name)}`} title="Open Server 360" style={{ color: 'var(--co-ink)', fontWeight: 500, textDecoration: 'none' }}>{o.name}</Link>
            : '—'}
        </td>
      );
    }, csv: (o) => o.name },
  { k: 'environment', label: 'Workload', csvLabel: 'Workload',
    render: (o) => <td key="environment" style={cellMuted}>{o.environment || '—'}</td>, csv: (o) => o.environment },
  { k: 'object_type', label: 'Type', csvLabel: 'Object Type',
    render: (o) => <td key="object_type" style={cellSmall}>{o.object_type || '—'}</td>, csv: (o) => o.object_type },
  { k: 'os_type', label: 'OS', csvLabel: 'OS',
    render: (o) => <td key="os_type" style={cellSmall}>{o.os_type || '—'}</td>, csv: (o) => o.os_type },
  { k: 'source_name', label: 'Source', csvLabel: 'Source',
    render: (o) => <td key="source_name" className="truncate" style={{ ...cellSmall, maxWidth: 180 }} title={o.source_name || ''}>{o.source_name || '—'}</td>, csv: (o) => o.source_name },
  { k: 'protected_label', label: 'Protected', csvLabel: 'Protected',
    render: (o) => <td key="protected_label" style={{ padding: '8px 12px 8px 0' }}><Badge tone={o.is_protected ? 'ok' : 'warn'}>{o.protected_label}</Badge></td>,
    csv: (o) => o.protected_label },
  { k: 'cluster_name', label: 'Cluster', csvLabel: 'Cluster',
    render: (o) => <td key="cluster_name" style={cellMuted}>{o.cluster_name}</td>, csv: (o) => o.cluster_name },
  { k: 'groups_label', label: 'Protection Group', csvLabel: 'Protection Groups',
    render: (o) => <td key="groups_label" className="truncate" style={{ ...cellSmall, maxWidth: 200 }} title={o.groups_label}>{o.groups_label || '—'}</td>,
    csv: (o) => o.groups_label },
  { k: 'policies_label', label: 'Policy', csvLabel: 'Policies',
    render: (o) => <td key="policies_label" className="truncate" style={{ ...cellSmall, maxWidth: 200 }} title={o.policies_label}>{o.policies_label || '—'}</td>,
    csv: (o) => o.policies_label },
  { k: 'last_backup_status', label: 'Last Backup', csvLabel: 'Last Backup',
    render: (o) => <td key="last_backup_status" style={{ padding: '8px 12px 8px 0' }}>{o.last_backup_status ? <Badge tone={runTone(o.last_backup_status)}>{o.last_backup_status}</Badge> : <span style={{ color: 'var(--co-ink-faint)', fontSize: 11 }}>—</span>}</td>,
    csv: (o) => o.last_backup_status },
  { k: 'sla_violated', label: 'SLA', csvLabel: 'SLA Violated',
    render: (o) => <td key="sla_violated" style={cellSmall}>{o.sla_violated == null ? '—' : o.sla_violated ? <span style={{ color: 'var(--co-warn)', fontWeight: 600 }}>violated</span> : 'met'}</td>,
    csv: (o) => o.sla_violated == null ? '' : o.sla_violated ? 'yes' : 'no' },
  { k: 'logical_bytes', label: 'Logical', align: 'right', csvLabel: 'Logical (GB)',
    render: (o) => <td key="logical_bytes" className="tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)' }}>{fmtBytes(o.logical_bytes)}</td>, csv: (o) => gb(o.logical_bytes) },
  { k: 'protection_type', label: 'Protection Type', csvLabel: 'Protection Type',
    render: (o) => <td key="protection_type" style={cellSmall}>{o.protection_type || '—'}</td>, csv: (o) => o.protection_type },
];

const DEFAULT_HIDDEN = ['os_type', 'protection_type', 'policies_label'];
const STORAGE_KEY = 'co-sources-columns';

// Not in the shared kit (ui.jsx has no column-visibility primitive) — small
// page-local hook + popover mirroring the built-in's useVisibleColumns/ColumnPicker.
function useVisibleColumns(storageKey, defaultHidden) {
  const [hidden, setHidden] = React.useState(() => {
    try { const raw = localStorage.getItem(storageKey); return raw ? new Set(JSON.parse(raw)) : new Set(defaultHidden); }
    catch { return new Set(defaultHidden); }
  });
  const persist = (next) => {
    setHidden(next);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
  };
  return {
    show: (k) => !hidden.has(k),
    toggle: (k) => { const next = new Set(hidden); next.has(k) ? next.delete(k) : next.add(k); persist(next); },
  };
}

function ColumnPicker({ columns, prefs }) {
  const [open, setOpen] = React.useState(false);
  const toggleable = columns.filter((c) => !c.always);
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} className="co-btn-ghost">Columns</button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 40, background: 'var(--co-gray)', border: '1px solid var(--co-border)', borderRadius: 8, boxShadow: '0 20px 25px -5px rgba(0,0,0,.4)', padding: 8, minWidth: 180 }}>
            {toggleable.map((c) => (
              <label key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--co-ink-muted)', padding: '4px 6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={prefs.show(c.k)} onChange={() => prefs.toggle(c.k)} className="accent-brand" />
                {c.label}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function SourcesPage() {
  const { toast } = useToast();
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/cohesity/workloads/sources')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => { setData({ objects: [], environments: [] }); toast({ type: 'error', title: 'Failed to load sources' }); }), [toast]);

  React.useEffect(() => { load(); }, [load]);

  const list = (data?.objects || []).map((o) => ({
    ...o,
    protected_label: o.is_protected ? 'protected' : 'unprotected',
    groups_label: (o.protection_groups || []).join(', '),
    policies_label: (o.policy_names || []).join(', '),
  }));

  const cols = useVisibleColumns(STORAGE_KEY, DEFAULT_HIDDEN);
  const visible = COLUMNS.filter((c) => c.always || cols.show(c.k));

  const ctl = useTableControls(list, {
    searchKeys: ['name', 'source_name', 'cluster_name', 'groups_label', 'policies_label', 'object_type'],
    defaultSortKey: 'name',
    paginate: true,
  });

  const envFilter = ctl.filters.environment || '';

  // Export honors the active filters/search (ctl.rows is the filtered set,
  // pre-pagination); with nothing filtered that IS the whole inventory.
  const exportCsv = () => {
    const esc = (val) => {
      const t = val == null ? '' : String(val);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [COLUMNS.map((c) => esc(c.csvLabel)).join(',')];
    for (const o of ctl.rows) lines.push(COLUMNS.map((c) => esc(c.csv(o))).join(','));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cohesity-sources-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Boxes} title="Sources"
        description="Every discovered object across the estate — click a workload tile to filter">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <ColumnPicker columns={COLUMNS} prefs={cols} />
        <button onClick={exportCsv} disabled={!ctl.rows.length} className="co-btn-ghost" style={{ opacity: ctl.rows.length ? 1 : 0.5 }}>
          <Download size={13} /> Export
        </button>
        <RefreshButton onClick={load} />
      </PageHeader>

      {/* Workload-type tiles — click to filter the table */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {(data?.environments || []).map((e) => {
          const active = envFilter === e.environment;
          return (
            <button key={e.environment}
              onClick={() => ctl.setFilter('environment', active ? '' : e.environment)}
              className="panel" style={{ padding: '8px 12px', textAlign: 'left', cursor: 'pointer', border: `1px solid ${active ? 'var(--co-brand)' : 'var(--co-border)'}`, background: active ? 'rgba(108,179,63,0.1)' : undefined }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: active ? 'var(--co-brand)' : 'var(--co-ink)', margin: 0 }}>{e.environment}</p>
              <p className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: 0 }}>
                {e.protected}/{e.total} protected · {fmtBytes(e.logicalBytes)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="panel" style={{ padding: 16 }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by object, source, cluster, group or policy…"
          filters={[
            { k: 'cluster_name', label: 'Clusters' },
            { k: 'environment', label: 'Workloads' },
            { k: 'protected_label', label: 'Protection' },
          ]} />
        {data == null ? (
          <LoadingPanel label="Loading sources…" height={160} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No object inventory yet — data appears after the next poll of each cluster.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No objects match your filters.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--co-border)' }}>
                  {visible.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((o) => (
                  <tr key={o.id} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                    {visible.map((c) => c.render(o))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
