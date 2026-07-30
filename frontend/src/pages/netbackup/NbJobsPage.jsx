import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, fmtDuration, fmtWhen, jobStateTone } from './helpers';

export default function NbJobsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [days, setDays] = useState(7);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get(`/netbackup/jobs?days=${days}`)
    .then(({ data }) => { setRows(data.jobs || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load jobs' }); }), [toast, days]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map(j => ({ ...j, bytes: j.kilobytes != null ? j.kilobytes * 1024 : null }));

  const ctl = useTableControls(list, {
    searchKeys: ['clientName', 'policyName'],
    defaultSortKey: 'startedAt', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ClipboardList} title="Data Protection Jobs" description="NetBackup job history across all registered sources">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
          <option value={1}>1 day</option>
          <option value={3}>3 days</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
        </select>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by client or policy…"
            filters={[{ k: 'state', label: 'States' }, { k: 'policyType', label: 'Policy Types' }, { k: 'sourceName', label: 'Sources' }]} />
          <CsvExportButton filename="netbackup-jobs" rows={ctl.rows} columns={[
            { label: 'Job ID', get: 'jobId' },
            { label: 'Source', get: 'sourceName' },
            { label: 'Client', get: 'clientName' },
            { label: 'Policy', get: 'policyName' },
            { label: 'Policy Type', get: 'policyType' },
            { label: 'State', get: 'state' },
            { label: 'Status Code', get: 'statusCode' },
            { label: 'Storage Unit', get: 'storageUnit' },
            { label: 'Files', get: 'filesCount' },
            { label: 'Bytes', get: 'bytes' },
            { label: 'Elapsed (s)', get: 'elapsedSeconds' },
            { label: 'Started', get: (r) => fmtWhen(r.startedAt) },
            { label: 'Ended', get: (r) => fmtWhen(r.endedAt) },
          ]} />
        </div>
        {rows == null ? (
          <LoadingPanel label="Loading jobs…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No jobs found for this window — register a NetBackup source under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No jobs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
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
                  <tr key={j.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink tnum">{j.jobId}</td>
                    <td className="py-2 pr-3">
                      {j.clientName
                        ? <Link to={`/ops/server360?name=${encodeURIComponent(j.clientName)}`} className="text-ink font-medium hover:text-brand">{j.clientName}</Link>
                        : '—'}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{j.policyName || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{j.policyType || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={jobStateTone(j)}>{j.state || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{j.sourceName}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(j.bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtDuration(j.elapsedSeconds)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint text-[11px]">{fmtWhen(j.startedAt)}</td>
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
