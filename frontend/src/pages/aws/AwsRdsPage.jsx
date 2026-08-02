import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Database, LineChart, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import TrendChart from '../../components/TrendChart';
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

// Portal to <body> — matches AwsSettingsPage's ProbeModal (the page wrapper's
// fade-in animation leaves a transform applied, which would re-anchor
// position:fixed to the page div and cut off the modal on scrolled pages).
function RdsHistoryModal({ instance, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRows(null);
    setError(false);
    client.get('/aws/rds/history', { params: { dbId: instance.dbId, days: 90 } })
      .then(({ data }) => setRows(data?.rows || []))
      .catch(() => setError(true));
  }, [instance.dbId]);

  const labels = (rows || []).map((r) => r.day);
  const allocatedGb = rows && rows.length ? rows[rows.length - 1].allocatedGb : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-2xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <LineChart size={15} className="text-brand" /> {instance.dbId} — free storage (90d)
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">
              Daily free storage snapshots{allocatedGb != null ? ` — allocated ${fmtNum(allocatedGb)} GB` : ''}.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0 flex-1">
          {error ? (
            <div className="text-sm text-status-crit py-6 text-center">Failed to load RDS storage history.</div>
          ) : rows == null ? (
            <div className="py-10 flex justify-center"><Spinner size={20} /></div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No history yet — snapshots accumulate daily.</div>
          ) : (
            <TrendChart labels={labels}
              datasets={[
                { label: 'Free storage', data: rows.map((r) => r.freeStorageBytes), color: BRAND, fill: true },
                { label: 'Allocated', data: rows.map((r) => (r.allocatedGb != null ? r.allocatedGb * 1024 ** 3 : null)), color: '#569BD6' },
              ]}
              format={(v) => fmtBytes(v)} height={220} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function AwsRdsPage() {
  const { toast } = useToast();
  const [instances, setInstances] = useState(null);
  const [warnPct, setWarnPct] = useState(STORAGE_WARN_DEFAULT);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [historyInstance, setHistoryInstance] = useState(null);

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
                <th className="py-2 pr-3 text-right">Growth</th>
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
                      <td className="py-2 pr-3 text-right">
                        <button onClick={() => setHistoryInstance(i)} title={`${i.dbId} storage history`} aria-label={`${i.dbId} storage history`}
                          className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-brand hover:border-brand/40 transition-colors cursor-pointer">
                          <LineChart size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {historyInstance && <RdsHistoryModal instance={historyInstance} onClose={() => setHistoryInstance(null)} />}
    </div>
  );
}
