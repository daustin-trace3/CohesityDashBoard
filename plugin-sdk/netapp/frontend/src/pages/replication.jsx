// NetApp Replication (SnapMirror) — ported from
// frontend/src/pages/netapp/NetAppReplicationPage.jsx.
import { ArrowLeftRight, ShieldCheck, HeartPulse } from '../icons.jsx';
import { apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtBytes, fmtNum, useTableControls, SortTh, TableControls, TablePager } from '../ui.jsx';

function fmtLag(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export default function ReplicationPage() {
  const [rels, setRels] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/netapp/replication')
    .then((data) => { setRels(data); setLastRefreshed(new Date()); })
    .catch(() => setRels([])), []);

  React.useEffect(() => { load(); }, [load]);

  const healthy = (rels || []).filter((r) => r.healthy).length;
  const unhealthy = (rels || []).length - healthy;
  const maxLag = (rels || []).reduce((m, r) => Math.max(m, r.lag_seconds || 0), 0);

  const list = (rels || []).map((r) => ({ ...r, health_label: r.healthy ? 'healthy' : 'unhealthy' }));
  const ctl = useTableControls(list, { searchKeys: ['source_path', 'destination_path', 'source_cluster', 'destination_cluster', 'state'], defaultSortKey: 'lag_seconds', defaultSortDir: 'desc', paginate: true });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ArrowLeftRight} title="NetApp Replication (SnapMirror)" description="SnapMirror DR relationships, health and lag across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={ShieldCheck} label="Relationships" value={fmtNum((rels || []).length)} tone="brand" />
        <StatCard icon={HeartPulse} label="Healthy" value={healthy} tone="ok" />
        <StatCard icon={HeartPulse} label="Unhealthy" value={unhealthy} tone={unhealthy > 0 ? 'crit' : 'ok'} />
        <StatCard icon={ArrowLeftRight} label="Max Lag" value={fmtLag(maxLag || null)} tone={maxLag > 86400 ? 'warn' : 'default'} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by path, cluster or state…"
          filters={[
            { k: 'source_cluster', label: 'Source Clusters' },
            { k: 'destination_cluster', label: 'Destination Clusters' },
            { k: 'health_label', label: 'Health' },
            { k: 'state', label: 'States' },
          ]} />
        {rels == null ? (
          <LoadingPanel label="Loading relationships…" />
        ) : rels.length === 0 ? (
          <div className="text-sm text-ink-muted p-8 text-center">No SnapMirror relationships found on the registered cluster(s).</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-8 text-center">No relationships match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                  <SortTh k="source_path" label="Source" ctl={ctl} />
                  <SortTh k="destination_path" label="Destination" ctl={ctl} />
                  <SortTh k="state" label="State" ctl={ctl} />
                  <SortTh k="health_label" label="Health" ctl={ctl} />
                  <SortTh k="lag_seconds" label="Lag" ctl={ctl} align="right" />
                  <SortTh k="transfer_state" label="Last Transfer" ctl={ctl} />
                  <SortTh k="last_transfer_bytes" label="Bytes" ctl={ctl} align="right" />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((r) => (
                  <tr key={r.id} className="border-b">
                    <td className="py-2 pr-3 text-ink truncate max-w-[240px]">{r.source_path}{r.source_cluster ? <span className="text-ink-faint"> @{r.source_cluster}</span> : ''}</td>
                    <td className="py-2 pr-3 text-ink-muted truncate max-w-[240px]">{r.destination_path}{r.destination_cluster ? <span className="text-ink-faint"> @{r.destination_cluster}</span> : ''}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.state || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={r.healthy ? 'ok' : 'crit'}>{r.healthy ? 'healthy' : 'unhealthy'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum"><span className={r.lag_seconds > 86400 ? 'text-status-warn' : 'text-ink-muted'}>{fmtLag(r.lag_seconds)}</span></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.transfer_state || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.last_transfer_bytes)}</td>
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
