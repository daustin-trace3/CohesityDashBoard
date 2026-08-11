// NetBackup Jobs — ports host frontend/src/pages/netbackup/NbJobsPage.jsx.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, CsvExportButton,
  ClipboardIcon,
} from '../ui.jsx';
import { BRAND, fmtBytes, fmtDuration, fmtWhen, jobStateTone, apiGet } from './helpers.js';

injectStyles();

export default function NbJobsPage() {
  const [rows, setRows] = React.useState(null);
  const [days, setDays] = React.useState(7);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiGet('/jobs', { days })
    .then((d) => { setRows(d.jobs || []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), [days]);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((j) => ({ ...j, bytes: j.kilobytes != null ? j.kilobytes * 1024 : null }));

  const ctl = useTableControls(list, { searchKeys: ['clientName', 'policyName', 'jobId'], defaultSortKey: 'startedAt', defaultSortDir: 'desc', paginate: true });

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={ClipboardIcon} title="Data Protection Jobs" description="NetBackup job history across all registered sources">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value={1}>1 day</option>
          <option value={3}>3 days</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
        </select>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={rows == null} />
      </PageHeader>

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', margin: 0 }}>Jobs</p>
          <CsvExportButton filename="netbackup-jobs" rows={ctl.rows} columns={[
            { label: 'Job ID', get: 'jobId' }, { label: 'Source', get: 'sourceName' }, { label: 'Client', get: 'clientName' },
            { label: 'Policy', get: 'policyName' }, { label: 'Policy Type', get: 'policyType' }, { label: 'State', get: 'state' },
            { label: 'Status Code', get: 'statusCode' }, { label: 'Storage Unit', get: 'storageUnit' }, { label: 'Files', get: 'filesCount' },
            { label: 'Bytes', get: 'bytes' }, { label: 'Elapsed (s)', get: 'elapsedSeconds' },
            { label: 'Started', get: (r) => fmtWhen(r.startedAt) }, { label: 'Ended', get: (r) => fmtWhen(r.endedAt) },
          ]} />
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by client or policy…"
          filters={[{ k: 'state', label: 'States' }, { k: 'policyType', label: 'Policy Types' }, { k: 'sourceName', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading jobs…" height={140} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No jobs found for this window — register a NetBackup source under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No jobs match your filters.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <SortTh k="jobId" label="Job ID" ctl={ctl} />
                <SortTh k="clientName" label="Client" ctl={ctl} />
                <SortTh k="policyName" label="Policy" ctl={ctl} />
                <SortTh k="policyType" label="Type" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="sourceName" label="Source" ctl={ctl} />
                <SortTh k="bytes" label="Size" ctl={ctl} align="right" />
                <SortTh k="elapsedSeconds" label="Duration" ctl={ctl} align="right" />
                <SortTh k="startedAt" label="Started" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((j) => (
                  <tr key={j.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>{j.jobId}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      {j.clientName ? (
                        <ReactRouterDOM.Link to={`/ops/server360?name=${encodeURIComponent(j.clientName)}`} style={{ color: 'var(--nb-ink)', fontWeight: 500, textDecoration: 'none' }}>{j.clientName}</ReactRouterDOM.Link>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{j.policyName || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{j.policyType || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={jobStateTone(j)}>{j.state || '—'}</Badge></td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{j.sourceName}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtBytes(j.bytes)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtDuration(j.elapsedSeconds)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-faint)', fontSize: 11 }}>{fmtWhen(j.startedAt)}</td>
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
