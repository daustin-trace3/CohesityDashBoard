// Proxmox Backups — ports host frontend/src/pages/proxmox/PxBackupsPage.jsx.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  ShieldIcon, HistoryIcon, ArchiveIcon, fmtWhen, fmtBytes,
} from '../ui.jsx';

injectStyles();

const BRAND = '#E57000';

function apiGet(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api/proxmox${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

const taskTone = (status) => (status == null ? 'neutral' : status === 'OK' ? 'ok' : 'crit');

export default function PxBackupsPage() {
  const [data, setData] = React.useState(null);
  const [files, setFiles] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    return Promise.all([
      apiGet('/backups').then((d) => setData(d)),
      apiGet('/storage-content', { content: 'backup' }).then((d) => setFiles(d)).catch(() => setFiles([])),
    ]).then(() => setLastRefreshed(new Date()))
      .catch(() => setData({ jobs: [], recentTasks: [] }))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const jobs = data?.jobs || [];
  const tasks = data?.recentTasks || [];
  const fileCtl = useTableControls(files || [], {
    searchKeys: ['volid', 'storage', 'node', 'serverName', 'vmid'],
    defaultSortKey: 'createdAt', defaultSortDir: 'desc',
    paginate: true,
  });
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
    <div className="px-root px-fade-in">
      <PageHeader icon={ShieldIcon} title="Backups" description="vzdump backup jobs and recent run outcomes across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      <div className="px-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 12 }}>Backup Jobs</p>
        <TableControls ctl={jobCtl} rows={jobs} searchPlaceholder="Filter by job, server or storage…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'enabled', label: 'Enabled' }]} />
        {data == null ? (
          <LoadingPanel label="Loading jobs…" height={140} />
        ) : jobs.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No backup jobs found.</div>
        ) : jobCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No jobs match your filters.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <SortTh k="jobId" label="Job" ctl={jobCtl} />
                  <SortTh k="serverName" label="Server" ctl={jobCtl} />
                  <SortTh k="enabled" label="Enabled" ctl={jobCtl} />
                  <SortTh k="schedule" label="Schedule" ctl={jobCtl} />
                  <SortTh k="storage" label="Storage" ctl={jobCtl} />
                  <SortTh k="mode" label="Mode" ctl={jobCtl} />
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Selection</th>
                  <SortTh k="nextRun" label="Next Run" ctl={jobCtl} />
                </tr>
              </thead>
              <tbody>
                {jobCtl.pageRows.map((j) => (
                  <tr key={`${j.serverId}|${j.jobId}`} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{j.jobId}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{j.serverName}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={j.enabled ? 'ok' : 'neutral'}>{j.enabled ? 'enabled' : 'disabled'}</Badge></td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{j.schedule || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{j.storage || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{j.mode || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.selection}>{j.selection || '—'}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11 }}>{fmtWhen(j.nextRun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={jobCtl} />
      </div>

      <div className="px-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <HistoryIcon size={15} style={{ color: 'var(--px-brand)' }} /> Recent Backup Tasks
        </p>
        <p style={{ fontSize: 11, color: 'var(--px-ink-faint)', marginBottom: 12 }}>Newest vzdump task outcomes across all servers.</p>
        <TableControls ctl={taskCtl} rows={tasks} searchPlaceholder="Filter by node, target or status…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'status', label: 'Status' }]} />
        {data == null ? (
          <LoadingPanel label="Loading tasks…" height={140} />
        ) : tasks.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No backup task history yet.</div>
        ) : taskCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No tasks match your filters.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <SortTh k="target" label="Target" ctl={taskCtl} />
                  <SortTh k="node" label="Node" ctl={taskCtl} />
                  <SortTh k="serverName" label="Server" ctl={taskCtl} />
                  <SortTh k="status" label="Status" ctl={taskCtl} />
                  <SortTh k="startedAt" label="Started" ctl={taskCtl} />
                  <SortTh k="endedAt" label="Ended" ctl={taskCtl} />
                </tr>
              </thead>
              <tbody>
                {taskCtl.pageRows.map((t) => (
                  <tr key={t.id} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{t.target || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{t.node}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{t.serverName}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={taskTone(t.status)}>{t.status || 'running'}</Badge></td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11 }}>{fmtWhen(t.startedAt)}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11 }}>{t.endedAt ? fmtWhen(t.endedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={taskCtl} />
      </div>

      <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArchiveIcon size={15} style={{ color: 'var(--px-brand)' }} /> Backup Files
        </p>
        <p style={{ fontSize: 11, color: 'var(--px-ink-faint)', marginBottom: 12 }}>vzdump backup archives stored on registered storage pools.</p>
        <TableControls ctl={fileCtl} rows={files || []} searchPlaceholder="Filter by volume, storage or vmid…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'storage', label: 'Storage' }]} />
        {files == null ? (
          <LoadingPanel label="Loading backup files…" height={140} />
        ) : files.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No backup files found.</div>
        ) : fileCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No files match your filters.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <SortTh k="volid" label="Volume" ctl={fileCtl} />
                  <SortTh k="vmid" label="VMID" ctl={fileCtl} align="right" />
                  <SortTh k="storage" label="Storage" ctl={fileCtl} />
                  <SortTh k="node" label="Node" ctl={fileCtl} />
                  <SortTh k="serverName" label="Server" ctl={fileCtl} />
                  <SortTh k="sizeBytes" label="Size" ctl={fileCtl} align="right" />
                  <SortTh k="createdAt" label="Created" ctl={fileCtl} />
                </tr>
              </thead>
              <tbody>
                {fileCtl.pageRows.map((f) => (
                  <tr key={f.id} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)', fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.volid}>{f.volid}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>{f.vmid ?? '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{f.storage}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{f.node}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{f.serverName}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>{fmtBytes(f.sizeBytes)}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11 }}>{fmtWhen(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={fileCtl} />
      </div>
    </div>
  );
}
