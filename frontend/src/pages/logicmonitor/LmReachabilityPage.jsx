import { useEffect, useState, useCallback, useMemo } from 'react';
import { Radar, Grid3x3, TrendingDown, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { fmtNum, fmtMs, fmtPct, fmtWhen, anomalyTone, TONE_COLOR, useVisibleInterval, blameText } from './helpers';
import { SectionPanel, headRow, chipBtn } from './ui';
import LmCheckHistoryModal from './LmCheckHistoryModal';

const REFRESH_MS = 60000;

const ANOMALY_RANK = { down: 3, loss: 2, latency: 1 };

function cellTone(c) {
  if (!c) return 'neutral';
  return anomalyTone(c.anomaly, c.status);
}

function CellBox({ cell, onClick }) {
  if (!cell) return <div className="h-9 rounded bg-surface-overlay/40" title="Not checked from this location" />;
  const tone = cellTone(cell);
  const color = TONE_COLOR[tone];
  return (
    <button type="button" onClick={onClick}
      title={`RTT ${fmtMs(cell.rttAvgMs)}, loss ${fmtPct(cell.lossPct, 1)}${cell.anomaly ? `, anomaly ${cell.anomaly}` : ''}${blameText(cell.blame) ? `, via ${blameText(cell.blame)}` : ''}`}
      className="h-9 w-full rounded flex flex-col items-center justify-center cursor-pointer hover:ring-1 hover:ring-brand/60 transition"
      style={{ background: `${color}26`, borderLeft: `3px solid ${color}` }}>
      <span className="text-[11px] tnum text-ink leading-none">{cell.rttAvgMs == null ? '-' : Math.round(cell.rttAvgMs)}</span>
      {cell.lossPct ? <span className="text-[9px] tnum text-status-crit leading-none mt-0.5">{Number(cell.lossPct).toFixed(0)}% loss</span> : null}
    </button>
  );
}

export default function LmReachabilityPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState(null); // { check, location }

  const load = useCallback(() => client.get('/logicmonitor/checks')
    .then(({ data: d }) => { setData({ items: d?.items || [], matrix: d?.matrix || { rows: [], cols: [], cells: [] }, counts: d?.counts || {} }); setLastRefreshed(new Date()); })
    .catch(() => { setData((cur) => cur || { items: [], matrix: { rows: [], cols: [], cells: [] }, counts: {} }); toast({ type: 'error', title: 'Failed to load reachability checks' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const items = useMemo(() => data?.items || [], [data]);
  const byId = useMemo(() => new Map(items.map((c) => [String(c.checkId), c])), [items]);

  // Matrix cells: row is the checkpoint label, col is the checkId (WP6
  // confirmed). Numbers are accepted as indexes too, to survive a change.
  const matrix = useMemo(() => {
    const m = data?.matrix || { rows: [], cols: [], cells: [] };
    const rows = m.rows || [];
    const cols = (m.cols || []).filter((c) => !kind || byId.get(String(c.checkId))?.kind === kind);
    const map = new Map();
    for (const cell of m.cells || []) {
      const row = typeof cell.row === 'number' ? rows[cell.row] : cell.row;
      const col = typeof cell.col === 'number' ? m.cols?.[cell.col]?.checkId : cell.col;
      const loc = cell.blame ? null : byId.get(String(col))?.locations?.find((l) => l.label === row);
      map.set(`${row}|${col}`, loc?.blame ? { ...cell, blame: loc.blame } : cell);
    }
    return { rows, cols, map };
  }, [data, kind, byId]);

  const openCell = (rowLabel, checkId) => {
    const check = byId.get(String(checkId));
    const location = check?.locations?.find((l) => l.label === rowLabel);
    if (check && location) setOpen({ check, location });
  };

  const links = useMemo(() => items
    .filter((c) => !kind || c.kind === kind)
    .flatMap((c) => (c.locations || []).map((l) => ({
      key: `${c.checkId}|${l.checkpointId}`,
      check: c, location: l,
      name: c.name, target: c.target, kind: c.kind, label: l.label, isOverall: l.isOverall,
      status: l.lastStatus, anomaly: l.anomaly, rttAvgMs: l.rttAvgMs, baselineRttMs: l.baselineRttMs,
      lossPct: l.lossPct, responseMs: l.responseMs, sampleAt: l.sampleAt, blame: l.blame,
      ratio: l.rttAvgMs != null && l.baselineRttMs ? l.rttAvgMs / l.baselineRttMs : null,
      rank: (ANOMALY_RANK[l.anomaly] || 0) * 10 + (String(l.lastStatus).toLowerCase() === 'down' ? 30 : 0),
    }))), [items, kind]);

  const ctl = useTableControls(links, {
    searchKeys: ['name', 'target', 'label'], defaultSortKey: 'rank', defaultSortDir: 'desc', paginate: true,
    sortValues: { rank: (r) => r.rank * 1000 + (r.ratio || 0) },
  });

  const csv = [
    { label: 'Check', get: 'name' }, { label: 'Target', get: 'target' }, { label: 'Kind', get: 'kind' },
    { label: 'From', get: 'label' }, { label: 'Status', get: 'status' }, { label: 'Anomaly', get: (r) => r.anomaly || '' },
    { label: 'RTT ms', get: 'rttAvgMs' }, { label: 'Baseline RTT ms', get: 'baselineRttMs' }, { label: 'Loss pct', get: 'lossPct' },
    { label: 'Response ms', get: 'responseMs' }, { label: 'Likely hop', get: (r) => blameText(r.blame) }, { label: 'Sample', get: 'sampleAt' },
  ];

  const counts = data?.counts || {};

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Radar} title="Site Reachability" description="Ping and web checks from every collector and LM location, against an hour-of-day baseline">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Radar} label="Checks" value={fmtNum(counts.total)} loading={!data} />
        <StatCard icon={CheckCircle2} label="OK" value={fmtNum(counts.ok)} tone="ok" loading={!data} />
        <StatCard icon={AlertTriangle} label="Degraded" value={fmtNum(counts.degraded)} tone={counts.degraded ? 'warn' : 'ok'} loading={!data} />
        <StatCard icon={XCircle} label="Down" value={fmtNum(counts.down)} tone={counts.down ? 'crit' : 'ok'} loading={!data} />
      </div>

      <div className="flex items-center gap-1 mb-3">
        {[['', 'All checks'], ['ping', 'Ping'], ['web', 'Web']].map(([v, l]) => <button key={v || 'all'} onClick={() => setKind(v)} className={chipBtn(kind === v)}>{l}</button>)}
      </div>

      {!data ? <LoadingPanel label="Loading checks..." height={220} /> : items.length === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">No ping or web checks found on the connected portals.</div>
      ) : (
        <div className="flex flex-col gap-4">
          <SectionPanel icon={Grid3x3} title="Location x Check Matrix"
            blurb="Each cell is the latest round trip time (ms) from one checkpoint to one check target. Amber is a latency or loss anomaly against the baseline for this hour of day, red is down. Click a cell for its history.">
            {matrix.cols.length === 0 ? <p className="text-sm text-ink-muted py-3 text-center">No checks of this kind.</p> : (
              <div className="overflow-x-auto">
                <table className="text-sm border-separate" style={{ borderSpacing: 3 }}>
                  <thead>
                    <tr>
                      <th className="text-left text-[10px] uppercase tracking-wide text-ink-faint pr-2 sticky left-0 bg-surface">From \ To</th>
                      {matrix.cols.map((c) => (
                        <th key={c.checkId} className="text-[10px] font-semibold text-ink-muted align-bottom min-w-[72px] max-w-[110px]">
                          <span className="block truncate" title={c.name}>{c.name}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((row) => (
                      <tr key={row}>
                        <td className="text-xs text-ink pr-2 whitespace-nowrap sticky left-0 bg-surface">{row}</td>
                        {matrix.cols.map((c) => (
                          <td key={c.checkId}><CellBox cell={matrix.map.get(`${row}|${c.checkId}`)} onClick={() => openCell(row, c.checkId)} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionPanel>

          <SectionPanel icon={TrendingDown} title="Worst Links" right={<CsvExportButton filename="lm-reachability-links" rows={ctl.rows} columns={csv} />}
            blurb="Every check and location, worst first: down, then loss, then latency anomalies, then by how far RTT sits above its baseline.">
            <div className="flex items-center gap-2 mb-3">
              <TableSearch ctl={ctl} placeholder="Search check, target or location..." />
              <span className="text-[11px] text-ink-faint tnum ml-auto">{fmtNum(ctl.rows.length)} link(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="name" label="Check" ctl={ctl} />
                  <SortTh k="label" label="From" ctl={ctl} />
                  <SortTh k="rank" label="State" ctl={ctl} />
                  <SortTh k="rttAvgMs" label="RTT" ctl={ctl} align="right" />
                  <SortTh k="baselineRttMs" label="Baseline" ctl={ctl} align="right" />
                  <SortTh k="ratio" label="x Base" ctl={ctl} align="right" />
                  <SortTh k="lossPct" label="Loss" ctl={ctl} align="right" />
                  <SortTh k="sampleAt" label="Sample" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={r.key} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen({ check: r.check, location: r.location })}>
                      <td className="py-2 pr-3"><p className="text-ink truncate max-w-[240px]">{r.name}</p><p className="text-[10px] text-ink-faint truncate max-w-[240px]">{r.target} - {r.kind}</p></td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.label}{r.isOverall ? <Badge tone="neutral" className="ml-1">Overall</Badge> : null}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={anomalyTone(r.anomaly, r.status)}>{r.anomaly || r.status || 'unknown'}</Badge>
                        {blameText(r.blame) && <p className="text-[10px] text-ink-faint mt-0.5 max-w-[240px]" title="Likely hop on the path">via {blameText(r.blame)}</p>}
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtMs(r.kind === 'web' ? (r.responseMs ?? r.rttAvgMs) : r.rttAvgMs)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMs(r.baselineRttMs)}</td>
                      <td className={`py-2 pr-3 text-right tnum ${r.ratio >= 2 ? 'text-status-crit' : r.ratio >= 1.5 ? 'text-status-warn' : 'text-ink-faint'}`}>{r.ratio == null ? '-' : `${r.ratio.toFixed(1)}x`}</td>
                      <td className={`py-2 pr-3 text-right tnum ${r.lossPct ? 'text-status-crit' : 'text-ink-faint'}`}>{fmtPct(r.lossPct, 1)}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(r.sampleAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </SectionPanel>
        </div>
      )}

      {open && <LmCheckHistoryModal check={open.check} location={open.location} onClose={() => setOpen(null)} />}
    </div>
  );
}
