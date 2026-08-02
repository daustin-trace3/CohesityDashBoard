import { useEffect, useState, useCallback } from 'react';
import { Database } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, fmtPct, fmtWhen } from './helpers';

const STORAGE_WARN_DEFAULT = 15;

const isLowStorage = (i, warnPct) => i.status === 'available' && i.freeStoragePct != null && Number(i.freeStoragePct) < warnPct;

const statusTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'available') return 'ok';
  if (v.includes('fail')) return 'crit';
  if (v.includes('stop')) return 'neutral';
  return 'warn';
};

export default function AwsRdsPage() {
  const { toast } = useToast();
  const [instances, setInstances] = useState(null);
  const [warnPct, setWarnPct] = useState(STORAGE_WARN_DEFAULT);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/aws/rds').then(({ data }) => setInstances(data?.instances || [])),
    client.get('/aws/config').then(({ data }) => { if (data?.rdsStorageWarnPct != null) setWarnPct(Number(data.rdsStorageWarnPct)); }).catch(() => {}),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setInstances([]); toast({ type: 'error', title: 'Failed to load RDS data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = instances || [];
  const ctl = useTableControls(list, {
    searchKeys: ['dbId', 'engine', 'instanceClass', 'endpoint', 'account'],
    defaultSortKey: 'dbId', defaultSortDir: 'asc',
    paginate: true,
  });
  const lowStorageCount = list.filter((i) => isLowStorage(i, warnPct)).length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="RDS" description="RDS instances across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink">Instances</p>
          {lowStorageCount > 0 && <Badge tone="warn">{fmtNum(lowStorageCount)} low storage</Badge>}
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by DB ID, engine, class or account…"
          filters={[{ k: 'engine', label: 'Engines' }, { k: 'status', label: 'Statuses' }, { k: 'account', label: 'Accounts' }]} />
        {instances == null ? (
          <LoadingPanel label="Loading instances…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No RDS instances found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No instances match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="dbId" label="DB ID" ctl={ctl} />
                <SortTh k="engine" label="Engine" ctl={ctl} />
                <SortTh k="instanceClass" label="Class" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="multiAz" label="Multi-AZ" ctl={ctl} />
                <SortTh k="allocatedGb" label="Allocated" ctl={ctl} align="right" />
                <SortTh k="freeStoragePct" label="Free Storage" ctl={ctl} align="right" />
                <SortTh k="cpuUtil" label="CPU" ctl={ctl} align="right" />
                <SortTh k="connections" label="Connections" ctl={ctl} align="right" />
                <SortTh k="backupRetentionDays" label="Backup Retention" ctl={ctl} align="right" />
                <SortTh k="latestBackupAt" label="Latest Backup" ctl={ctl} />
                <SortTh k="account" label="Account" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((i) => {
                  const low = isLowStorage(i, warnPct);
                  return (
                    <tr key={`${i.account}|${i.dbId}`} className={`border-b border-cohesity-border/50 ${low ? 'bg-status-warn/10' : ''}`}>
                      <td className="py-2 pr-3 text-ink">{i.dbId}</td>
                      <td className="py-2 pr-3 text-ink-muted">{i.engine || '—'}{i.engineVersion ? ` ${i.engineVersion}` : ''}</td>
                      <td className="py-2 pr-3 text-ink-muted">{i.instanceClass || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone={statusTone(i.status)}>{i.status || '—'}</Badge></td>
                      <td className="py-2 pr-3">{i.multiAz ? <Badge tone="brand">Multi-AZ</Badge> : <span className="text-ink-faint">—</span>}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{i.allocatedGb != null ? `${fmtNum(i.allocatedGb)} GB` : '—'}</td>
                      <td className={`py-2 pr-3 text-right tnum ${low ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{fmtPct(i.freeStoragePct)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{i.cpuUtil != null ? `${Number(i.cpuUtil).toFixed(0)}%` : '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(i.connections)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{i.backupRetentionDays != null ? `${fmtNum(i.backupRetentionDays)}d` : '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(i.latestBackupAt)}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{i.account}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
