// Shared pieces for the Voice, Zscaler and Identity Services pages (round 11, lm11-sections).
import { useMemo } from 'react';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';
import { DASH, fmtNum, fmtPct, stateTone, stateLabel, stateRank } from './helpers';
import { headRow, SectionPanel } from './ui';
import { DeviceDatasourcesTab } from './LmRawDatasources';

export const numOf = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Percent cell: dash for null, amber from `warn`. */
export function PctCell({ v, warn = 85 }) {
  const n = numOf(v);
  return <span className={`tnum ${n != null && n >= warn ? 'text-status-warn' : 'text-ink-muted'}`}>{n == null ? DASH : fmtPct(n)}</span>;
}

/** Count cell with a bad count in amber, for example "4 / 1 bad". */
export function CountBad({ total, bad }) {
  if (total == null) return <span className="text-ink-faint">{DASH}</span>;
  return (
    <span className="tnum text-ink-muted">
      {fmtNum(total)}{bad ? <span className="text-status-warn">{` (${fmtNum(bad)} bad)`}</span> : null}
    </span>
  );
}

/** Raw state value next to its meaning; the enum is unverified so the number always shows. */
export function RawState({ raw, ok, label, badTone = 'warn' }) {
  if (raw == null) return <span className="text-ink-faint">{DASH}</span>;
  return (
    <span title={`Raw value ${raw}. The enum is unverified until the first live poll.`}>
      <Badge tone={ok === false ? badTone : ok === true ? 'ok' : 'neutral'}>{label || `Raw ${fmtNum(raw)}`}</Badge>
    </span>
  );
}

export const StateBadge = ({ state }) => <Badge tone={stateTone(state)}>{stateLabel(state)}</Badge>;

/**
 * Sortable, paged table over rows. columns: [{ k, label, align, render(row), sortValue(row) }].
 * Rows sort worst state first unless defaultSortKey says otherwise.
 */
export function ServiceTable({ rows, columns, onOpen, rowKey, defaultSortKey = 'stateRank', pageSize = 10 }) {
  const list = useMemo(() => (rows || []).map((r) => ({ ...r, stateRank: stateRank(r.state) })), [rows]);
  const sortValues = useMemo(() => Object.fromEntries(columns.filter((c) => c.sortValue).map((c) => [c.k, c.sortValue])), [columns]);
  const ctl = useTableControls(list, { defaultSortKey, defaultSortDir: defaultSortKey === 'stateRank' ? 'desc' : 'asc', sortValues, paginate: true, defaultPageSize: pageSize, deepLink: false });
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            {columns.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((r) => (
              <tr key={rowKey(r)} className={`border-b border-cohesity-border/50 ${onOpen ? 'cursor-pointer hover:bg-surface-overlay' : ''}`} onClick={onOpen ? () => onOpen(r) : undefined}>
                {columns.map((c, i) => (
                  <td key={c.k} className={`py-2 pr-3 text-[12px] ${c.align === 'right' ? 'text-right' : ''} ${i === 0 ? 'text-ink' : 'text-ink-muted'}`}>{c.render ? c.render(r) : (r[c.k] ?? DASH)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} sizes={[pageSize, 25, 50, 'all']} />
    </>
  );
}

/** Raw datapoints section of a 360 modal: the stored lm_ds_values of every DataSource on the device. */
export function RawDatapointsSection({ deviceId, sourceId }) {
  return (
    <SectionPanel title="Raw datapoints" blurb="Every datapoint ICC stored for this device, including DataSources the catalog does not label yet. Pick a DataSource to read its values.">
      <DeviceDatasourcesTab deviceId={deviceId} sourceId={sourceId} />
    </SectionPanel>
  );
}
