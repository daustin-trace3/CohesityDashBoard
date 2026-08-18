// Ported from frontend/src/pages/aws/AwsEc2Page.jsx.
import { Server, HardDrive } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtNum,
} from '../ui.jsx';

const stateTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'running') return 'ok';
  if (v === 'stopped' || v === 'terminated') return 'neutral';
  if (v.includes('pending') || v.includes('stopping')) return 'warn';
  return 'neutral';
};

const statusTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v.includes('failed')) return 'crit';
  if (v === 'ok') return 'ok';
  return 'neutral';
};

export default function AwsEc2Page() {
  const [instances, setInstances] = React.useState(null);
  const [volumes, setVolumes] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiFetch('/aws/ec2').then((json) => setInstances(json?.instances || [])),
    apiFetch('/aws/ebs').then((json) => setVolumes(json?.volumes || [])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setInstances([]); setVolumes([]); }), []);

  React.useEffect(() => { load(); }, [load]);

  const list = instances || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instanceId', 'instanceType', 'az', 'privateIp', 'publicIp', 'account'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  const volList = volumes || [];
  const volCtl = useTableControls(volList, {
    searchKeys: ['volumeId', 'volumeType', 'az', 'attachedInstanceId', 'account'],
    defaultSortKey: 'volumeId', defaultSortDir: 'asc',
    paginate: true,
  });
  const unattachedCount = volList.filter((v) => v.state === 'available').length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="EC2" description="EC2 instances and EBS volumes across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Instances</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, instance ID, type, AZ…"
          filters={[{ k: 'state', label: 'States' }, { k: 'instanceType', label: 'Types' }, { k: 'account', label: 'Accounts' }]} />
        {instances == null ? (
          <LoadingPanel label="Loading instances…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No EC2 instances found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No instances match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="instanceId" label="Instance ID" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="instanceType" label="Type" ctl={ctl} />
                <SortTh k="az" label="AZ" ctl={ctl} />
                <SortTh k="privateIp" label="Private IP" ctl={ctl} />
                <SortTh k="publicIp" label="Public IP" ctl={ctl} />
                <SortTh k="cpuUtil" label="CPU" ctl={ctl} align="right" />
                <SortTh k="statusCheck" label="Status Check" ctl={ctl} />
                <SortTh k="account" label="Account" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((i) => (
                  <tr key={i.id ?? i.instanceId} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{i.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{i.instanceId}</td>
                    <td className="py-2 pr-3"><Badge tone={stateTone(i.state)}>{i.state || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{i.instanceType || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{i.az || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{i.privateIp || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{i.publicIp || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{i.cpuUtil != null ? `${Number(i.cpuUtil).toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(i.statusCheck)}>{i.statusCheck || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{i.account}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink flex items-center gap-2"><HardDrive size={15} className="text-brand" /> EBS Volumes</p>
          {unattachedCount > 0 && <Badge tone="warn">{fmtNum(unattachedCount)} unattached</Badge>}
        </div>
        <TableControls ctl={volCtl} rows={volList} searchPlaceholder="Filter by volume ID, type, AZ or account…"
          filters={[{ k: 'state', label: 'States' }, { k: 'volumeType', label: 'Types' }, { k: 'account', label: 'Accounts' }]} />
        {volumes == null ? (
          <LoadingPanel label="Loading volumes…" height={140} />
        ) : volList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No EBS volumes found.</div>
        ) : volCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No volumes match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="volumeId" label="Volume ID" ctl={volCtl} />
                <SortTh k="state" label="State" ctl={volCtl} />
                <SortTh k="volumeType" label="Type" ctl={volCtl} />
                <SortTh k="sizeGb" label="Size (GB)" ctl={volCtl} align="right" />
                <SortTh k="az" label="AZ" ctl={volCtl} />
                <SortTh k="attachedInstanceId" label="Attached Instance" ctl={volCtl} />
                <SortTh k="account" label="Account" ctl={volCtl} />
              </tr></thead>
              <tbody>
                {volCtl.pageRows.map((v) => (
                  <tr key={v.volumeId} className={`border-b border-cohesity-border/50 ${v.state === 'available' ? 'bg-status-warn/5' : ''}`}>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.volumeId}</td>
                    <td className="py-2 pr-3"><Badge tone={v.state === 'available' ? 'warn' : v.state === 'in-use' ? 'ok' : 'neutral'}>{v.state || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{v.volumeType || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.sizeGb)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{v.az || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.attachedInstanceId || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.account}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={volCtl} />
      </div>
    </div>
  );
}
