import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, History } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtWhen } from './helpers';

const taskTone = (status) => (status == null ? 'neutral' : status === 'OK' ? 'ok' : 'crit');

export default function PxBackupsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/proxmox/backups')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ jobs: [], recentTasks: [] }); toast({ type: 'error', title: 'Failed to load backups' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const jobs = data?.jobs || [];
  const tasks = data?.recentTasks || [];

  const jobCtl = useTableControls(jobs, {
    searchKeys: ['jobId', 'serverName', 'storage', 'schedule'],
    defaultSortKey: 'nextRun', defaultSortDir: 'asc',
    paginate: true,
  });
  const taskCtl = useTableControls(tasks, {
    searchKeys: ['node', 'target', 'serverName', 'status'],
    defaultSortKey: 'startedAt', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Backups" description="vzdump backup jobs and recent run outcomes across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Backup Jobs</p>
        <TableControls ctl={jobCtl} rows={jobs} searchPlaceholder="Filter by job, server or storage…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'enabled', label: 'Enabled' }]} />
        {data == null ? (
          <LoadingPanel label="Loading jobs…" height={140} />
        ) : jobs.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No backup jobs found.</div>
        ) : jobCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No jobs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="jobId" label="Job" ctl={jobCtl} />
                <SortTh k="serverName" label="Server" ctl={jobCtl} />
                <SortTh k="enabled" label="Enabled" ctl={jobCtl} />
                <SortTh k="schedule" label="Schedule" ctl={jobCtl} />
                <SortTh k="storage" label="Storage" ctl={jobCtl} />
                <SortTh k="mode" label="Mode" ctl={jobCtl} />
                <th className="py-2 pr-3">Selection</th>
                <SortTh k="nextRun" label="Next Run" ctl={jobCtl} />
              </tr></thead>
              <tbody>
                {jobCtl.pageRows.map((j) => (
                  <tr key={`${j.serverId}|${j.jobId}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{j.jobId}</td>
                    <td className="py-2 pr-3 text-ink-muted">{j.serverName}</td>
                    <td className="py-2 pr-3"><Badge tone={j.enabled ? 'ok' : 'neutral'}>{j.enabled ? 'enabled' : 'disabled'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{j.schedule || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{j.storage || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{j.mode || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[180px] truncate" title={j.selection}>{j.selection || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(j.nextRun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={jobCtl} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><History size={15} className="text-brand" /> Recent Backup Tasks</p>
        <p className="text-[11px] text-ink-faint mb-3">Newest vzdump task outcomes across all servers.</p>
        <TableControls ctl={taskCtl} rows={tasks} searchPlaceholder="Filter by node, target or status…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'status', label: 'Status' }]} />
        {data == null ? (
          <LoadingPanel label="Loading tasks…" height={140} />
        ) : tasks.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No backup task history yet.</div>
        ) : taskCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No tasks match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="target" label="Target" ctl={taskCtl} />
                <SortTh k="node" label="Node" ctl={taskCtl} />
                <SortTh k="serverName" label="Server" ctl={taskCtl} />
                <SortTh k="status" label="Status" ctl={taskCtl} />
                <SortTh k="startedAt" label="Started" ctl={taskCtl} />
                <SortTh k="endedAt" label="Ended" ctl={taskCtl} />
              </tr></thead>
              <tbody>
                {taskCtl.pageRows.map((t) => (
                  <tr key={t.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{t.target || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{t.node}</td>
                    <td className="py-2 pr-3 text-ink-muted">{t.serverName}</td>
                    <td className="py-2 pr-3"><Badge tone={taskTone(t.status)}>{t.status || 'running'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(t.startedAt)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{t.endedAt ? fmtWhen(t.endedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={taskCtl} />
      </div>
    </div>
  );
}
