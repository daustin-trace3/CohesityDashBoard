// Raw DataSource store views (round 11, WP-R): the Device 360 DataSources tab, the
// Data Export "Raw collection" group and the Coverage "Catalog coverage" tile. All three
// read the lm_ds_values / lm_ds_datapoints routes; nothing here assumes a datapoint name.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Download, Trash2, Plus } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { DASH, arr, fmtNum, fmtWhen, downloadCsv } from './helpers';
import { Modal, ServerPager, inp, btnGhost, btnPrimary, headRow } from './ui';

export const rawRuleLink = (datasource, datapoint) => {
  const q = new URLSearchParams({ section: 'rawrules' });
  if (datasource) q.set('datasource', datasource);
  if (datapoint) q.set('datapoint', datapoint);
  return `/logicmonitor/settings?${q.toString()}`;
};
const pctText = (v) => (v == null ? DASH : `${v}%`);
const valueText = (r) => {
  if (r.value != null) {
    const v = Number(r.value);
    const shown = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(+v.toFixed(3));
    return r.unit ? `${shown} ${r.unit}` : shown;
  }
  return r.valueText == null || r.valueText === '' ? DASH : r.valueText;
};

/** Server-paged values for one device DataSource, searchable across instance and datapoint. */
function ValuesTable({ deviceId, sourceId, ds, onBack }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1); }, 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    setData(null);
    setError(false);
    const params = { page, limit: pageSize === 'all' ? 'all' : pageSize };
    if (term) params.q = term;
    if (sourceId) params.sourceId = sourceId;
    client.get(`/logicmonitor/devices/${deviceId}/datasources/${ds.hdsId}/values`, { params })
      .then(({ data: d }) => setData(d || { items: [], total: 0 }))
      .catch(() => setError(true));
  }, [deviceId, sourceId, ds.hdsId, page, pageSize, term]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <button onClick={onBack} className="text-[11px] text-brand hover:underline cursor-pointer">All DataSources</button>
        <span className="text-xs font-semibold text-ink">{ds.displayName}</span>
        {ds.displayName !== ds.datasourceName && <span className="text-[10px] text-ink-faint font-mono">{ds.datasourceName}</span>}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search instance or datapoint..." className={`${inp} max-w-[260px] ml-auto`} spellCheck={false} />
      </div>
      {error ? <p className="text-sm text-status-crit py-6 text-center">Failed to load the stored values.</p>
        : data == null ? <LoadingPanel label="Loading values..." height={160} /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <th className="py-2 pr-3">Instance</th><th className="py-2 pr-3">Datapoint</th>
                  <th className="py-2 pr-3 text-right">Value</th><th className="py-2 pr-3">Catalog</th><th className="py-2 pr-3">Sampled</th><th className="py-2 pr-3">Rule</th>
                </tr></thead>
                <tbody>
                  {arr(data.items).map((r) => (
                    <tr key={`${r.instanceKey}|${r.datapoint}`} className="border-b border-cohesity-border/40">
                      <td className="py-1.5 pr-3 text-[12px] text-ink truncate max-w-[260px]" title={r.instanceKey}>{r.instanceName || r.instanceKey}</td>
                      <td className="py-1.5 pr-3 text-[12px] text-ink-muted font-mono">{r.datapoint}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted whitespace-nowrap">{valueText(r)}</td>
                      <td className="py-1.5 pr-3 text-[12px] text-ink-faint">{r.catalogMetric ? (r.label || r.catalogMetric) : DASH}</td>
                      <td className="py-1.5 pr-3 text-[11px] text-ink-faint whitespace-nowrap">{r.sampledAt ? fmtWhen(r.sampledAt) : DASH}</td>
                      <td className="py-1.5 pr-3 text-[11px] whitespace-nowrap">
                        {r.value != null
                          ? <Link to={rawRuleLink(ds.datasourceName, r.datapoint)} className="text-brand hover:underline" title="Raise an issue from this datapoint">Rule</Link>
                          : <span className="text-ink-faint">-</span>}
                      </td>
                    </tr>
                  ))}
                  {arr(data.items).length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-sm text-ink-muted">No stored values{term ? ' match that search' : ' yet. The raw tier has not read this DataSource'}.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <ServerPager shown={arr(data.items).length} total={data.total || 0} page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} noun="value(s)" />
          </>
        )}
    </div>
  );
}

/** Device 360 "DataSources" tab: every DataSource on the device, click one for its values. */
export function DeviceDatasourcesTab({ deviceId, sourceId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    setRows(null);
    setError(false);
    setOpen(null);
    const params = sourceId ? { sourceId } : {};
    client.get(`/logicmonitor/devices/${deviceId}/datasources`, { params })
      .then(({ data }) => setRows(arr(data)))
      .catch(() => setError(true));
  }, [deviceId, sourceId]);

  const ctl = useTableControls(rows || [], {
    searchKeys: ['datasourceName', 'displayName', 'family'], defaultSortKey: 'datasourceName', paginate: true, defaultPageSize: 25, deepLink: false,
  });

  if (error) return <p className="text-sm text-status-crit py-6 text-center">Failed to load the DataSources.</p>;
  if (rows == null) return <LoadingPanel label="Loading DataSources..." height={160} />;
  if (open) return <ValuesTable deviceId={deviceId} sourceId={sourceId} ds={open} onBack={() => setOpen(null)} />;
  if (!rows.length) return <p className="text-sm text-ink-muted py-6 text-center">No DataSources are recorded for this device yet. The inventory poll fills them in.</p>;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <TableSearch ctl={ctl} placeholder="Search DataSource or family..." />
        <span className="text-[11px] text-ink-faint ml-auto">{fmtNum(ctl.rows.length)} DataSource(s)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            <SortTh k="datasourceName" label="DataSource" ctl={ctl} />
            <SortTh k="family" label="Family" ctl={ctl} />
            <SortTh k="instanceCount" label="Instances" ctl={ctl} align="right" />
            <SortTh k="datapoints" label="Datapoints" ctl={ctl} align="right" />
            <SortTh k="coveragePct" label="Coverage" ctl={ctl} align="right" />
            <SortTh k="rawLastAt" label="Last raw" ctl={ctl} />
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((r) => (
              <tr key={r.hdsId} onClick={() => r.datapoints > 0 && setOpen(r)}
                className={`border-b border-cohesity-border/40 ${r.datapoints > 0 ? 'cursor-pointer hover:bg-surface-overlay/60' : ''}`}>
                <td className="py-1.5 pr-3 text-[12px] text-ink">
                  <span className="truncate max-w-[320px] inline-block align-bottom" title={r.datasourceName}>{r.displayName}</span>
                  {r.displayName !== r.datasourceName && <span className="ml-2 text-[10px] text-ink-faint font-mono">{r.datasourceName}</span>}
                </td>
                <td className="py-1.5 pr-3 text-[12px]">{r.family ? <Badge tone="info">{r.family}</Badge> : (r.isInterface ? <Badge tone="neutral">interfaces</Badge> : r.isNeighbor ? <Badge tone="neutral">neighbours</Badge> : <span className="text-ink-faint">raw only</span>)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.instanceCount)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{r.datapoints ? fmtNum(r.datapoints) : DASH}</td>
                <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{pctText(r.coveragePct)}</td>
                <td className="py-1.5 pr-3 text-[11px] text-ink-faint whitespace-nowrap" title={r.rawLastError || undefined}>
                  {r.rawLastError ? <span className="text-status-warn">{r.rawLastError}</span> : (r.rawLastAt ? fmtWhen(r.rawLastAt) : DASH)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} sizes={[25, 50, 100, 'all']} />
    </div>
  );
}

/** Datapoint names and shapes for one DataSource across the estate. */
export function DatapointsModal({ name, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    client.get(`/logicmonitor/datasources/${encodeURIComponent(name)}/datapoints`)
      .then(({ data }) => setRows(arr(data))).catch(() => setRows([]));
  }, [name]);
  return (
    <Modal icon={Layers} title={name} subtitle="Datapoints stored from the portal, with up to three sample values" onClose={onClose} width="max-w-4xl">
      {rows == null ? <LoadingPanel label="Loading datapoints..." height={140} /> : rows.length === 0 ? (
        <p className="text-sm text-ink-muted py-6 text-center">No datapoints stored for this DataSource yet.</p>
      ) : (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <th className="py-2 pr-3">Datapoint</th><th className="py-2 pr-3 text-right">Devices</th><th className="py-2 pr-3 text-right">Instances</th>
              <th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Catalog metric</th><th className="py-2 pr-3">Samples</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.datapoint} className="border-b border-cohesity-border/40">
                  <td className="py-1.5 pr-3 text-[12px] text-ink font-mono">{r.datapoint}</td>
                  <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.devices)}</td>
                  <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.instances)}</td>
                  <td className="py-1.5 pr-3 text-[12px] text-ink-muted">{r.numeric ? 'number' : 'text'}</td>
                  <td className="py-1.5 pr-3 text-[12px]">{r.catalogMetric ? <Badge tone="ok">{r.catalogMetric}</Badge> : <span className="text-ink-faint">not in catalog</span>}</td>
                  <td className="py-1.5 pr-3 text-[11px] text-ink-faint truncate max-w-[260px]" title={arr(r.samples).join(', ')}>{arr(r.samples).join(', ') || DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function SourceRawSettings({ source, onSaved }) {
  const { toast } = useToast();
  const [calls, setCalls] = useState(String(source.rawCallsPerTick ?? 600));
  const [pair, setPair] = useState('');
  const [busy, setBusy] = useState(false);
  const history = arr(source.rawHistory);

  const save = async (patch, okTitle) => {
    setBusy(true);
    try {
      await client.put(`/logicmonitor/sources/${source.id}`, patch);
      toast({ type: 'success', title: okTitle });
      onSaved();
    } catch (e) {
      toast({ type: 'error', title: 'Could not save', message: e?.response?.data?.error || 'Check the values and try again.' });
    } finally { setBusy(false); }
  };
  const addPair = () => {
    const v = pair.trim();
    if (!/^[^:]+:[^:].*$/.test(v)) { toast({ type: 'error', title: 'Use DataSource:datapoint' }); return; }
    if (history.includes(v)) { setPair(''); return; }
    save({ rawHistory: [...history, v] }, 'History added').then(() => setPair(''));
  };

  return (
    <div className="rounded-lg border border-cohesity-border p-3 mb-3">
      <div className="flex items-center gap-3 flex-wrap">
        <p className="text-xs font-semibold text-ink">{source.name}</p>
        <label className="flex items-center gap-2 text-[12px] text-ink-muted cursor-pointer">
          <input type="checkbox" checked={!!source.rawPollEnabled} disabled={busy}
            onChange={(e) => save({ rawPollEnabled: e.target.checked }, e.target.checked ? 'Raw collection on' : 'Raw collection off')} />
          Collect every DataSource
        </label>
        <label className="flex items-center gap-2 text-[12px] text-ink-muted">
          Calls per run
          <input type="number" min={50} max={3000} value={calls} onChange={(e) => setCalls(e.target.value)} className={`${inp} w-24`} />
          <button className={btnGhost} disabled={busy || Number(calls) === Number(source.rawCallsPerTick) || !(Number(calls) >= 50 && Number(calls) <= 3000)}
            onClick={() => save({ rawCallsPerTick: Number(calls) }, 'Calls per run saved')}>Save</button>
        </label>
      </div>
      <p className="text-[11px] text-ink-faint mt-1">
        Raw collection reads each DataSource once per sweep and keeps the latest value of every datapoint. History is off by default; add a DataSource:datapoint pair to keep a series for it.
      </p>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <input value={pair} onChange={(e) => setPair(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addPair(); }}
          placeholder="DataSource:datapoint" className={`${inp} max-w-[320px]`} spellCheck={false} />
        <button className={btnPrimary} disabled={busy || !pair.trim()} onClick={addPair}><Plus size={12} className="inline mr-1" />Keep history</button>
      </div>
      {history.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {history.map((h) => (
            <span key={h} className="inline-flex items-center gap-1 rounded-lg border border-cohesity-border px-2 py-1 text-[11px] text-ink-muted font-mono">
              {h}
              <button disabled={busy} aria-label={`Stop keeping history for ${h}`} className="text-ink-faint hover:text-status-crit cursor-pointer"
                onClick={() => save({ rawHistory: history.filter((x) => x !== h) }, 'History removed')}><Trash2 size={11} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings > Data > Data Export: the "Raw collection" group. */
export function RawCollectionGroup({ raw }) {
  const { toast } = useToast();
  const [sources, setSources] = useState(null);
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    client.get('/logicmonitor/sources').then(({ data }) => setSources(arr(data))).catch(() => setSources([]));
    client.get('/logicmonitor/datasources').then(({ data }) => setRows(arr(data))).catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const ctl = useTableControls(rows || [], {
    searchKeys: ['name', 'displayName', 'family'], defaultSortKey: 'instances', defaultSortDir: 'desc', paginate: true, defaultPageSize: 25, deepLink: false,
  });
  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/logicmonitor/datasources.csv', {}, 'logicmonitor-datasources'); } catch { toast({ type: 'error', title: 'Export failed' }); } finally { setExporting(false); }
  };

  return (
    <div className="mt-4 pt-4 border-t border-cohesity-border">
      <p className="text-sm font-semibold text-ink mb-1">Raw collection</p>
      {raw && (
        <p className="text-[12px] text-ink-muted mb-3">
          {raw.enabled ? 'On' : 'Off'}. {fmtNum(raw.candidates)} DataSource(s) with data, {fmtNum(raw.callsPerTick)} calls per run,
          {' '}{fmtNum(raw.sweptLast24h)} read in the last 24 hours, a full sweep takes about {raw.estSweepHours == null ? DASH : raw.estSweepHours} hour(s).
          {' '}{fmtNum(raw.values)} values stored across {fmtNum(raw.datapoints)} datapoint(s), {pctText(raw.coveragePct)} of them labelled by the catalog.
        </p>
      )}
      {sources == null ? <LoadingPanel label="Loading portals..." height={80} /> : sources.map((s) => <SourceRawSettings key={s.id} source={s} onSaved={load} />)}
      <div className="flex items-center gap-2 mb-2 mt-3">
        <p className="text-xs font-semibold text-ink">DataSources in the estate</p>
        <TableSearch ctl={ctl} placeholder="Search DataSource or family..." className="max-w-[260px] ml-auto" />
        <button className={btnGhost} disabled={exporting} onClick={exportCsv}><Download size={12} className="inline mr-1" />{exporting ? 'Exporting...' : 'CSV'}</button>
      </div>
      {rows == null ? <LoadingPanel label="Loading DataSources..." height={120} /> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <SortTh k="name" label="DataSource" ctl={ctl} />
                <SortTh k="devices" label="Devices" ctl={ctl} align="right" />
                <SortTh k="instances" label="Instances" ctl={ctl} align="right" />
                <SortTh k="datapoints" label="Datapoints" ctl={ctl} align="right" />
                <SortTh k="family" label="Family" ctl={ctl} />
                <SortTh k="coveragePct" label="Coverage" ctl={ctl} align="right" />
                <SortTh k="rawLastAt" label="Last raw" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => (
                  <tr key={r.name} onClick={() => setOpen(r.name)} className="border-b border-cohesity-border/40 cursor-pointer hover:bg-surface-overlay/60">
                    <td className="py-1.5 pr-3 text-[12px] text-ink truncate max-w-[300px]" title={r.name}>{r.name}</td>
                    <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.devices)}</td>
                    <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.instances)}</td>
                    <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{r.datapoints ? fmtNum(r.datapoints) : DASH}</td>
                    <td className="py-1.5 pr-3 text-[12px] text-ink-muted">{r.family || (r.isInterface ? 'interfaces' : r.isNeighbor ? 'neighbours' : DASH)}</td>
                    <td className="py-1.5 pr-3 text-right tnum text-[12px] text-ink-muted">{pctText(r.coveragePct)}</td>
                    <td className="py-1.5 pr-3 text-[11px] text-ink-faint whitespace-nowrap">{r.rawLastAt ? fmtWhen(r.rawLastAt) : DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} sizes={[25, 50, 100, 'all']} />
        </>
      )}
      {open && <DatapointsModal name={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Coverage page tile: DataSource and datapoint coverage, and the DataSources with no catalog entry. */
export function CatalogCoverageTile() {
  const [d, setD] = useState(null);
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    client.get('/logicmonitor/settings/discovery').then(({ data }) => setD(data?.raw || {})).catch(() => setD({}));
    client.get('/logicmonitor/datasources').then(({ data }) => setRows(arr(data))).catch(() => setRows([]));
  }, []);
  const queue = useMemo(() => arr(rows)
    .filter((r) => r.datapoints > 0 && !r.isInterface && !r.isNeighbor && !(r.picks > 0))
    .sort((a, b) => (b.devices - a.devices) || (b.instances - a.instances)).slice(0, 10), [rows]);
  if (d == null || rows == null) return <LoadingPanel label="Loading catalog coverage..." height={120} />;
  const dsTotal = d.datasourcesTotal;
  const dsCat = d.datasourcesCatalogued;
  const dsPct = dsTotal ? Math.round((dsCat / dsTotal) * 1000) / 10 : null;
  const labelled = d.datapointsLabelled ?? (d.datapoints != null && d.coveragePct != null ? Math.round((d.datapoints * d.coveragePct) / 100) : null);
  return (
    <div className="panel p-4 mb-4">
      <div className="flex items-baseline gap-3 flex-wrap mb-2">
        <p className="text-sm font-semibold text-ink">Catalog coverage</p>
        <Link to="/logicmonitor/settings?section=export" className="text-[11px] text-brand hover:underline ml-auto">Raw collection settings</Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
        <div className="rounded-lg bg-surface-overlay px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint">DataSources with a catalog entry</p>
          <p className="text-ink"><span className="text-2xl font-semibold tnum">{dsTotal == null ? DASH : `${fmtNum(dsCat)} of ${fmtNum(dsTotal)}`}</span> <span className="text-[12px] text-ink-muted tnum">{pctText(dsPct)}</span></p>
        </div>
        <div className="rounded-lg bg-surface-overlay px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint">Datapoints labelled</p>
          <p className="text-ink"><span className="text-2xl font-semibold tnum">{d.datapoints == null || labelled == null ? DASH : `${fmtNum(labelled)} of ${fmtNum(d.datapoints)}`}</span> <span className="text-[12px] text-ink-muted tnum">{pctText(d.coveragePct)}</span></p>
        </div>
      </div>
      <p className="text-[12px] text-ink-muted">Unlabelled datapoints stay in the raw store (Device 360 &gt; DataSources) and can drive a rule here; the catalog grows from this list.</p>
      {queue.length === 0 ? (
        <p className="text-[12px] text-ink-muted mt-2">{d.datapoints ? 'Every stored DataSource has a catalog entry.' : 'No raw datapoints stored yet. The metrics tier fills them after its next run.'}</p>
      ) : (
        <>
          <p className="text-[11px] uppercase tracking-wide text-ink-faint mt-3 mb-1">DataSources with no catalog entry</p>
          <table className="w-full text-sm">
            <thead><tr className={headRow}><th className="py-1.5 pr-3">DataSource</th><th className="py-1.5 pr-3 text-right">Devices</th><th className="py-1.5 pr-3 text-right">Instances</th><th className="py-1.5 pr-3 text-right">Datapoints</th><th className="py-1.5 pr-3"></th></tr></thead>
            <tbody>
              {queue.map((r) => (
                <tr key={r.name} className="border-b border-cohesity-border/40">
                  <td className="py-1 pr-3 text-[12px] text-ink truncate max-w-[360px]" title={r.name}>{r.name}</td>
                  <td className="py-1 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.devices)}</td>
                  <td className="py-1 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.instances)}</td>
                  <td className="py-1 pr-3 text-right tnum text-[12px] text-ink-muted">{fmtNum(r.datapoints)}</td>
                  <td className="py-1 pr-3 text-right text-[11px] whitespace-nowrap">
                    <button type="button" onClick={() => setOpen(r.name)} className="text-brand hover:underline cursor-pointer mr-3">Datapoints</button>
                    <Link to={rawRuleLink(r.name)} className="text-brand hover:underline">Rule</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {open && <DatapointsModal name={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
