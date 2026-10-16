// Rubrik v2.0.0 — Sources page. Mirrors the host SourcesPage.jsx (workload
// tiles that filter a per-object table) using the rbk- kit exclusively.
//
// GAP: the v2 contract's /rubrik/sources route is specified as
// `{ sources[...], environments[...] }` without pinning exact per-object
// field names. This page reads generously-aliased fields (name/objectName,
// workload/environment, type/objectType, source/sourceName, cluster/
// clusterName, slaDomain/sla, lastBackupStatus/runStatus/lastRunStatus,
// logicalBytes/logical) so it renders correctly whichever naming the
// backend WP lands on. Flagging for integration verification.

import {
  injectStyles, PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, CsvExportButton,
  BoxesIcon,
} from '../ui';

injectStyles();

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
}

function runTone(s) {
  if (s === 'Succeeded' || s === 'SucceededWithWarning') return 'ok';
  if (s === 'Failed') return 'crit';
  if (s === 'Running') return 'info';
  return s ? 'warn' : 'neutral';
}

function useRbkFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => { if (!res.ok) throw new Error(`request failed: ${res.status}`); return res.json(); })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [path, nonce]);
  return { data, error, reload };
}

export default function SourcesPage() {
  const { data, error, reload } = useRbkFetch('/sources');
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  React.useEffect(() => { if (data) setLastRefreshed(new Date()); }, [data]);

  const list = (data?.sources || []).map((o, i) => {
    const name = o.name || o.objectName || o.sourceName || `object-${i}`;
    const workload = o.workload || o.environment || '—';
    const isProtected = o.isProtected ?? o.protected ?? (o.protectedCount != null ? o.protectedCount > 0 : null);
    const lastBackup = o.lastBackupStatus || o.runStatus || o.lastRunStatus || null;
    return {
      id: o.id ?? `${name}-${i}`,
      name,
      workload,
      objectType: o.type || o.objectType || o.sourceType || '—',
      source: o.source || o.sourceName || '—',
      isProtected,
      protectedLabel: isProtected == null ? '—' : isProtected ? 'protected' : 'unprotected',
      cluster: o.cluster || o.clusterName || '—',
      slaDomain: o.slaDomain || o.sla || o.policy || '—',
      lastBackup,
      logicalBytes: o.logicalBytes ?? o.logical ?? null,
    };
  });

  const environments = data?.environments || [];

  const ctl = useTableControls(list, {
    searchKeys: ['name', 'source', 'cluster', 'slaDomain'],
    defaultSortKey: 'name',
    paginate: true,
  });

  const workloadFilter = ctl.filters.workload || '';

  const refresh = () => { reload(); };

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={BoxesIcon} title="Sources" description="Every discovered object across the estate — click a workload tile to filter">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <CsvExportButton
          filename="rubrik-sources"
          rows={ctl.rows}
          columns={[
            { label: 'Object', get: 'name' },
            { label: 'Workload', get: 'workload' },
            { label: 'Type', get: 'objectType' },
            { label: 'Source', get: 'source' },
            { label: 'Protected', get: 'protectedLabel' },
            { label: 'Cluster', get: 'cluster' },
            { label: 'SLA Domain', get: 'slaDomain' },
            { label: 'Last Backup', get: 'lastBackup' },
            { label: 'Logical (bytes)', get: 'logicalBytes' },
          ]}
        />
        <RefreshButton onClick={refresh} />
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {environments.map((e) => {
          const active = workloadFilter === e.environment;
          return (
            <button
              key={e.environment}
              onClick={() => ctl.setFilter('workload', active ? '' : e.environment)}
              className="rbk-panel"
              style={{
                padding: '8px 12px', textAlign: 'left', cursor: 'pointer', font: 'inherit',
                borderColor: active ? 'var(--rbk-brand)' : 'var(--rbk-border)',
                background: active ? 'rgba(0,179,136,0.1)' : 'var(--rbk-surface)',
              }}
            >
              <p style={{ fontSize: 12, fontWeight: 700, margin: 0, color: active ? 'var(--rbk-brand)' : 'var(--rbk-ink)' }}>{e.environment}</p>
              <p className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-muted)', margin: 0 }}>
                {e.protected}/{e.total} protected · {fmtBytes(e.logicalBytes)}
              </p>
            </button>
          );
        })}
      </div>

      <Panel>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by object, source, cluster or SLA…"
          filters={[
            { k: 'cluster', label: 'Clusters' },
            { k: 'workload', label: 'Workloads' },
            { k: 'protectedLabel', label: 'Protection' },
          ]} />
        {!data && !error ? (
          <LoadingPanel label="Loading sources…" height={200} />
        ) : error ? (
          <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '24px 0' }}>
            Could not load sources. <button onClick={reload} className="rbk-btn-ghost" style={{ display: 'inline-flex', marginLeft: 6 }}>Retry</button>
          </p>
        ) : list.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '32px 0' }}>No object inventory yet — data appears after the next poll.</p>
        ) : ctl.rows.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '32px 0' }}>No objects match your filters.</p>
        ) : (
          <div className="rbk-scroll" style={{ overflowX: 'auto', maxHeight: 640 }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--rbk-surface)', zIndex: 1 }}>
                <tr>
                  <SortTh k="name" label="Object" ctl={ctl} align="left" />
                  <SortTh k="workload" label="Workload" ctl={ctl} align="left" />
                  <SortTh k="objectType" label="Type" ctl={ctl} align="left" />
                  <SortTh k="source" label="Source" ctl={ctl} align="left" />
                  <SortTh k="protectedLabel" label="Protected" ctl={ctl} align="left" />
                  <SortTh k="cluster" label="Cluster" ctl={ctl} align="left" />
                  <SortTh k="slaDomain" label="SLA Domain" ctl={ctl} align="left" />
                  <SortTh k="lastBackup" label="Last Backup" ctl={ctl} align="left" />
                  <SortTh k="logicalBytes" label="Logical" ctl={ctl} />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((o) => (
                  <tr key={o.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', fontWeight: 500, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.name}>{o.name}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{o.workload}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)', fontSize: 11 }}>{o.objectType}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)', fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.source}>{o.source}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>{o.isProtected == null ? <span style={{ color: 'var(--rbk-ink-faint)', fontSize: 11 }}>—</span> : <Badge tone={o.isProtected ? 'ok' : 'warn'}>{o.protectedLabel}</Badge>}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{o.cluster}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{o.slaDomain}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>{o.lastBackup ? <Badge tone={runTone(o.lastBackup)}>{o.lastBackup}</Badge> : <span style={{ color: 'var(--rbk-ink-faint)', fontSize: 11 }}>—</span>}</td>
                    <td className="rbk-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtBytes(o.logicalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </Panel>
    </div>
  );
}
