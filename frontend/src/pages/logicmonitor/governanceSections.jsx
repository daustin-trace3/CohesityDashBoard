// LogicMonitor Governance sections. Every section renders one list from the
// single GET /logicmonitor/governance payload; Export pulls the server CSV of
// that list (GET /governance.csv?section=<key>).
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { useToast } from '../../components/ui/Toaster';
import {
  fmtNum, fmtWhen, fmtSince, fmtPct, hostStatusTone, hostStatusLabel, severityTone, titleCase, downloadCsv, blameText,
} from './helpers';
import { SectionPanel, headRow } from './ui';

export function ExportBtn({ section }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await downloadCsv('/logicmonitor/governance.csv', { section }, `logicmonitor-${section}`); }
    catch { toast({ type: 'error', title: 'Export failed' }); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={run} disabled={busy}
      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
      <Download size={12} /> {busy ? 'Exporting...' : 'Export'}
    </button>
  );
}

// columns: [{ k, label, align, render(row), sort (false to disable) }]
export function ListSection({ section, icon, title, blurb, rows, columns, searchKeys, defaultSortKey, defaultSortDir = 'asc', emptyText, emptyTone = 'ok', onRow }) {
  const list = rows || [];
  const ctl = useTableControls(list, { searchKeys, defaultSortKey, defaultSortDir, paginate: true });
  return (
    <SectionPanel icon={icon} title={title} blurb={blurb} right={<ExportBtn section={section} />}>
      {list.length === 0 ? (
        <p className={`text-sm py-4 text-center ${emptyTone === 'ok' ? 'text-status-ok' : 'text-ink-muted'}`}>{emptyText}</p>
      ) : (
        <>
          {searchKeys?.length ? (
            <div className="flex items-center gap-2 mb-2"><TableSearch ctl={ctl} /><span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} row(s)</span></div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                {columns.map((c) => (c.sort === false
                  ? <th key={c.k} className={`py-2 pr-3 ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>
                  : <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />))}
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r, i) => (
                  <tr key={r.id ?? r.conditionKey ?? i} className={`border-b border-cohesity-border/50 ${onRow ? 'cursor-pointer hover:bg-surface-overlay' : ''}`} onClick={onRow ? () => onRow(r) : undefined}>
                    {columns.map((c) => (
                      <td key={c.k} className={`py-2 pr-3 text-[12px] ${c.align === 'right' ? 'text-right tnum' : ''} ${c.k === columns[0].k ? 'text-ink' : 'text-ink-muted'}`}>
                        {c.render ? c.render(r) : (r[c.k] ?? '-')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </SectionPanel>
  );
}

export const deviceColumns = [
  { k: 'displayName', label: 'Device' },
  { k: 'vendor', label: 'Vendor' },
  { k: 'role', label: 'Role', render: (r) => (r.role ? titleCase(r.role) : '-') },
  { k: 'hostStatus', label: 'Status', render: (r) => (r.hostStatus ? <Badge tone={hostStatusTone(r.hostStatus)}>{hostStatusLabel(r.hostStatus)}</Badge> : '-') },
];

export const codeLevelColumns = [
  { k: 'vendor', label: 'Vendor' },
  { k: 'model', label: 'Model' },
  { k: 'version', label: 'Version', render: (r) => <span className="tnum">{r.version || '(not parsed)'}</span> },
  { k: 'count', label: 'Devices', align: 'right' },
  { k: 'state', label: 'Position', sort: false, render: (r) => (r.newest ? <Badge tone="ok">Newest seen</Badge> : r.behind ? <Badge tone="warn">Behind</Badge> : <Badge tone="neutral">-</Badge>) },
];

export const buildColumns = [
  { k: 'build', label: 'Build', render: (r) => <span className="tnum">{r.build || '-'}</span> },
  { k: 'count', label: 'Collectors', align: 'right' },
  { k: 'behind', label: 'Position', render: (r) => (r.behind ? <Badge tone="warn">Behind MGD</Badge> : <Badge tone="ok">Current</Badge>) },
];

export const deadColumns = [
  { k: 'displayName', label: 'Device' },
  { k: 'hostStatus', label: 'Status', render: (r) => <Badge tone={hostStatusTone(r.hostStatus)}>{hostStatusLabel(r.hostStatus)}</Badge> },
  { k: 'collectorName', label: 'Collector' },
  { k: 'sinceMs', label: 'Dead for', align: 'right', render: (r) => fmtSince(r.sinceMs) },
];

export const alertColumns = [
  { k: 'severityNorm', label: 'Severity', render: (r) => <Badge tone={severityTone(r.severityNorm)}>{r.severityNorm || r.severity}</Badge> },
  { k: 'monitorObjectName', label: 'Resource' },
  { k: 'datasource', label: 'DataSource' },
  { k: 'dataPointName', label: 'Datapoint' },
  { k: 'ackedBy', label: 'Acked by' },
  { k: 'startedAt', label: 'Started', render: (r) => fmtWhen(r.startedAt) },
];

export const noisyColumns = [
  { k: 'monitorObjectName', label: 'Resource' },
  { k: 'datasource', label: 'DataSource' },
  { k: 'dataPointName', label: 'Datapoint' },
  { k: 'count30d', label: 'Fires (30d)', align: 'right' },
];

export const topologyColumns = [
  { k: 'deviceName', label: 'Device' },
  { k: 'displayName', label: 'Interface' },
  { k: 'description', label: 'Description', render: (r) => <span className="font-mono text-[11px]">{r.description}</span> },
];

// config_changes rows may come through raw (snake_case) or mapped.
const pick = (r, a, b) => r[a] ?? r[b];
export const changeColumns = [
  { k: 'detectedAt', label: 'Detected', render: (r) => fmtWhen(pick(r, 'detectedAt', 'detected_at')) },
  { k: 'scope', label: 'Scope' },
  { k: 'system', label: 'Portal' },
  { k: 'item', label: 'Item' },
  { k: 'changeType', label: 'Change', render: (r) => <Badge tone="neutral">{pick(r, 'changeType', 'change_type')}</Badge> },
  { k: 'newValue', label: 'Detail', sort: false, render: (r) => {
    const oldV = pick(r, 'oldValue', 'old_value');
    const newV = pick(r, 'newValue', 'new_value');
    return <span className="font-mono text-[10px] break-all line-clamp-2" title={`${oldV || ''}\n->\n${newV || ''}`}>{oldV ? `${oldV} -> ` : ''}{newV || '(removed)'}</span>;
  } },
];

// Shadowed alerts: shadowedBy is {deviceId, deviceName, port, reason}; the row
// itself may carry the alert fields flat or under alert.
const shadowedBy = (r) => {
  const b = r.shadowedBy || r.shadowed_by;
  if (!b) return null;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return null; } }
  return b;
};
export const shadowedColumns = [
  { k: 'severityNorm', label: 'Severity', render: (r) => (r.severityNorm || r.severity ? <Badge tone={severityTone(r.severityNorm || r.severity)}>{r.severityNorm || r.severity}</Badge> : '-') },
  { k: 'monitorObjectName', label: 'Resource', render: (r) => r.monitorObjectName || r.deviceName || '-' },
  { k: 'datasource', label: 'DataSource' },
  { k: 'dataPointName', label: 'Datapoint' },
  { k: 'upstream', label: 'Shadowed by', sort: false, render: (r) => blameText(shadowedBy(r)) || '-' },
  { k: 'startedAt', label: 'Started', render: (r) => fmtWhen(r.startedAt) },
];

export const backupWindowColumns = [
  { k: 'jobName', label: 'Job' },
  { k: 'objectName', label: 'Object', render: (r) => r.objectName || r.host || '-' },
  { k: 'deviceName', label: 'Switch' },
  { k: 'port', label: 'Port' },
  { k: 'runStart', label: 'Run start', render: (r) => fmtWhen(r.runStart) },
  { k: 'runEnd', label: 'Run end', render: (r) => fmtWhen(r.runEnd) },
  { k: 'meanUtilPct', label: 'Mean util', align: 'right', render: (r) => fmtPct(r.meanUtilPct) },
  { k: 'baselineUtilPct', label: 'Baseline', align: 'right', render: (r) => fmtPct(r.baselineUtilPct) },
  { k: 'status', label: 'Run status', render: (r) => r.status || '-' },
  { k: 'finding', label: 'Finding', render: (r) => (r.finding ? <Badge tone={r.finding === 'saturates' ? 'crit' : 'warn'}>{titleCase(r.finding)}</Badge> : '-') },
];

export const portNoDescColumns = [
  { k: 'deviceName', label: 'Switch' },
  { k: 'port', label: 'Port' },
];
export const switchNoNeighborColumns = [{ k: 'deviceName', label: 'Switch' }];
export const deviceNoSiteColumns = [{ k: 'deviceName', label: 'Device' }];
export const checkNoBaselineColumns = [
  { k: 'checkName', label: 'Check' },
  { k: 'label', label: 'From' },
  { k: 'samples', label: 'Samples', align: 'right' },
];
