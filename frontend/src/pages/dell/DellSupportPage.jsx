import { useEffect, useState, useCallback, useMemo } from 'react';
import { BadgeCheck, ShieldX, ShieldAlert, Shield, ShieldCheck, FileStack } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

// Tile buckets — predicates over days_remaining. `warn` upper bound comes from
// the configurable warranty threshold (Settings → Alert Thresholds).
const BUCKETS = (warnDays) => ([
  { key: 'all', label: 'Total Contracts', icon: FileStack, tone: 'brand', match: () => true,
    sub: 'all warranty records' },
  { key: 'expired', label: 'Expired', icon: ShieldX, tone: 'crit',
    match: (d) => d != null && d <= 0, sub: 'out of support today' },
  { key: 'warn', label: `Expiring ≤ ${warnDays}d`, icon: ShieldAlert, tone: 'warn',
    match: (d) => d != null && d > 0 && d <= warnDays, sub: 'inside the warning window' },
  { key: 'year', label: '≤ 1 Year', icon: Shield, tone: 'default',
    match: (d) => d != null && d > warnDays && d <= 365, sub: 'renewal planning horizon' },
  { key: 'beyond', label: '1+ Years', icon: ShieldCheck, tone: 'ok',
    match: (d) => d != null && d > 365, sub: 'covered beyond a year' },
]);

function Tile({ bucket, count, active, onClick }) {
  const Icon = bucket.icon;
  const toneColor = bucket.tone === 'crit' ? '#C75D5D' : bucket.tone === 'warn' ? '#D4A24E'
    : bucket.tone === 'ok' ? '#6CB33F' : bucket.tone === 'brand' ? BRAND : '#8FA3B0';
  return (
    <button onClick={onClick}
      className={`panel p-4 text-left transition-all cursor-pointer hover:-translate-y-0.5 ${active ? 'ring-2' : ''}`}
      style={{ borderTop: `3px solid ${toneColor}`, ...(active ? { '--tw-ring-color': toneColor } : {}) }}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] uppercase tracking-wide text-ink-faint">{bucket.label}</p>
        <Icon size={15} style={{ color: toneColor }} />
      </div>
      <p className="text-2xl font-bold tnum" style={{ color: active ? toneColor : undefined }}>{fmtNum(count)}</p>
      <p className="text-[11px] text-ink-faint mt-0.5">{bucket.sub}</p>
    </button>
  );
}

export default function DellSupportPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [bucketKey, setBucketKey] = useState('all');
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/dell/warranty')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ warnDays: 90, rows: [] }); toast({ type: 'error', title: 'Failed to load warranty data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const warnDays = data?.warnDays ?? 90;
  const rows = data?.rows || [];
  const buckets = useMemo(() => BUCKETS(warnDays), [warnDays]);
  const activeBucket = buckets.find((b) => b.key === bucketKey) || buckets[0];
  const filtered = useMemo(
    () => (bucketKey === 'all' ? rows : rows.filter((w) => activeBucket.match(w.days_remaining))),
    [rows, bucketKey, activeBucket]
  );

  const ctl = useTableControls(filtered, {
    searchKeys: ['service_tag', 'device_model', 'service_level', 'ome_name'],
    defaultSortKey: 'days_remaining', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={BadgeCheck} title="Support" description="Warranty and support-contract runway across the Dell estate — click a tile to filter">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        {buckets.map((b) => (
          <Tile key={b.key} bucket={b}
            count={b.key === 'all' ? rows.length : rows.filter((w) => b.match(w.days_remaining)).length}
            active={bucketKey === b.key}
            onClick={() => setBucketKey(bucketKey === b.key ? 'all' : b.key)} />
        ))}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">
          {activeBucket.key === 'all' ? 'All Contracts' : activeBucket.label}
          <span className="text-ink-faint font-normal"> · {fmtNum(filtered.length)} record(s)</span>
        </p>
        <TableControls ctl={ctl} rows={filtered} searchPlaceholder="Filter by service tag, model, service level…"
          filters={[
            { k: 'ome_name', label: 'OME instances' },
            { k: 'device_model', label: 'Models' },
            { k: 'service_level', label: 'Service levels' },
          ]} />
        {data == null ? (
          <LoadingPanel label="Loading warranty data…" height={160} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No warranty data — OME populates it after a warranty sync with Dell support.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No contracts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="service_tag" label="Service Tag" ctl={ctl} />
                <SortTh k="device_model" label="Model" ctl={ctl} />
                <SortTh k="service_level" label="Service Level" ctl={ctl} />
                <SortTh k="start_date" label="Starts" ctl={ctl} />
                <SortTh k="end_date" label="Ends" ctl={ctl} />
                <SortTh k="days_remaining" label="Days Left" ctl={ctl} align="right" />
                <SortTh k="ome_name" label="OME" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((w) => (
                  <tr key={w.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink tnum">{w.service_tag || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{w.device_model || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-xs max-w-[280px] truncate" title={w.service_level || ''}>{w.service_level || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{w.start_date ? String(w.start_date).slice(0, 10) : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{w.end_date ? String(w.end_date).slice(0, 10) : '—'}</td>
                    <td className={`py-2 pr-3 text-right tnum font-semibold ${w.days_remaining == null ? 'text-ink-faint' : w.days_remaining <= 0 ? 'text-status-crit' : w.days_remaining <= warnDays ? 'text-status-warn' : 'text-ink'}`}>
                      {w.days_remaining == null ? '—' : w.days_remaining <= 0 ? 'expired' : fmtNum(w.days_remaining)}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{w.ome_name}</td>
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
