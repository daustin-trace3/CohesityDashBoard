// NetBackup Storage — ports host frontend/src/pages/netbackup/NbStoragePage.jsx.
import {
  injectStyles, PageHeader, LoadingPanel, RefreshButton, LastUpdated, Badge,
  useTableControls, SortTh, TableControls, TablePager,
  HardDriveIcon, DbIcon,
} from '../ui.jsx';
import { DoughnutChart } from '../charts.jsx';
import { BRAND, fmtNum, fmtBytes, apiGet } from './helpers.js';

injectStyles();

function UsageBar({ pct }) {
  if (pct == null) return <span style={{ color: 'var(--nb-ink-faint)', fontSize: 11 }}>—</span>;
  const color = pct > 90 ? 'var(--nb-crit)' : pct > 80 ? 'var(--nb-warn)' : 'var(--nb-brand)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 100 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--nb-surface-overlay)', overflow: 'hidden' }}>
        <div style={{ height: '100%', background: color, width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="nb-tnum" style={{ fontSize: 11, color: 'var(--nb-ink-muted)', width: 36, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function NbStoragePage() {
  const [units, setUnits] = React.useState(null);
  const [pools, setPools] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiGet('/storage')
    .then((d) => { setUnits(d.storageUnits || []); setPools(d.diskPools || []); setLastRefreshed(new Date()); })
    .catch(() => { setUnits([]); setPools([]); }), []);

  React.useEffect(() => { load(); }, [load]);

  const unitList = (units || []).map((u) => ({ ...u, usedPct: u.capacityBytes > 0 && u.usedBytes != null ? (u.usedBytes / u.capacityBytes) * 100 : null }));
  const poolList = (pools || []).map((p) => ({ ...p, usedPct: p.totalCapacityBytes > 0 && p.usedCapacityBytes != null ? (p.usedCapacityBytes / p.totalCapacityBytes) * 100 : null }));

  const poolTypeRollup = React.useMemo(() => {
    const byType = new Map();
    for (const p of poolList) {
      const type = p.serverType || 'Unknown';
      if (!byType.has(type)) byType.set(type, { type, pools: 0, total: 0, used: 0 });
      const t = byType.get(type);
      t.pools += 1;
      t.total += p.totalCapacityBytes || 0;
      t.used += p.usedCapacityBytes || 0;
    }
    return [...byType.values()].map((t) => ({ ...t, usedPct: t.total > 0 ? (t.used / t.total) * 100 : null })).sort((a, b) => b.total - a.total);
  }, [poolList]);

  const unitCtl = useTableControls(unitList, { searchKeys: ['name', 'sourceName'], defaultSortKey: 'name', paginate: true });
  const poolCtl = useTableControls(poolList, { searchKeys: ['name', 'sourceName'], defaultSortKey: 'name', paginate: true });

  const totals = React.useMemo(() => {
    const capacity = unitList.reduce((n, u) => n + (u.capacityBytes || 0), 0) + poolList.reduce((n, p) => n + (p.totalCapacityBytes || 0), 0);
    const used = unitList.reduce((n, u) => n + (u.usedBytes || 0), 0) + poolList.reduce((n, p) => n + (p.usedCapacityBytes || 0), 0);
    return { capacity, used };
  }, [unitList, poolList]);

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={HardDriveIcon} title="Storage" description="Storage units and disk pools across all registered NetBackup sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={units == null} />
      </PageHeader>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="nb-st-row">
        <style>{`@media (min-width: 1024px) { .nb-st-row { grid-template-columns: 2fr 1fr !important; } }`}</style>
        <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Storage Units</p>
          <TableControls ctl={unitCtl} rows={unitList} searchPlaceholder="Filter by unit or source…" filters={[{ k: 'storageUnitType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
          {units == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : unitList.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No storage units found — register a NetBackup source under Settings.</div>
          ) : unitCtl.rows.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No storage units match your filters.</div>
          ) : (
            <div className="nb-scroll" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                  <SortTh k="name" label="Name" ctl={unitCtl} />
                  <SortTh k="storageUnitType" label="Type" ctl={unitCtl} />
                  <SortTh k="diskPool" label="Disk Pool" ctl={unitCtl} />
                  <SortTh k="mediaServer" label="Media Server" ctl={unitCtl} />
                  <SortTh k="maxConcurrentJobs" label="Max Jobs" ctl={unitCtl} align="right" />
                  <SortTh k="usedPct" label="Used" ctl={unitCtl} align="right" />
                </tr></thead>
                <tbody>
                  {unitCtl.pageRows.map((u) => (
                    <tr key={u.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>{u.name}</td>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{u.storageUnitType || '—'}</td>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{u.diskPool || '—'}</td>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{u.mediaServer || '—'}</td>
                      <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(u.maxConcurrentJobs)}</td>
                      <td style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}><UsageBar pct={u.usedPct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={unitCtl} />
        </div>
        <div className="nb-panel" style={{ padding: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Used vs Free</p>
          {units == null || pools == null ? (
            <LoadingPanel label="Loading…" height={200} />
          ) : totals.capacity === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No capacity data yet.</div>
          ) : (
            <DoughnutChart labels={['Used', 'Free']} values={[totals.used, Math.max(0, totals.capacity - totals.used)]} colors={['#F59E0B', '#22C55E']} height={200} />
          )}
        </div>
      </div>

      {poolTypeRollup.length > 0 && (
        <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <DbIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Capacity by Pool Type
          </p>
          <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginBottom: 12, lineHeight: 1.5 }}>
            Usable (formatted) pool capacity as reported by NetBackup — not raw disk, and for deduplicating pools (MSDP, OST) post-dedup consumption, not front-end protected data.
          </p>
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Pool Type</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Pools</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Used</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Capacity</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Free</th>
                <th style={{ padding: '8px 0', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)', width: 220 }}>Usage</th>
              </tr></thead>
              <tbody>
                {poolTypeRollup.map((t) => (
                  <tr key={t.type} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)', fontWeight: 500 }}>{t.type}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{t.pools}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink)' }}>{fmtBytes(t.used)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtBytes(t.total)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtBytes(Math.max(0, t.total - t.used))}</td>
                    <td style={{ padding: '8px 0' }}><UsageBar pct={t.usedPct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <DbIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Disk Pools
        </p>
        <TableControls ctl={poolCtl} rows={poolList} searchPlaceholder="Filter by pool or source…" filters={[{ k: 'serverType', label: 'Pool Types' }, { k: 'status', label: 'Statuses' }, { k: 'sourceName', label: 'Sources' }]} />
        {pools == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : poolList.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No disk pools found.</div>
        ) : poolCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No disk pools match your filters.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <SortTh k="name" label="Name" ctl={poolCtl} />
                <SortTh k="serverType" label="Server Type" ctl={poolCtl} />
                <SortTh k="status" label="Status" ctl={poolCtl} />
                <SortTh k="volumeCount" label="Volumes" ctl={poolCtl} align="right" />
                <SortTh k="usedPct" label="Used" ctl={poolCtl} align="right" />
                <SortTh k="sourceName" label="Source" ctl={poolCtl} />
              </tr></thead>
              <tbody>
                {poolCtl.pageRows.map((p) => (
                  <tr key={p.id} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>{p.name}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{p.serverType || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={p.status && p.status.toLowerCase() !== 'up' ? 'warn' : 'ok'}>{p.status || 'Unknown'}</Badge></td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(p.volumeCount)}</td>
                    <td style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}><UsageBar pct={p.usedPct} /></td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{p.sourceName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={poolCtl} />
      </div>
    </div>
  );
}
