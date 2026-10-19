import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, Database, HardDrive, Archive, Network, Globe } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, dateAgo } from './helpers';

const OK_STATES = new Set(['running', 'available', 'active', 'ok', 'deployed', 'attached', 'in-use', 'enabled', 'backing-up', 'modifying']);
const stateTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (OK_STATES.has(v)) return 'ok';
  if (v === 'stopped' || v === 'detached' || v === 'suspended') return 'neutral';
  return 'warn';
};

const dash = (v) => (v == null || v === '' ? '-' : v);
const yesNo = (v, goodWhenTrue = true) => (
  <Badge tone={v ? (goodWhenTrue ? 'ok' : 'warn') : (goodWhenTrue ? 'warn' : 'ok')}>{v ? 'Yes' : 'No'}</Badge>
);
const ramText = (v) => (v == null ? '-' : `${v} GB`);
const stateCell = (r) => <Badge tone={stateTone(r.state)}>{r.state || '-'}</Badge>;
const mutedCell = (key) => (r) => <span className="text-ink-muted">{dash(r[key])}</span>;
const acctCell = (r) => <span className="text-ink-muted whitespace-nowrap">{r.account}</span>;

// Column spec: k = sort key, label, render(row), optional align / className.
const TABS = [
  {
    id: 'instances', label: 'Instances', countKey: 'instances', url: '/aws/lightsail', dataKey: 'instances',
    searchKeys: ['name', 'blueprint', 'bundle', 'az', 'publicIp', 'account'],
    filters: [{ k: 'state', label: 'States' }, { k: 'bundle', label: 'Bundles' }, { k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail instances found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'state', label: 'State', render: stateCell },
      { k: 'blueprint', label: 'Blueprint', render: mutedCell('blueprint') },
      { k: 'bundle', label: 'Bundle', render: mutedCell('bundle') },
      { k: 'ramGb', label: 'RAM', align: 'right', render: (r) => <span className="text-ink-muted tnum">{ramText(r.ramGb)}</span> },
      { k: 'isWindows', label: 'Windows', render: (r) => (r.isWindows ? <Badge tone="info">Windows</Badge> : <span className="text-ink-faint">-</span>) },
      { k: 'az', label: 'AZ', render: (r) => <span className="text-ink-muted text-[11px]">{dash(r.az)}</span> },
      { k: 'publicIp', label: 'Public IP', render: (r) => <span className="text-ink-muted tnum text-[11px]">{dash(r.publicIp)}</span> },
      { k: 'cpuUtil', label: 'CPU', align: 'right', render: (r) => <span className="text-ink-muted tnum">{r.cpuUtil != null ? `${Number(r.cpuUtil).toFixed(0)}%` : '-'}</span> },
      { k: 'snapshotCount', label: 'Snapshots', align: 'right', render: (r) => <span className="text-ink-muted tnum">{fmtNum(r.snapshotCount)}</span> },
      { k: 'latestSnapshotAt', label: 'Latest Snapshot', render: (r) => <span className="text-ink-faint text-[11px] tnum whitespace-nowrap">{dateAgo(r.latestSnapshotAt)}</span> },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
  {
    id: 'databases', label: 'Databases', countKey: 'databases', url: '/aws/lightsail/databases', dataKey: 'databases',
    searchKeys: ['name', 'engine', 'bundle', 'endpoint', 'az', 'account'],
    filters: [{ k: 'state', label: 'States' }, { k: 'engine', label: 'Engines' }, { k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail databases found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'engine', label: 'Engine', render: (r) => <span className="text-ink-muted">{dash(r.engine)} {r.engineVersion || ''}</span> },
      { k: 'bundle', label: 'Bundle', render: mutedCell('bundle') },
      { k: 'ramGb', label: 'RAM', align: 'right', render: (r) => <span className="text-ink-muted tnum">{ramText(r.ramGb)}</span> },
      { k: 'diskGb', label: 'Disk', align: 'right', render: (r) => <span className="text-ink-muted tnum">{ramText(r.diskGb)}</span> },
      { k: 'state', label: 'State', render: stateCell },
      { k: 'endpoint', label: 'Endpoint', render: (r) => <span className="text-ink-muted tnum text-[11px]">{r.endpoint ? `${r.endpoint}${r.port ? `:${r.port}` : ''}` : '-'}</span> },
      { k: 'backupRetention', label: 'Backups', render: (r) => yesNo(r.backupRetention, true) },
      { k: 'publiclyAccessible', label: 'Public', render: (r) => yesNo(r.publiclyAccessible, false) },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
  {
    id: 'disks', label: 'Disks', countKey: 'disks', url: '/aws/lightsail/disks', dataKey: 'disks',
    searchKeys: ['name', 'attachedTo', 'az', 'account'],
    filters: [{ k: 'state', label: 'States' }, { k: 'attachmentState', label: 'Attachment' }, { k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail disks found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'sizeGb', label: 'Size', align: 'right', render: (r) => <span className="text-ink-muted tnum">{ramText(r.sizeGb)}</span> },
      { k: 'state', label: 'State', render: stateCell },
      { k: 'attachedTo', label: 'Attached To', render: mutedCell('attachedTo') },
      { k: 'isSystemDisk', label: 'System Disk', render: (r) => <span className="text-ink-muted">{r.isSystemDisk ? 'Yes' : 'No'}</span> },
      { k: 'iops', label: 'IOPS', align: 'right', render: (r) => <span className="text-ink-muted tnum">{fmtNum(r.iops)}</span> },
      { k: 'az', label: 'AZ', render: (r) => <span className="text-ink-muted text-[11px]">{dash(r.az)}</span> },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
  {
    id: 'buckets', label: 'Buckets', countKey: 'buckets', url: '/aws/lightsail/buckets', dataKey: 'buckets',
    searchKeys: ['name', 'bundle', 'url', 'account'],
    filters: [{ k: 'bundle', label: 'Bundles' }, { k: 'objectVersioning', label: 'Versioning' }, { k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail buckets found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'bundle', label: 'Bundle', render: mutedCell('bundle') },
      { k: 'objectVersioning', label: 'Versioning', render: mutedCell('objectVersioning') },
      { k: 'publicRead', label: 'Public Read', render: (r) => yesNo(r.publicRead, false) },
      { k: 'url', label: 'URL', render: (r) => <span className="text-ink-muted tnum text-[11px]">{dash(r.url)}</span> },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
  {
    id: 'load-balancers', label: 'Load balancers', countKey: 'loadBalancers', url: '/aws/lightsail/load-balancers', dataKey: 'loadBalancers',
    searchKeys: ['name', 'dnsName', 'protocol', 'account'],
    filters: [{ k: 'state', label: 'States' }, { k: 'protocol', label: 'Protocols' }, { k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail load balancers found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'dnsName', label: 'DNS', render: (r) => <span className="text-ink-muted tnum text-[11px]">{dash(r.dnsName)}</span> },
      { k: 'protocol', label: 'Protocol:Port', render: (r) => <span className="text-ink-muted tnum">{r.protocol ? `${r.protocol}:${r.instancePort ?? '-'}` : '-'}</span> },
      { k: 'healthCheckPath', label: 'Health Path', render: mutedCell('healthCheckPath') },
      { k: 'attachedInstances', label: 'Instances', render: (r) => <span className="text-ink-muted">{(r.attachedInstances || []).join(', ') || '-'}</span> },
      {
        k: 'unhealthyCount', label: 'Healthy / Unhealthy', align: 'right',
        render: (r) => <span className={`tnum ${r.unhealthyCount ? 'text-status-crit' : 'text-ink-muted'}`}>{fmtNum(r.healthyCount)} / {fmtNum(r.unhealthyCount)}</span>,
      },
      { k: 'tlsCertName', label: 'TLS Cert', render: (r) => <span className="text-ink-muted">{r.tlsCertName ? `${r.tlsCertName}${r.tlsCertAttached ? '' : ' (not attached)'}` : '-'}</span> },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
  {
    id: 'distributions', label: 'Distributions', countKey: 'distributions', url: '/aws/lightsail/distributions', dataKey: 'distributions',
    searchKeys: ['name', 'domainName', 'originName', 'bundle', 'account'],
    filters: [{ k: 'status', label: 'Status' }, { k: 'bundle', label: 'Bundles' }, { k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail distributions found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'status', label: 'Status', render: (r) => <Badge tone={stateTone(r.status)}>{r.status || '-'}</Badge> },
      { k: 'isEnabled', label: 'Enabled', render: (r) => yesNo(r.isEnabled, true) },
      { k: 'domainName', label: 'Domain', render: (r) => <span className="text-ink-muted tnum text-[11px]">{dash(r.domainName)}</span> },
      { k: 'originName', label: 'Origin', render: (r) => <span className="text-ink-muted">{r.originName ? `${r.originName}${r.originRegion ? ` (${r.originRegion})` : ''}` : '-'}</span> },
      { k: 'bundle', label: 'Bundle', render: mutedCell('bundle') },
      { k: 'certName', label: 'Cert', render: mutedCell('certName') },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
  {
    id: 'domains', label: 'DNS zones', countKey: 'domains', url: '/aws/lightsail/domains', dataKey: 'domains',
    searchKeys: ['name', 'account'],
    filters: [{ k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail DNS zones found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'entryCount', label: 'Entries', align: 'right', render: (r) => <span className="text-ink-muted tnum">{fmtNum(r.entryCount)}</span> },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
  {
    id: 'static-ips', label: 'Static IPs', countKey: 'staticIps', url: '/aws/lightsail/static-ips', dataKey: 'staticIps',
    searchKeys: ['name', 'ipAddress', 'attachedTo', 'az', 'account'],
    filters: [{ k: 'az', label: 'AZs' }, { k: 'account', label: 'Accounts' }],
    empty: 'No Lightsail static IPs found.',
    cols: [
      { k: 'name', label: 'Name', render: (r) => <span className="text-ink">{r.name}</span> },
      { k: 'ipAddress', label: 'IP', render: (r) => <span className="text-ink-muted tnum text-[11px]">{dash(r.ipAddress)}</span> },
      { k: 'isAttached', label: 'Attached', render: (r) => yesNo(r.isAttached, true) },
      { k: 'attachedTo', label: 'Attached To', render: mutedCell('attachedTo') },
      { k: 'az', label: 'AZ', render: (r) => <span className="text-ink-muted text-[11px]">{dash(r.az)}</span> },
      { k: 'account', label: 'Account', render: acctCell },
    ],
  },
];

function InventoryTable({ tab, rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: tab.searchKeys, defaultSortKey: 'name', defaultSortDir: 'asc', paginate: true,
  });
  if (rows == null) return <LoadingPanel label="Loading..." height={140} />;
  return (
    <>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder={`Filter ${tab.label.toLowerCase()}...`} filters={tab.filters} />
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">{tab.empty}</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No {tab.label.toLowerCase()} match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              {tab.cols.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={`${r.account}|${r.name}`} className="border-b border-cohesity-border/50">
                  {tab.cols.map((c) => (
                    <td key={c.k} className={`py-2 pr-3 ${c.align === 'right' ? 'text-right' : ''}`}>{c.render(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </>
  );
}

export default function AwsLightsailPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState({});
  const [summary, setSummary] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const activeId = searchParams.get('tab');
  const tab = TABS.find((t) => t.id === activeId) || TABS[0];

  const load = useCallback(async () => {
    let failed = false;
    const results = await Promise.all(TABS.map((t) => client.get(t.url)
      .then(({ data: body }) => [t.id, body?.[t.dataKey] || []])
      .catch(() => { failed = true; return [t.id, []]; })));
    setData(Object.fromEntries(results));
    client.get('/aws/lightsail/summary').then(({ data: s }) => setSummary(s || {})).catch(() => setSummary({}));
    setLastRefreshed(new Date());
    if (failed) toast({ type: 'error', title: 'Failed to load some Lightsail data' });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const s = summary || {};
  const count = (t) => (data[t.id] ? data[t.id].length : null);
  const selectTab = (id) => setSearchParams(id === TABS[0].id ? {} : { tab: id }, { replace: true });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Boxes} title="Lightsail" description="Lightsail instances, databases, disks, buckets, load balancers and more across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
        <StatCard icon={Boxes} label="Instances" value={summary ? `${fmtNum(s.instancesRunning)} / ${fmtNum(s.instances)}` : '-'}
          sub="running / total" tone="brand" onClick={() => selectTab('instances')} />
        <StatCard icon={Database} label="Databases" value={fmtNum(s.databases)}
          sub={s.databasesWithoutBackups ? `${s.databasesWithoutBackups} without backups` : 'all backed up'}
          tone={s.databasesWithoutBackups ? 'warn' : 'default'} onClick={() => selectTab('databases')} />
        <StatCard icon={HardDrive} label="Disks" value={fmtNum(s.disks)}
          sub={`${fmtNum(s.unattachedDisks)} unattached`} tone={s.unattachedDisks ? 'crit' : 'default'}
          onClick={() => selectTab('disks')} />
        <StatCard icon={Archive} label="Buckets" value={fmtNum(s.buckets)}
          sub={`${fmtNum(s.publicBuckets)} public`} tone={s.publicBuckets ? 'warn' : 'default'}
          onClick={() => selectTab('buckets')} />
        <StatCard icon={Network} label="Load balancers" value={fmtNum(s.loadBalancers)}
          sub={`${fmtNum(s.loadBalancersUnhealthy)} with unhealthy targets`} tone={s.loadBalancersUnhealthy ? 'crit' : 'default'}
          onClick={() => selectTab('load-balancers')} />
        <StatCard icon={Globe} label="Static IPs" value={fmtNum(s.staticIps)}
          sub={`${fmtNum(s.unattachedStaticIps)} unattached`} tone={s.unattachedStaticIps ? 'warn' : 'default'}
          onClick={() => selectTab('static-ips')} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap gap-1 mb-4 border-b border-cohesity-border">
          {TABS.map((t) => {
            const n = count(t);
            const active = t.id === tab.id;
            return (
              <button key={t.id} onClick={() => selectTab(t.id)}
                className={`px-3 py-2 text-sm cursor-pointer border-b-2 -mb-px transition-colors ${active ? 'border-brand text-ink font-semibold' : 'border-transparent text-ink-muted hover:text-ink'}`}>
                {t.label}{n != null && <span className="ml-1.5 text-[11px] text-ink-faint tnum">{n}</span>}
              </button>
            );
          })}
        </div>
        <InventoryTable key={tab.id} tab={tab} rows={data[tab.id] ?? null} />
      </div>
    </div>
  );
}
