// Cohesity plugin — Governance page. Ported from frontend/src/pages/GovernancePage.jsx.
// client (axios) -> apiFetch; components/ui/primitives -> ui.jsx; tableTools ->
// ui.jsx's useTableControls/SortTh/TableControls/TablePager; useToast -> ui.jsx's
// local toast store. GET /api/cohesity/governance is unchanged (backend/app.js
// mounts backend/routes/governance.js there) — computed entirely from locally
// stored snapshots, no live cluster call, so there's no refresh-vs-poll split.
import {
  apiFetch, downloadBlob, fmtBytes, useToast,
  PageHeader, Panel, Badge, StatCard, LoadingPanel, LastUpdated, RefreshButton, EmptyState,
  useTableControls, SortTh, TableControls, TablePager,
} from '../ui.jsx';
import { ClipboardCheck, Lock, Download, ArrowLeftRight as GitCompareArrows } from '../icons.jsx';

/* ── Icons not in the shared set — page-local per the plugin-kit-gap
 * convention (icons.jsx is shared vocabulary; do not add one-off glyphs
 * there). Shapes approximate the lucide-react icons the source page used. ── */
function LocalIcon({ children, size = 16, className = '', ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      {children}
    </svg>
  );
}
const FileCheck = (p) => <LocalIcon {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="m9 15 2 2 4-4" /></LocalIcon>;
const FolderOpen = (p) => <LocalIcon {...p}><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></LocalIcon>;
const Layers = (p) => <LocalIcon {...p}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></LocalIcon>;
const Cpu = (p) => <LocalIcon {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></LocalIcon>;
const ShieldOff = (p) => <LocalIcon {...p}><path d="M19.7 14a6.9 6.9 0 0 0 .3-2V5l-8-3-3.16 1.18" /><path d="M4.73 4.73 4 5v7c0 6 8 10 8 10a20.3 20.3 0 0 0 5.62-4.38" /><path d="M1 1l22 22" /></LocalIcon>;
const CloudOff = (p) => <LocalIcon {...p}><path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6" /><path d="M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3" /><path d="M1 1l22 22" /></LocalIcon>;

/* ── CsvExportButton — the Cohesity kit's ui.jsx never got one (other packs'
 * kits, e.g. netapp/aws/aria, have it). Page-local per the same convention. ── */
function CsvExportButton({ filename, columns, rows }) {
  const esc = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const onClick = () => {
    const lines = [columns.map((c) => esc(c.label)).join(',')];
    for (const r of rows || []) lines.push(columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.get])).join(','));
    downloadBlob(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${filename}-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  return (
    <button onClick={onClick} disabled={!rows?.length} className="co-btn-ghost" style={{ opacity: rows?.length ? 1 : 0.5 }}>
      <Download size={12} /> Export CSV
    </button>
  );
}

function fmtRetention(days) {
  if (days == null) return '—';
  if (days % 365 === 0 && days >= 365) return `${days / 365}y`;
  if (days % 30 === 0 && days >= 30) return `${days / 30}mo`;
  if (days % 7 === 0 && days >= 7) return `${days / 7}w`;
  return `${days}d`;
}

const targetChip = { display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 4, background: 'var(--co-surface-overlay)', border: '1px solid var(--co-border)', fontSize: 11, color: 'var(--co-ink)', whiteSpace: 'nowrap' };
const navBtn = 'co-btn-ghost';

const GOV_TABS = [
  { key: 'policies', label: 'Policy Audit', icon: FileCheck },
  { key: 'views', label: 'Views Audit', icon: FolderOpen },
  { key: 'drift', label: 'Retention Drift', icon: GitCompareArrows },
  { key: 'versions', label: 'Software Versions', icon: Layers },
  { key: 'agents', label: 'Agent Versions', icon: Cpu },
  { key: 'sources', label: 'Source Coverage', icon: ShieldOff },
];

/* ── Agent Versions tab ─────────────────────────────────────────────────── */
function AgentsPanel({ audit }) {
  const rows = (audit.agents || []).map((a, i) => ({
    ...a,
    id: `${a.clusterName}-${a.sourceId}-${i}`,
    versionShort: a.agentVersion ? String(a.agentVersion).split('_release')[0] : null,
    currentSort: a.isCurrent ? 1 : 0,
    os: a.osName || a.hostType || null,
  }));
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'clusterName', 'os', 'versionShort'],
    defaultSortKey: 'currentSort', defaultSortDir: 'asc', // outdated first
    paginate: true,
  });

  return (
    <Panel title="Cohesity Agent Versions" icon={Cpu}>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--co-ink-faint)', padding: '16px 0', textAlign: 'center' }}>No agent data collected yet — agents appear after the next poll of clusters with registered physical sources.</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: 0 }}>
              Current version: <span className="tnum" style={{ color: 'var(--co-ink)', fontWeight: 600 }}>{String(audit.latestVersion || '—').split('_release')[0]}</span>
              {' '}· {audit.total - audit.outdated}/{audit.total} agents current
              {audit.outdated > 0 && <span style={{ color: 'var(--co-warn)', fontWeight: 600 }}> · {audit.outdated} need updating</span>}
            </p>
            <CsvExportButton filename="cohesity-agent-versions" rows={ctl.rows} columns={[
              { label: 'Object', get: 'name' }, { label: 'Cluster', get: 'clusterName' },
              { label: 'OS', get: 'os' }, { label: 'Agent Version', get: 'versionShort' },
              { label: 'Full Version', get: 'agentVersion' },
              { label: 'Current', get: (a) => (a.isCurrent ? 'yes' : 'no') },
              { label: 'Health', get: 'agentStatus' }, { label: 'Cluster Verdict', get: 'upgradability' },
            ]} />
          </div>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by object, cluster, OS or version…"
            filters={[{ k: 'clusterName', label: 'Clusters' }, { k: 'versionShort', label: 'Versions' }]} />
          {ctl.rows.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--co-ink-faint)', padding: '16px 0', textAlign: 'center' }}>No agents match your filters.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead><tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)' }}>
                  <SortTh k="name" label="Object" ctl={ctl} />
                  <SortTh k="clusterName" label="Cluster" ctl={ctl} />
                  <SortTh k="os" label="OS" ctl={ctl} />
                  <SortTh k="currentSort" label="Agent Version" ctl={ctl} />
                  <SortTh k="agentStatus" label="Health" ctl={ctl} />
                  <SortTh k="upgradability" label="Cluster Verdict" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((a) => (
                    <tr key={a.id} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                      <td className="truncate" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500, maxWidth: 220 }} title={a.name}>{a.name || '—'}</td>
                      <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{a.clusterName}</td>
                      <td className="truncate" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)', maxWidth: 180 }} title={a.os || ''}>{a.os || '—'}</td>
                      <td style={{ padding: '8px 16px 8px 0' }}>
                        <Badge tone={a.isCurrent ? 'ok' : 'warn'} className="tnum">
                          {a.versionShort || 'unknown'}{!a.isCurrent && a.versionShort ? ' — update' : ''}
                        </Badge>
                      </td>
                      <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{a.agentStatus || '—'}</td>
                      <td style={{ padding: '8px 0', color: 'var(--co-ink-muted)' }}>
                        {a.upgradability === 'Upgradable' ? <span style={{ color: 'var(--co-warn)' }}>upgradable</span>
                          : a.upgradability === 'Current' ? <span style={{ color: 'var(--co-ok)' }}>current</span>
                          : (a.upgradability || '—').toLowerCase()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} />
        </>
      )}
    </Panel>
  );
}

/* ── Views Audit tab ────────────────────────────────────────────────────── */
const AUDIT_FILTERS = [
  { key: 'all', label: 'All flagged' },
  { key: 'noBackup', label: 'No Backup' },
  { key: 'noReplication', label: 'No Replication' },
  { key: 'noDatalock', label: 'No DataLock' },
];
const VIEWS_PAGE_SIZE = 25;

function ViewsAuditPanel({ audit }) {
  const [filter, setFilter] = React.useState('all');
  const [page, setPage] = React.useState(0);
  React.useEffect(() => { setPage(0); }, [filter]);

  if (!audit) return null;
  const flagged = audit.views || [];
  const counts = { all: flagged.length, noBackup: audit.noBackupCount, noReplication: audit.noReplicationCount, noDatalock: audit.noDatalockCount };
  const visible = filter === 'all' ? flagged : flagged.filter((v) => v[filter]);

  const totalPages = Math.max(1, Math.ceil(visible.length / VIEWS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = visible.slice(safePage * VIEWS_PAGE_SIZE, (safePage + 1) * VIEWS_PAGE_SIZE);

  const exportCsv = () => {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['View', 'Cluster', 'Category', 'Protocols', 'Backup', 'Replication', 'DataLock', 'Consumed (TB)', 'Created'].join(','),
      ...visible.map((v) => [
        esc(v.name), esc(v.systemName), esc(v.category || ''), esc(v.protocols || ''),
        v.noBackup ? 'MISSING' : 'Yes',
        v.noReplication ? 'MISSING' : 'Yes',
        v.noDatalock ? 'MISSING' : v.datalockMode,
        ((v.consumedBytes || 0) / 1e12).toFixed(3),
        v.createdMs ? new Date(v.createdMs).toISOString().slice(0, 10) : '',
      ].join(',')),
    ];
    downloadBlob(new Blob([rows.join('\n')], { type: 'text/csv' }), `views-audit-${filter}-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const statusCell = (missing, okLabel) => (missing ? <Badge tone="crit">Missing</Badge> : <Badge tone="ok">{okLabel}</Badge>);

  return (
    <Panel
      title={`Views Audit (${flagged.length} of ${audit.totalWritable} writable views flagged)`}
      icon={FolderOpen}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {AUDIT_FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: `1px solid ${filter === f.key ? 'var(--co-brand)' : 'var(--co-border)'}`, background: filter === f.key ? 'var(--co-brand)' : 'transparent', color: filter === f.key ? '#0B1015' : 'var(--co-ink-muted)', fontWeight: filter === f.key ? 600 : 400, cursor: 'pointer' }}>
              {f.label} ({counts[f.key]})
            </button>
          ))}
          <button onClick={exportCsv} disabled={visible.length === 0} className="co-btn-ghost" style={{ opacity: visible.length ? 1 : 0.5 }}>
            <Download size={12} /> Export CSV
          </button>
        </div>
      }
    >
      {audit.totalWritable === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', padding: '16px 0', textAlign: 'center' }}>No view inventory collected yet — views are polled hourly (see the Views page).</p>
      ) : flagged.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--co-ok)', padding: '16px 0', textAlign: 'center' }}>All writable views have backup, replication, and DataLock configured.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead><tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--co-border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>View</th>
              <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Cluster</th>
              <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Category</th>
              <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Backup</th>
              <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Replication</th>
              <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>DataLock</th>
              <th style={{ textAlign: 'right', padding: '8px 16px 8px 0' }}>Consumed</th>
              <th style={{ textAlign: 'right', padding: '8px 0' }}>Created</th>
            </tr></thead>
            <tbody>
              {pageRows.map((v, i) => (
                <tr key={`${v.systemId}-${v.name}-${i}`} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                  <td className="truncate" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500, maxWidth: 220 }} title={v.name}>{v.name}</td>
                  <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{v.systemName || v.systemId}</td>
                  <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{v.category || '—'}</td>
                  <td style={{ padding: '8px 16px 8px 0' }}>{statusCell(v.noBackup, 'Yes')}</td>
                  <td style={{ padding: '8px 16px 8px 0' }}>{statusCell(v.noReplication, 'Yes')}</td>
                  <td style={{ padding: '8px 16px 8px 0' }}>
                    {v.noDatalock ? <Badge tone="crit">Missing</Badge> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--co-brand)' }}><Lock size={12} />{v.datalockMode}</span>}
                  </td>
                  <td className="tnum" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)', textAlign: 'right' }}>{fmtBytes(v.consumedBytes)}</td>
                  <td className="tnum" style={{ padding: '8px 0', color: 'var(--co-ink-muted)', textAlign: 'right' }}>{v.createdMs ? new Date(v.createdMs).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
            <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: 0 }}>Writable views only — read-only replicas are governed at their source cluster.</p>
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button onClick={() => setPage(0)} disabled={safePage === 0} aria-label="First page" className={navBtn}>«</button>
                <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0} aria-label="Previous page" className={navBtn}>‹</button>
                <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', padding: '0 4px' }}>{safePage + 1} / {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1} aria-label="Next page" className={navBtn}>›</button>
                <button onClick={() => setPage(totalPages - 1)} disabled={safePage >= totalPages - 1} aria-label="Last page" className={navBtn}>»</button>
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */
export default function GovernancePage() {
  const { toast } = useToast();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [tab, setTab] = React.useState('policies');
  const [policyFilter, setPolicyFilter] = React.useState('all'); // all | flagged
  const [policyPage, setPolicyPage] = React.useState(0);
  const [policyPageSize, setPolicyPageSize] = React.useState(25); // number | 'all'

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setData(await apiFetch('/cohesity/governance'));
      setLastRefreshed(new Date());
    } catch (err) {
      setError(true);
      toast({ type: 'error', title: 'Governance fetch failed', message: err?.message || 'Could not load governance data' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { setPolicyPage(0); }, [policyFilter, policyPageSize]);

  const summary = data?.summary;
  const policies = data?.policies || [];
  const retentionDrift = data?.retentionDrift || [];
  const sources = data?.sources || [];
  const versions = data?.versions || [];
  const agentsAudit = data?.agentsAudit || { agents: [], latestVersion: null, total: 0, outdated: 0 };

  const driftNames = new Set(retentionDrift.map((d) => d.name));
  const visiblePolicies = policyFilter === 'flagged' ? policies.filter((p) => p.noOffsiteCopy || driftNames.has(p.name)) : policies;

  const policyTotal = visiblePolicies.length;
  const policySizeNum = policyPageSize === 'all' ? (policyTotal || 1) : policyPageSize;
  const policyTotalPages = Math.max(1, Math.ceil(policyTotal / policySizeNum));
  const policySafePage = Math.min(policyPage, policyTotalPages - 1);
  const policyPageRows = policyPageSize === 'all' ? visiblePolicies : visiblePolicies.slice(policySafePage * policySizeNum, (policySafePage + 1) * policySizeNum);

  const hasAnyData = policies.length > 0 || sources.length > 0;

  const tabBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, background: 'var(--co-surface)', border: '1px solid var(--co-border)', padding: 4, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
      {GOV_TABS.map((t) => {
        const Icon = t.icon;
        const active = tab === t.key;
        return (
          <button key={t.key} onClick={() => setTab(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer', background: active ? 'var(--co-surface-overlay)' : 'transparent', color: active ? 'var(--co-ink)' : 'var(--co-ink-muted)' }}>
            <Icon size={13} style={active ? { color: 'var(--co-brand)' } : undefined} /> {t.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={ClipboardCheck} title="Governance & Audit" description="Policy compliance, unprotected sources, views audit, and software version drift across the estate">
        <RefreshButton onClick={load} refreshing={loading} label="Refresh" />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
      </PageHeader>

      {loading && !data ? (
        <div className="panel" style={{ padding: 16 }}><LoadingPanel label="Loading governance data…" height={320} /></div>
      ) : error ? (
        <div className="panel" style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--co-ink-muted)' }}>
          Could not load governance data. <button onClick={load} style={{ color: 'var(--co-brand)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
        </div>
      ) : !hasAnyData ? (
        <div className="panel" style={{ padding: 0 }}>
          <EmptyState icon={<ClipboardCheck size={48} />} title="No governance data collected yet"
            message="Policies and source registrations are collected during each poll cycle. Trigger a poll from the Dashboard or wait for the next scheduled run, then refresh this page." />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 12 }}>
            <StatCard icon={FileCheck} label="Protection Policies" value={summary.policyCount} sub={`${summary.retentionDriftCount} with retention drift`} tone="brand" onClick={() => setTab('policies')} />
            <StatCard icon={CloudOff} label="No Off-site Copy" value={summary.noOffsiteCopyCount} sub={summary.noOffsiteCopyCount > 0 ? '3-2-1 rule violations' : 'All policies compliant'} tone={summary.noOffsiteCopyCount > 0 ? 'warn' : 'ok'} onClick={() => setTab('policies')} />
            <StatCard icon={ShieldOff} label="Unprotected Objects" value={summary.totalUnprotected} sub={`${summary.totalProtected} protected`} tone={summary.totalUnprotected > 0 ? 'warn' : 'ok'} onClick={() => setTab('sources')} />
            <StatCard icon={Layers} label="Software Versions" value={summary.versionSpread} sub={summary.dominantVersion ? `Dominant: ${String(summary.dominantVersion).split('_')[0]}` : 'No version data'} tone={summary.versionSpread > 1 ? 'info' : 'ok'} onClick={() => setTab('versions')} />
          </div>

          {tabBar}

          {tab === 'policies' && (
            <Panel
              title="Policy Audit"
              icon={FileCheck}
              actions={
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {['all', 'flagged'].map((f) => (
                    <button key={f} onClick={() => setPolicyFilter(f)}
                      style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, textTransform: 'capitalize', border: `1px solid ${policyFilter === f ? 'var(--co-brand)' : 'var(--co-border)'}`, background: policyFilter === f ? 'var(--co-brand)' : 'transparent', color: policyFilter === f ? '#0B1015' : 'var(--co-ink-muted)', fontWeight: policyFilter === f ? 600 : 400, cursor: 'pointer' }}>
                      {f === 'flagged' ? `Flagged (${policies.filter((p) => p.noOffsiteCopy || driftNames.has(p.name)).length})` : 'All'}
                    </button>
                  ))}
                </div>
              }
            >
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead><tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--co-border)' }}>
                    <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Policy</th>
                    <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Cluster</th>
                    <th style={{ textAlign: 'right', padding: '8px 16px 8px 0' }}>Retention</th>
                    <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Replication</th>
                    <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Archival</th>
                    <th style={{ textAlign: 'center', padding: '8px 16px 8px 0' }}>DataLock</th>
                    <th style={{ textAlign: 'left', padding: '8px 0' }}>Flags</th>
                  </tr></thead>
                  <tbody>
                    {policyPageRows.map((p, i) => (
                      <tr key={`${p.clusterId}-${p.policyId}-${i}`} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                        <td className="truncate" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500, maxWidth: 220 }} title={p.name}>{p.name || '—'}</td>
                        <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{p.clusterName}</td>
                        <td className="tnum" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)', textAlign: 'right' }}>{fmtRetention(p.retentionDays)}</td>
                        <td style={{ padding: '8px 16px 8px 0' }}>
                          {p.replicationTargets.length > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', maxWidth: 240 }}>
                              {[...new Set(p.replicationTargets)].map((t) => <span key={t} style={targetChip}>{t}</span>)}
                            </div>
                          ) : <span style={{ color: 'var(--co-ink-faint)' }}>None</span>}
                        </td>
                        <td style={{ padding: '8px 16px 8px 0' }}>
                          {p.archivalTargets.length > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', maxWidth: 240 }}>
                              {[...new Set(p.archivalTargets)].map((t) => <span key={t} style={targetChip}>{t}</span>)}
                            </div>
                          ) : <span style={{ color: 'var(--co-ink-faint)' }}>None</span>}
                        </td>
                        <td style={{ padding: '8px 16px 8px 0', textAlign: 'center' }}>
                          {p.dataLock ? <Lock size={13} style={{ color: 'var(--co-ok)' }} aria-label="DataLock enabled" /> : <span style={{ color: 'var(--co-ink-faint)' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 0' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {p.noOffsiteCopy && <Badge tone="warn">No off-site copy</Badge>}
                            {driftNames.has(p.name) && <Badge tone="info">Retention drift</Badge>}
                            {!p.noOffsiteCopy && !driftNames.has(p.name) && <span style={{ color: 'var(--co-ink-faint)' }}>—</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {policyTotal === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--co-ink-faint)' }}>No policies {policyFilter === 'flagged' ? 'flagged' : 'collected'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {policyTotal > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, marginTop: 8, borderTop: '1px solid var(--co-border)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--co-ink-faint)' }}>
                    Rows per page:
                    <select value={String(policyPageSize)} onChange={(e) => setPolicyPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="co-input" style={{ width: 'auto', padding: '4px 8px', cursor: 'pointer' }}>
                      {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                      <option value="all">All</option>
                    </select>
                  </label>
                  {policyPageSize === 'all' ? (
                    <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>All {policyTotal}</span>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{policySafePage * policySizeNum + 1}–{Math.min((policySafePage + 1) * policySizeNum, policyTotal)} of {policyTotal}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button onClick={() => setPolicyPage(0)} disabled={policySafePage === 0} aria-label="First page" className={navBtn}>«</button>
                        <button onClick={() => setPolicyPage((p) => Math.max(0, p - 1))} disabled={policySafePage === 0} aria-label="Previous page" className={navBtn}>‹</button>
                        <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', padding: '0 4px' }}>{policySafePage + 1} / {policyTotalPages}</span>
                        <button onClick={() => setPolicyPage((p) => Math.min(policyTotalPages - 1, p + 1))} disabled={policySafePage >= policyTotalPages - 1} aria-label="Next page" className={navBtn}>›</button>
                        <button onClick={() => setPolicyPage(policyTotalPages - 1)} disabled={policySafePage >= policyTotalPages - 1} aria-label="Last page" className={navBtn}>»</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          )}

          {tab === 'views' && <ViewsAuditPanel audit={data?.viewsAudit} />}

          {tab === 'drift' && (
            <Panel title="Retention Drift" icon={GitCompareArrows}>
              {retentionDrift.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--co-ok)', padding: '16px 0', textAlign: 'center' }}>No retention drift detected — same-named policies agree across clusters.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {retentionDrift.map((d) => (
                    <div key={d.name} style={{ borderRadius: 8, border: '1px solid var(--co-border)', background: 'rgba(30,42,54,0.4)', padding: '10px 14px' }}>
                      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 6px' }}>{d.name}</p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {d.variants.map((v, i) => <Badge key={i} tone="neutral" className="tnum">{v.clusterName}: {fmtRetention(v.retentionDays)}</Badge>)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {tab === 'versions' && (
            <Panel title="Software Versions" icon={Layers}>
              {versions.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--co-ink-faint)', padding: '16px 0', textAlign: 'center' }}>No version data collected yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {versions.map((v) => (
                    <div key={v.clusterId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid rgba(31,43,55,.6)', padding: '6px 0' }}>
                      <span className="truncate" style={{ fontSize: 12, color: 'var(--co-ink)' }}>{v.clusterName}</span>
                      {v.softwareVersion ? (
                        <Badge tone={v.isOutlier ? 'warn' : 'ok'} className="tnum">{String(v.softwareVersion).split('_')[0]}{v.isOutlier && ' (outlier)'}</Badge>
                      ) : <Badge tone="neutral">unknown</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {tab === 'agents' && <AgentsPanel audit={agentsAudit} />}

          {tab === 'sources' && (
            <Panel title="Source Protection Coverage" icon={ShieldOff}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead><tr style={{ fontSize: 11, color: 'var(--co-ink-faint)', textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--co-border)' }}>
                    <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Source</th>
                    <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Cluster</th>
                    <th style={{ textAlign: 'left', padding: '8px 16px 8px 0' }}>Environment</th>
                    <th style={{ textAlign: 'right', padding: '8px 16px 8px 0' }}>Protected</th>
                    <th style={{ textAlign: 'right', padding: '8px 16px 8px 0' }}>Unprotected</th>
                    <th style={{ textAlign: 'right', padding: '8px 16px 8px 0' }}>Unprotected Size</th>
                    <th style={{ textAlign: 'left', padding: '8px 0', width: 140 }}>Coverage</th>
                  </tr></thead>
                  <tbody>
                    {sources.map((s, i) => {
                      const total = (s.protectedCount || 0) + (s.unprotectedCount || 0);
                      const pct = total > 0 ? ((s.protectedCount || 0) / total) * 100 : null;
                      const barColor = pct == null ? 'var(--co-border)' : pct >= 95 ? 'var(--co-ok)' : pct >= 75 ? 'var(--co-warn)' : 'var(--co-crit)';
                      return (
                        <tr key={`${s.clusterId}-${s.sourceId}-${i}`} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                          <td className="truncate" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink)', fontWeight: 500, maxWidth: 220 }} title={s.sourceName}>{s.sourceName || '—'}</td>
                          <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{s.clusterName}</td>
                          <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{s.environment || '—'}</td>
                          <td className="tnum" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)', textAlign: 'right' }}>{s.protectedCount ?? '—'}</td>
                          <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', fontWeight: 600, color: (s.unprotectedCount || 0) > 0 ? 'var(--co-warn)' : 'var(--co-ok)' }}>{s.unprotectedCount ?? '—'}</td>
                          <td className="tnum" style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)', textAlign: 'right' }}>{fmtBytes(s.unprotectedBytes)}</td>
                          <td style={{ padding: '8px 0' }}>
                            {pct != null ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, height: 6, background: 'var(--co-surface-base)', borderRadius: 999, overflow: 'hidden' }}>
                                  <div style={{ height: '100%', borderRadius: 999, width: `${pct}%`, background: barColor }} />
                                </div>
                                <span className="tnum" style={{ fontSize: 10, color: 'var(--co-ink-muted)', width: 36, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                              </div>
                            ) : <span style={{ color: 'var(--co-ink-faint)' }}>—</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {sources.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--co-ink-faint)' }}>No source registration data collected yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
