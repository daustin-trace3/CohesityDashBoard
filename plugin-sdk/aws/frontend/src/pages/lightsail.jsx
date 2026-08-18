// Ported from frontend/src/pages/aws/AwsLightsailPage.jsx.
import { Boxes } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtNum, dateAgo,
} from '../ui.jsx';

const stateTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'running') return 'ok';
  if (v === 'stopped') return 'neutral';
  return 'warn';
};

export default function AwsLightsailPage() {
  const [instances, setInstances] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aws/lightsail')
    .then((json) => { setInstances(json?.instances || []); setLastRefreshed(new Date()); })
    .catch(() => setInstances([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = instances || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'blueprint', 'bundle', 'az', 'publicIp', 'account'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Boxes} title="Lightsail" description="Lightsail instances across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Instances</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, blueprint, bundle…"
          filters={[{ k: 'state', label: 'States' }, { k: 'bundle', label: 'Bundles' }, { k: 'account', label: 'Accounts' }]} />
        {instances == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Lightsail instances found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No instances match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="blueprint" label="Blueprint" ctl={ctl} />
                <SortTh k="bundle" label="Bundle" ctl={ctl} />
                <SortTh k="az" label="AZ" ctl={ctl} />
                <SortTh k="publicIp" label="Public IP" ctl={ctl} />
                <SortTh k="cpuUtil" label="CPU" ctl={ctl} align="right" />
                <SortTh k="snapshotCount" label="Snapshots" ctl={ctl} align="right" />
                <SortTh k="latestSnapshotAt" label="Latest Snapshot" ctl={ctl} />
                <SortTh k="account" label="Account" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((i) => (
                  <tr key={`${i.account}|${i.name}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{i.name}</td>
                    <td className="py-2 pr-3"><Badge tone={stateTone(i.state)}>{i.state || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{i.blueprint || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{i.bundle || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{i.az || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{i.publicIp || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{i.cpuUtil != null ? `${Number(i.cpuUtil).toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(i.snapshotCount)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{dateAgo(i.latestSnapshotAt)}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{i.account}</td>
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
