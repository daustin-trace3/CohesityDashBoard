// Correlation page sections. Every section renders one list from the single
// GET /logicmonitor/correlation payload; Export pulls
// GET /logicmonitor/correlation.csv?section=<key>.
import { useState, Fragment } from 'react';
import { Download, ChevronRight, ChevronDown } from 'lucide-react';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { useToast } from '../../components/ui/Toaster';
import { fmtNum, fmtWhen, fmtPct, titleCase, downloadCsv, arr } from './helpers';
import { SectionPanel, headRow } from './ui';

function CsvBtn({ csv }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await downloadCsv('/logicmonitor/correlation.csv', { section: csv }, `logicmonitor-${csv}`); }
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

const fmtBytes = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let x = Number(n);
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const findingChip = (f) => (f ? <Badge tone={f === 'saturates' || f === 'coincident' ? 'crit' : 'warn'}>{titleCase(f)}</Badge> : <span className="text-ink-faint">-</span>);

const RULES = {
  vmkernel: ['vmkernel', "Ports found by following the host's management vmkernel interface to its vSwitch uplinks and their switch neighbours."],
  'all-uplinks': ['all uplinks', 'The vmkernel path could not be resolved, so every switch port matched to the host is counted.'],
  physical: ['physical', 'Physical server: the switch ports matched to the server by name.'],
};
const RuleChip = ({ rule }) => {
  const r = RULES[rule];
  return r ? <span title={r[1]}><Badge tone="neutral">{r[0]}</Badge></span> : null;
};

// columns: [{ k, label, align, render(row), sort }]; expand(row) returns a node.
function CorrTable({ section, csv, icon, title, blurb, rows, columns, searchKeys, defaultSortKey, defaultSortDir = 'desc', emptyText, expand }) {
  const list = arr(rows);
  const [open, setOpen] = useState({});
  const ctl = useTableControls(list, { searchKeys, defaultSortKey, defaultSortDir, paginate: true });
  const span = columns.length + (expand ? 1 : 0);
  return (
    <SectionPanel icon={icon} title={title} blurb={blurb} right={csv ? <CsvBtn csv={csv} /> : null}>
      {list.length === 0 ? (
        <p className="text-sm py-4 text-center text-ink-muted">{emptyText}</p>
      ) : (
        <>
          {searchKeys?.length ? (
            <div className="flex items-center gap-2 mb-2"><TableSearch ctl={ctl} /><span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} row(s)</span></div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                {expand && <th className="w-5" />}
                {columns.map((c) => (c.sort === false
                  ? <th key={c.k} className={`py-2 pr-3 ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>
                  : <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />))}
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r, i) => {
                  const key = `${section}-${r.deviceName || ''}-${r.port || ''}-${r.host || ''}-${r.windowStart || r.at || r.changedAt || ''}-${r.subject || r.changeId || ''}-${i}`;
                  const isOpen = !!open[key];
                  return (
                    <Fragment key={key}>
                      <tr className={`border-b border-cohesity-border/50 ${expand ? 'cursor-pointer hover:bg-surface-overlay' : ''}`} onClick={expand ? () => setOpen((o) => ({ ...o, [key]: !o[key] })) : undefined}>
                        {expand && <td className="py-2 pr-1 text-ink-faint">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>}
                        {columns.map((c) => (
                          <td key={c.k} className={`py-2 pr-3 text-[12px] ${c.align === 'right' ? 'text-right tnum' : ''} ${c.k === columns[0].k ? 'text-ink' : 'text-ink-muted'}`}>
                            {c.render ? c.render(r) : (r[c.k] ?? '-')}
                          </td>
                        ))}
                      </tr>
                      {expand && isOpen && <tr className="border-b border-cohesity-border/50 bg-surface-overlay/40"><td colSpan={span} className="p-3">{expand(r)}</td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </SectionPanel>
  );
}

function RunsDetail({ runs }) {
  const list = arr(runs);
  if (!list.length) return <p className="text-[11px] text-ink-faint">No run detail for this window.</p>;
  return (
    <table className="w-full text-[11px]">
      <thead><tr className={headRow}>
        <th className="py-1 pr-3">Job</th><th className="py-1 pr-3">Cluster</th><th className="py-1 pr-3">Object</th><th className="py-1 pr-3">Status</th>
        <th className="py-1 pr-3">Start</th><th className="py-1 pr-3">End</th><th className="py-1 pr-3 text-right">Bytes</th><th className="py-1 pr-3">Share</th>
      </tr></thead>
      <tbody>
        {list.map((r, i) => {
          const share = r.sharePct == null ? null : Math.max(0, Math.min(100, Number(r.sharePct)));
          return (
            <tr key={`${r.jobName}-${r.objectName}-${i}`} className="border-b border-cohesity-border/30">
              <td className="py-1 pr-3 text-ink">{r.jobName || '-'}</td>
              <td className="py-1 pr-3 text-ink-muted">{r.cluster || '-'}</td>
              <td className="py-1 pr-3 text-ink-muted">{r.objectName || '-'}</td>
              <td className="py-1 pr-3 text-ink-muted">{r.status || '-'}</td>
              <td className="py-1 pr-3 text-ink-faint tnum whitespace-nowrap">{fmtWhen(r.start)}</td>
              <td className="py-1 pr-3 text-ink-faint tnum whitespace-nowrap">{fmtWhen(r.end)}</td>
              <td className="py-1 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.logicalBytes)}</td>
              <td className="py-1 pr-3">
                {share == null ? <span className="text-ink-faint">-</span> : (
                  <div className="flex items-center gap-1.5 min-w-[90px]">
                    <div className="h-1.5 flex-1 rounded-full bg-surface-overlay overflow-hidden"><div className="h-full bg-brand" style={{ width: `${share}%` }} /></div>
                    <span className="tnum text-ink w-9 text-right">{Math.round(share)}%</span>
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function BackupLoadSection({ rows, icon }) {
  const columns = [
    { k: 'port', label: 'Port', render: (r) => <span><span className="text-ink">{r.deviceName || '-'}</span> <span className="font-mono text-[11px] text-ink-muted">{r.port || ''}</span></span> },
    { k: 'host', label: 'Host', render: (r) => <span>{r.host || '-'} <RuleChip rule={r.uplinkRule} /></span> },
    { k: 'windowStart', label: 'Window', render: (r) => <span className="whitespace-nowrap">{fmtWhen(r.windowStart)} - {fmtWhen(r.windowEnd)}</span> },
    { k: 'meanUtilPct', label: 'Mean', align: 'right', render: (r) => fmtPct(r.meanUtilPct) },
    { k: 'maxUtilPct', label: 'Max', align: 'right', render: (r) => fmtPct(r.maxUtilPct) },
    { k: 'baselineUtilPct', label: 'Baseline', align: 'right', render: (r) => fmtPct(r.baselineUtilPct) },
    { k: 'runCount', label: 'Runs', align: 'right', render: (r) => fmtNum(r.runCount ?? arr(r.runs).length) },
    { k: 'finding', label: 'Finding', render: (r) => findingChip(r.finding) },
  ];
  return (
    <CorrTable section="backupLoad" csv="backupLoad" icon={icon} title="Backup load on switch ports" rows={rows} columns={columns}
      blurb="Cohesity protection runs from the last 7 days grouped per host and overlapping window, with the load on the switch ports behind that host. Open a row to see the runs and each run's share of the window's bytes."
      searchKeys={['host', 'deviceName', 'port']} defaultSortKey="meanUtilPct" emptyText="No backup window was matched to a switch port."
      expand={(r) => <RunsDetail runs={r.runs} />} />
  );
}

export function ReplicationSection({ rows, icon }) {
  const kindLabel = { 'zerto-rpo': 'Zerto RPO', 'zerto-alert': 'Zerto alert', 'cohesity-replication': 'Cohesity replication' };
  const columns = [
    { k: 'kind', label: 'Kind', render: (r) => <Badge tone="info">{kindLabel[r.kind] || r.kind || '-'}</Badge> },
    { k: 'subject', label: 'Subject' },
    { k: 'detail', label: 'Detail', sort: false, render: (r) => <span className="line-clamp-2" title={r.detail || ''}>{r.detail || '-'}</span> },
    { k: 'at', label: 'When', render: (r) => <span className="whitespace-nowrap">{fmtWhen(r.at)}{r.until ? ` - ${fmtWhen(r.until)}` : ''}</span> },
    { k: 'circuitLabel', label: 'Circuit', render: (r) => r.circuitLabel.trim() || '-' },
    { k: 'circuitUtilPct', label: 'Util', align: 'right', render: (r) => fmtPct(r.circuitUtilPct) },
    { k: 'circuitP95Pct', label: 'p95', align: 'right', render: (r) => fmtPct(r.circuitP95Pct) },
    { k: 'finding', label: 'Finding', render: (r) => findingChip(r.finding) },
  ];
  const flat = arr(rows).map((r) => ({ ...r, circuitLabel: r.circuit ? `${r.circuit.label || r.circuit.deviceName || ''} ${r.circuit.port || ''}` : '' }));
  return (
    <CorrTable section="replication" csv="replicationVsCircuits" icon={icon} title="Replication vs circuits" rows={flat} columns={columns}
      blurb="Zerto RPO breaches and alerts and slow or failed Cohesity replication runs, compared with the load on the WAN circuits during the same time. Coincident means the circuit was over its saturation line."
      searchKeys={['subject', 'detail', 'circuitLabel']} defaultSortKey="at" emptyText="No replication problems overlap a circuit in this period." />
  );
}

export function ChangesSection({ rows, icon }) {
  const columns = [
    { k: 'device', label: 'Device' },
    { k: 'item', label: 'Change', sort: false, render: (r) => (
      <span title={`${r.oldValue || ''}\n->\n${r.newValue || ''}`}>
        <Badge tone="neutral">{r.changeType || 'change'}</Badge> <span className="ml-1">{[r.scope, r.item].filter(Boolean).join(' / ') || '-'}</span>
      </span>
    ) },
    { k: 'changedAt', label: 'When', render: (r) => <span className="whitespace-nowrap">{fmtWhen(r.changedAt)}</span> },
    { k: 'incidentType', label: 'Incident', render: (r) => (r.incident ? <span title={r.incident.message || ''}><Badge tone="warn">{r.incident.type}</Badge> <span className="ml-1">{r.incident.target || ''}</span></span> : '-') },
    { k: 'minutesAfter', label: 'Minutes after', align: 'right', render: (r) => (r.minutesAfter == null ? '-' : fmtNum(Math.round(r.minutesAfter))) },
  ];
  const flat = arr(rows).map((r) => ({ ...r, incidentType: r.incident?.type || '', minutesAfter: r.incident?.minutesAfter ?? null }));
  return (
    <CorrTable section="changes" csv="changesThenIncidents" icon={icon} title="Changes followed by incidents" rows={flat} columns={columns}
      blurb="Configuration changes that were followed within 24 hours by an incident on the same device or on a path through it. A pairing is a lead to check, not proof of cause."
      searchKeys={['device', 'system', 'item', 'scope', 'incidentType']} defaultSortKey="changedAt" emptyText="No change was followed by an incident." />
  );
}

export function BlameSection({ blame, icon }) {
  const columns = [
    { k: 'deviceName', label: 'Hop' },
    { k: 'port', label: 'Port', render: (r) => <span className="font-mono text-[11px]">{r.port || '-'}</span> },
    { k: 'siteKey', label: 'Site' },
    { k: 'count', label: 'Count', align: 'right' },
    { k: 'lastAt', label: 'Last seen', render: (r) => <span className="whitespace-nowrap">{fmtWhen(r.lastAt)}</span> },
    { k: 'subjectsText', label: 'Top subjects', sort: false, render: (r) => arr(r.subjects).slice(0, 4).map((s) => `${s.subject} (${s.count})`).join(', ') || '-' },
    { k: 'appsText', label: 'Apps affected', sort: false, render: (r) => arr(r.appsAffected).join(', ') || '-' },
  ];
  const flat = arr(blame?.hops).map((h) => ({ ...h, subjectsText: arr(h.subjects).map((s) => s.subject).join(' ') }));
  const recentCols = [
    { k: 'at', label: 'When', render: (r) => <span className="whitespace-nowrap">{fmtWhen(r.at)}</span> },
    { k: 'kind', label: 'Kind', render: (r) => <Badge tone="neutral">{r.kind || '-'}</Badge> },
    { k: 'subject', label: 'Subject' },
    { k: 'hopDeviceName', label: 'Hop', render: (r) => `${r.hopDeviceName || '-'}${r.hopPort ? ` ${r.hopPort}` : ''}` },
    { k: 'hopState', label: 'State', render: (r) => r.hopState || '-' },
    { k: 'hopReason', label: 'Reason', sort: false, render: (r) => <span className="line-clamp-2" title={r.hopReason || ''}>{r.hopReason || '-'}</span> },
  ];
  return (
    <div className="space-y-4">
      <CorrTable section="blames" csv="blameHops" icon={icon} title="Blame history" rows={flat} columns={columns}
        blurb="Hops that ICC named as the likely cause of a failing check or server path in the last 30 days, most often first. A hop that keeps appearing is the place to look."
        searchKeys={['deviceName', 'port', 'siteKey', 'subjectsText']} defaultSortKey="count" emptyText="No hop has been blamed yet." />
      <CorrTable section="blameRecent" csv="blameRecent" icon={icon} title="Recent blames" rows={blame?.recent} columns={recentCols}
        searchKeys={['subject', 'hopDeviceName', 'hopPort']} defaultSortKey="at" emptyText="No recent blames." />
    </div>
  );
}
