import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTableControls, SortTh, TableControls, TablePager } from '../../../components/ui/tableTools';
import { fmtUsd } from '../helpers';
import { pct1, thCls } from './shared';

export const ESTIMATE_NOTE = 'Estimates. Each billed usage type is split across the inventory it names by weight (instance count, GB, bytes). Current inventory is applied to every day in the window. Resource-level billing data from AWS replaces this when enabled.';

export const KIND_LABELS = {
  ec2: 'EC2', ebs: 'EBS', s3: 'S3', rds: 'RDS', lightsail: 'Lightsail', lambda: 'Lambda', dynamo: 'DynamoDB', bedrock: 'Bedrock',
  'bedrock-model': 'Bedrock', 'lightsail-db': 'Lightsail DB', 'lightsail-disk': 'Lightsail disk', 'lightsail-lb': 'Lightsail LB', unattributed: 'Unattributed',
};
export const kindLabel = (k) => KIND_LABELS[k] || k || '-';

function TagChips({ tags }) {
  const entries = Object.entries(tags || {});
  if (entries.length === 0) return <span className="text-ink-faint">-</span>;
  const shown = entries.slice(0, 3);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map(([k, v]) => (
        <span key={k} className="chip bg-surface-overlay text-ink-muted border-cohesity-border text-[10px]" title={`${k}=${v}`}>{k}={String(v).slice(0, 24)}</span>
      ))}
      {entries.length > 3 && <span className="text-[10px] text-ink-faint self-center" title={entries.slice(3).map(([k, v]) => `${k}=${v}`).join(', ')}>+{entries.length - 3}</span>}
    </div>
  );
}

/** Estimated-resource table. rows come from GET /finops/resources; onRowClick(row) opens the drawer when given. */
export default function ResourceEstimateTable({ rows, onRowClick, showKind = true, emptyText = 'No estimated resource cost in this window.' }) {
  const data = useMemo(() => (rows || []).map((r) => ({
    ...r,
    servicesText: (r.services || []).join(' '),
    tagsText: Object.entries(r.tags || {}).map(([k, v]) => `${k}=${v}`).join(' '),
  })), [rows]);
  const ctl = useTableControls(data, {
    searchKeys: ['label', 'resourceId', 'resourceKind', 'servicesText', 'tagsText'],
    defaultSortKey: 'usd', defaultSortDir: 'desc', paginate: true,
    sortValues: { usd: (r) => r.usd ?? -Infinity, estMonthlyUsd: (r) => r.estMonthlyUsd ?? -Infinity, pct: (r) => r.pct ?? -Infinity },
  });
  return (
    <>
      <TableControls ctl={ctl} rows={data} searchPlaceholder="Filter by resource, service or tag..." />
      {data.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={thCls}>
              {showKind && <SortTh k="resourceKind" label="Kind" ctl={ctl} />}
              <SortTh k="label" label="Resource" ctl={ctl} />
              <SortTh k="servicesText" label="Services" ctl={ctl} />
              <th className="py-2 pr-3">Tags</th>
              <SortTh k="usd" label="Cost" ctl={ctl} align="right" />
              <SortTh k="estMonthlyUsd" label="Est. per month" ctl={ctl} align="right" />
              <SortTh k="pct" label="Share" ctl={ctl} align="right" />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={`${r.resourceKind}|${r.resourceId}`} onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={`border-b border-cohesity-border/50 ${onRowClick ? 'cursor-pointer hover:bg-surface-overlay/40' : ''}`}>
                  {showKind && <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{kindLabel(r.resourceKind)}</td>}
                  <td className="py-2 pr-3 text-ink" title={r.resourceId}>
                    {r.link ? <Link to={r.link} onClick={(e) => e.stopPropagation()} className="text-brand hover:underline">{r.label || r.resourceId}</Link> : (r.label || r.resourceId)}
                    {r.label && r.label !== r.resourceId && <span className="block text-[11px] text-ink-faint break-all">{r.resourceId}</span>}
                  </td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{(r.services || []).join(', ') || '-'}</td>
                  <td className="py-2 pr-3"><TagChips tags={r.tags} /></td>
                  <td className="py-2 pr-3 text-right tnum text-ink">{fmtUsd(r.usd)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.estMonthlyUsd != null ? fmtUsd(r.estMonthlyUsd) : '-'}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{pct1(r.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </>
  );
}
