import { useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../ui/primitives';
import {
  useTableControls, SortTh, TableSearch, FilterSelect, TablePager, CsvExportButton,
} from '../ui/tableTools';
import { fmtNum, fmtWhen, severityTone, DASH } from '../../pages/logicmonitor/helpers';
import { headRow } from '../../pages/logicmonitor/ui';
import LmDevice360 from '../../pages/logicmonitor/LmDevice360';
import { OLDER_VERSION, rowsOf, useF5Get } from '../../pages/f5/f5Shared';

const SEV_RANK = { critical: 3, warning: 2, info: 1 };
const CSV_COLUMNS = [
  { label: 'Severity', get: 'severityText' },
  { label: 'Device', get: 'monitorObjectName' },
  { label: 'DataSource', get: 'datasource' },
  { label: 'Instance', get: 'instanceName' },
  { label: 'Datapoint', get: 'dataPointName' },
  { label: 'Value', get: 'alertValue' },
  { label: 'Threshold', get: 'threshold' },
  { label: 'Started', get: 'startedAt' },
];

// Open alerts of a derived platform's devices, as raised by the portal. One request, filtered here.
// Shared by the F5 and Cisco alerts pages: they differ only in the props below.
export default function DerivedAlertsPage({ apiBase, label, brand, description, emptyText }) {
  const { data, error, loading, reload, loadedAt } = useF5Get(`${apiBase}/alerts`, `${label} alerts`, { params: { cleared: '0', limit: 500 } });
  const [open, setOpen] = useState(null);

  const raw = rowsOf(data);
  const rows = useMemo(() => (raw || []).map((a) => ({
    ...a,
    severityText: a.severityNorm || a.severity || 'info',
    severityRank: SEV_RANK[a.severityNorm || a.severity] || 0,
    stateText: a.acked ? 'Acked' : a.sdted ? 'In SDT' : 'Open',
  })), [raw]);
  const ctl = useTableControls(rows, {
    searchKeys: ['monitorObjectName', 'datasource', 'instanceName', 'dataPointName'], defaultSortKey: 'severityRank', defaultSortDir: 'desc', paginate: true,
  });
  const shapeBad = !loading && !error && raw == null;
  const total = Number(data?.total);
  const capped = Number.isFinite(total) && total > rows.length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bell} title={`${label} Alerts`} description={description}>
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${brand}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableSearch ctl={ctl} placeholder="Search device, DataSource or datapoint..." />
          <FilterSelect ctl={ctl} k="severityText" rows={rows} label="severities" />
          <FilterSelect ctl={ctl} k="datasource" rows={rows} label="DataSources" />
          <FilterSelect ctl={ctl} k="stateText" rows={rows} label="states" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} alert(s)</span>
          <span className="ml-auto"><CsvExportButton filename={`${apiBase.replace(/^\//, '')}-alerts`} columns={CSV_COLUMNS} rows={ctl.rows} /></span>
        </div>
        {capped && <p className="text-[11px] text-ink-faint mb-2">{`Showing the newest ${fmtNum(rows.length)} of ${fmtNum(total)} open alerts.`}</p>}

        {error && <p className="text-sm text-status-crit mb-3">{error}</p>}
        {shapeBad && <p className="text-sm text-status-warn mb-3">{OLDER_VERSION}</p>}

        {loading ? <LoadingPanel label={`Loading ${label} alerts...`} height={200} /> : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">
            {error || shapeBad ? '' : emptyText}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="severityRank" label="Severity" ctl={ctl} />
                  <SortTh k="monitorObjectName" label="Device" ctl={ctl} />
                  <SortTh k="datasource" label="DataSource" ctl={ctl} />
                  <SortTh k="instanceName" label="Instance" ctl={ctl} />
                  <SortTh k="dataPointName" label="Datapoint" ctl={ctl} />
                  <SortTh k="alertValue" label="Value" ctl={ctl} />
                  <SortTh k="startedAt" label="Started" ctl={ctl} />
                  <SortTh k="stateText" label="State" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((a) => (
                    <tr key={a.id} className={`border-b border-cohesity-border/50 ${a.deviceId ? 'cursor-pointer hover:bg-surface-overlay' : ''}`}
                      onClick={a.deviceId ? () => setOpen({ id: a.deviceId, sourceId: a.sourceId }) : undefined}>
                      <td className="py-2 pr-3"><Badge tone={severityTone(a.severityText)}>{a.severityText}</Badge></td>
                      <td className="py-2 pr-3 text-ink text-[12px] truncate max-w-[220px]">{a.monitorObjectName || DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[180px]">{a.datasource || DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[180px]">{a.instanceName || DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{a.dataPointName || DASH}</td>
                      <td className="py-2 pr-3 tnum text-ink text-[12px]">{a.alertValue ?? DASH}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{a.startedAt ? fmtWhen(a.startedAt) : DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{a.stateText}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>

      {open && (
        <LmDevice360 deviceId={open.id} sourceId={open.sourceId} onClose={() => setOpen(null)}
          onSwitchDevice={(id) => setOpen((cur) => ({ ...cur, id }))} />
      )}
    </div>
  );
}
