import { useEffect, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { fmtNum, fmtMs, fmtWhen, EPISODE_STATE_TONE, EPISODE_OUTCOME_LABEL } from './helpers';
import { SectionPanel, headRow } from './ui';
import { WatchLegend } from './LmWatchBand';

const CSV = [
  { label: 'Check', get: 'checkName' }, { label: 'From', get: 'label' }, { label: 'Site', get: 'siteKey' }, { label: 'Kind', get: 'kind' },
  { label: 'State', get: 'state' }, { label: 'Outcome', get: 'outcome' }, { label: 'Opened', get: 'openedAt' }, { label: 'Closed', get: 'closedAt' },
  { label: 'Minutes', get: 'durationMin' }, { label: 'Peak ms', get: 'peakMs' }, { label: 'Peak x baseline', get: 'peakRatio' },
  { label: 'Max loss pct', get: 'lossMaxPct' }, { label: 'Baseline ms', get: 'baselineMedian' }, { label: 'Likely hop', get: 'likelyHop' },
];

// Episodes (GET /watch/episodes) in the shared table kit. `rows` is already
// narrowed by the band chip; search and the two dropdowns narrow further.
export default function LmEpisodesTable({ rows, onOpen, chipLabel, chip = '' }) {
  const [showClosed, setShowClosed] = useState(false);
  const closedChip = chip === 'oneoff' || chip === 'repeating';
  useEffect(() => { setShowClosed(false); }, [chip]);
  const closedCount = useMemo(() => (rows || []).filter((r) => r.state === 'closed').length, [rows]);
  const includeClosed = showClosed || closedChip;
  const list = useMemo(() => (rows || []).filter((r) => includeClosed || r.state !== 'closed').map((r) => ({ ...r, outcomeLabel: r.outcome ? (EPISODE_OUTCOME_LABEL[r.outcome] || r.outcome) : '' })), [rows, includeClosed]);
  const ctl = useTableControls(list, {
    searchKeys: ['checkName', 'label', 'siteKey', 'likelyHop'], defaultSortKey: 'openedAt', defaultSortDir: 'desc', paginate: true, defaultPageSize: 10, deepLink: false,
  });
  return (
    <SectionPanel icon={Eye} title={<span className="inline-flex items-center gap-1.5">Latency Episodes <WatchLegend /></span>}
      right={(
        <span className="flex items-center gap-2">
          {!closedChip && (
            <button type="button" onClick={() => setShowClosed((v) => !v)} data-testid="toggle-closed"
              className="px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40">
              {showClosed ? 'Hide closed' : `Show closed (${fmtNum(closedCount)})`}
            </button>
          )}
          <CsvExportButton filename="lm-latency-episodes" rows={ctl.rows} columns={CSV} />
        </span>
      )}
      blurb={`Every stretch where a check location ran above its hour-of-day baseline, last 7 days. A spike that clears on its own is a one-off and raises nothing; one that lasts, climbs or is severe becomes an issue.${chipLabel ? ` Showing: ${chipLabel}.` : ''}`}>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <TableSearch ctl={ctl} placeholder="Search check, location, site or hop..." />
        <FilterSelect ctl={ctl} k="state" rows={list} label="states" />
        <FilterSelect ctl={ctl} k="outcomeLabel" rows={list} label="outcomes" />
        <span className="text-[11px] text-ink-faint tnum ml-auto">{fmtNum(ctl.rows.length)} episode(s)</span>
      </div>
      {list.length === 0 ? <p className="text-sm text-ink-muted py-4 text-center">No episodes in this view.</p> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <SortTh k="checkName" label="Check" ctl={ctl} />
                <SortTh k="label" label="From" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="openedAt" label="Opened" ctl={ctl} />
                <SortTh k="durationMin" label="Minutes" ctl={ctl} align="right" />
                <SortTh k="peakMs" label="Peak" ctl={ctl} align="right" />
                <SortTh k="peakRatio" label="x Base" ctl={ctl} align="right" />
                <SortTh k="likelyHop" label="Likely hop" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => (
                  <tr key={r.id} data-testid="episode-row" className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => onOpen(r.id)}>
                    <td className="py-2 pr-3"><p className="text-ink truncate max-w-[220px]">{r.checkName}</p><p className="text-[10px] text-ink-faint">{r.kind === 'loss' ? 'packet loss' : 'latency'}{r.siteKey ? ` - ${r.siteKey}` : ''}</p></td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.label || '-'}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={EPISODE_STATE_TONE[r.state] || 'neutral'}>{r.state}</Badge>
                      {r.outcomeLabel && <span className="ml-1.5 text-[11px] text-ink-muted">{r.outcomeLabel}</span>}
                    </td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(r.openedAt)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.durationMin == null ? '-' : fmtNum(r.durationMin)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtMs(r.peakMs)}</td>
                    <td className={`py-2 pr-3 text-right tnum ${r.peakRatio >= 2 ? 'text-status-crit' : r.peakRatio >= 1.5 ? 'text-status-warn' : 'text-ink-faint'}`}>{r.peakRatio == null ? '-' : `${r.peakRatio}x`}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[180px]">{r.likelyHop || '-'}</td>
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
