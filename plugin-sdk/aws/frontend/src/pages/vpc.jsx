// Ported from frontend/src/pages/aws/AwsVpcPage.jsx.
import { Network } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtNum,
} from '../ui.jsx';

export default function AwsVpcPage() {
  const [vpcs, setVpcs] = React.useState(null);
  const [subnets, setSubnets] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aws/vpc')
    .then((json) => { setVpcs(json?.vpcs || []); setSubnets(json?.subnets || []); setLastRefreshed(new Date()); setError(null); })
    .catch(() => { setVpcs([]); setSubnets([]); setError('Failed to load VPC data'); }), []);

  React.useEffect(() => { load(); }, [load]);

  const vpcList = vpcs || [];
  const vpcCtl = useTableControls(vpcList, {
    searchKeys: ['vpcId', 'name', 'cidr', 'account'],
    defaultSortKey: 'vpcId', defaultSortDir: 'asc',
    paginate: true,
  });

  const subnetList = subnets || [];
  const subnetCtl = useTableControls(subnetList, {
    searchKeys: ['subnetId', 'vpcId', 'name', 'cidr', 'az', 'account'],
    defaultSortKey: 'subnetId', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="VPC" description="VPCs and subnets across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {error && <div className="panel p-3 mb-4 border border-status-crit/50"><p className="text-sm text-status-crit">{error}</p></div>}

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">VPCs</p>
        <TableControls ctl={vpcCtl} rows={vpcList} searchPlaceholder="Filter by VPC ID, name, CIDR or account…"
          filters={[{ k: 'state', label: 'States' }, { k: 'account', label: 'Accounts' }]} />
        {vpcs == null ? (
          <LoadingPanel label="Loading VPCs…" height={140} />
        ) : vpcList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VPCs found.</div>
        ) : vpcCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VPCs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="vpcId" label="VPC ID" ctl={vpcCtl} />
                <SortTh k="name" label="Name" ctl={vpcCtl} />
                <SortTh k="cidr" label="CIDR" ctl={vpcCtl} />
                <SortTh k="state" label="State" ctl={vpcCtl} />
                <SortTh k="isDefault" label="Default" ctl={vpcCtl} />
                <SortTh k="subnetCount" label="Subnets" ctl={vpcCtl} align="right" />
                <SortTh k="natGatewayCount" label="NAT GWs" ctl={vpcCtl} align="right" />
                <SortTh k="securityGroupCount" label="Security Groups" ctl={vpcCtl} align="right" />
                <SortTh k="igw" label="IGW" ctl={vpcCtl} />
                <SortTh k="account" label="Account" ctl={vpcCtl} />
              </tr></thead>
              <tbody>
                {vpcCtl.pageRows.map((v) => (
                  <tr key={`${v.account}|${v.vpcId}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.vpcId}</td>
                    <td className="py-2 pr-3 text-ink">{v.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.cidr || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={v.state === 'available' ? 'ok' : 'neutral'}>{v.state || '—'}</Badge></td>
                    <td className="py-2 pr-3">{v.isDefault ? <Badge tone="brand">Default</Badge> : <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.subnetCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.natGatewayCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.securityGroupCount)}</td>
                    <td className="py-2 pr-3">{v.igw ? <Badge tone="ok">Yes</Badge> : <Badge tone="neutral">No</Badge>}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.account}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={vpcCtl} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Subnets</p>
        <TableControls ctl={subnetCtl} rows={subnetList} searchPlaceholder="Filter by subnet ID, VPC, name, CIDR, AZ or account…"
          filters={[{ k: 'az', label: 'AZs' }, { k: 'account', label: 'Accounts' }]} />
        {subnets == null ? (
          <LoadingPanel label="Loading subnets…" height={140} />
        ) : subnetList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No subnets found.</div>
        ) : subnetCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No subnets match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="subnetId" label="Subnet ID" ctl={subnetCtl} />
                <SortTh k="vpcId" label="VPC ID" ctl={subnetCtl} />
                <SortTh k="name" label="Name" ctl={subnetCtl} />
                <SortTh k="cidr" label="CIDR" ctl={subnetCtl} />
                <SortTh k="az" label="AZ" ctl={subnetCtl} />
                <SortTh k="availableIps" label="Available IPs" ctl={subnetCtl} align="right" />
                <SortTh k="public" label="Public" ctl={subnetCtl} />
                <SortTh k="account" label="Account" ctl={subnetCtl} />
              </tr></thead>
              <tbody>
                {subnetCtl.pageRows.map((s) => (
                  <tr key={`${s.account}|${s.subnetId}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{s.subnetId}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{s.vpcId}</td>
                    <td className="py-2 pr-3 text-ink">{s.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{s.cidr || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{s.az || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(s.availableIps)}</td>
                    <td className="py-2 pr-3">{s.public ? <Badge tone="warn">Public</Badge> : <Badge tone="neutral">Private</Badge>}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{s.account}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={subnetCtl} />
      </div>
    </div>
  );
}
