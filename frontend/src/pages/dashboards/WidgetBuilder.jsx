// Inline widget builder (no modal — see ui-gotchas): pick dataset → chart
// type → shape controls → live preview → add. Emits a saved widget
// { title, datasetId, chartType, query } via onAdd.
import { useMemo, useState } from 'react';
import { Plus, Eye, X } from 'lucide-react';
import { Panel, Badge } from '../../components/ui/primitives';
import { BYTE_FACTORS, CHART_TYPES, DISPLAY_UNITS, WidgetView } from './widgets';

const OPS = [
  { id: 'eq', label: '=' },
  { id: 'neq', label: '≠' },
  { id: 'gt', label: '>' },
  { id: 'gte', label: '≥' },
  { id: 'lt', label: '<' },
  { id: 'lte', label: '≤' },
  { id: 'like', label: 'contains' },
];

const AGG_FNS = ['count', 'sum', 'avg', 'min', 'max'];

const inputCls =
  'bg-cohesity-black border border-cohesity-border rounded px-2 py-1 text-sm text-ink focus:outline-none focus:border-brand';

function coerce(col, raw) {
  if (col.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (col.type === 'boolean') return raw === 'true';
  return raw;
}

// Which columns a unit conversion would apply to, and their source unit.
// Only byte-family units are convertible; mixed-unit tables convert the
// first unit family found.
function conversionTarget(state, dataset) {
  const colUnit = (key) => dataset.columns.find((c) => c.key === key)?.unit;
  const { chartType, aggFn, aggCol, yCol, columns } = state;
  if (chartType === 'bar' || chartType === 'pie' || chartType === 'stat') {
    if (aggFn === 'count') return null;
    const unit = colUnit(aggCol);
    return BYTE_FACTORS[unit] ? { from: unit, columns: ['value'] } : null;
  }
  if (chartType === 'line') {
    const unit = colUnit(yCol);
    return BYTE_FACTORS[unit] ? { from: unit, columns: [yCol] } : null;
  }
  const shown = columns.length ? columns : dataset.columns.map((c) => c.key);
  const convertible = shown.filter((k) => BYTE_FACTORS[colUnit(k)]);
  if (!convertible.length) return null;
  const from = colUnit(convertible[0]);
  return { from, columns: convertible.filter((k) => colUnit(k) === from) };
}

function buildWidget(state, dataset) {
  const { chartType, title, filters, groupBy, aggFn, aggCol, xCol, yCol, columns, sortCol, sortDir } = state;
  const query = {};
  const validFilters = filters
    .filter((f) => f.column && f.op && f.value !== '')
    .map((f) => {
      const col = dataset.columns.find((c) => c.key === f.column);
      return { column: f.column, op: f.op === 'like' ? 'like' : f.op, value: f.op === 'like' ? `%${f.value}%` : coerce(col, f.value) };
    })
    .filter((f) => f.value !== null);
  if (validFilters.length) query.filters = validFilters;

  if (chartType === 'bar' || chartType === 'pie') {
    if (!groupBy) return null;
    query.groupBy = groupBy;
    query.aggregate = aggFn === 'count' ? { fn: 'count', column: '*' } : { fn: aggFn, column: aggCol };
    if (aggFn !== 'count' && !aggCol) return null;
    query.limit = 25;
  } else if (chartType === 'stat') {
    query.aggregate = aggFn === 'count' ? { fn: 'count', column: '*' } : { fn: aggFn, column: aggCol };
    if (aggFn !== 'count' && !aggCol) return null;
  } else if (chartType === 'line') {
    // Line X must be a datetime column — a stale non-datetime selection
    // (e.g. from before this restriction) falls back to the first one.
    const dtCols = dataset.columns.filter((c) => c.type === 'datetime');
    const effXCol = (dtCols.find((c) => c.key === xCol) || dtCols[0])?.key;
    if (!effXCol || !yCol) return null;
    // Sort desc so the row cap keeps the MOST RECENT window; the renderer
    // re-sorts ascending for display.
    query.columns = state.seriesCol ? [effXCol, yCol, state.seriesCol] : [effXCol, yCol];
    query.sort = { column: effXCol, dir: 'desc' };
    query.limit = state.seriesCol ? 1000 : 500;
  } else {
    if (columns.length) query.columns = columns;
    if (sortCol) query.sort = { column: sortCol, dir: sortDir };
    query.limit = 200;
  }

  const out = {
    title: title.trim() || `${dataset.label} — ${CHART_TYPES.find((c) => c.id === chartType)?.label}`,
    datasetId: dataset.id,
    chartType,
    query,
  };
  if (chartType === 'line' && state.seriesCol) out.seriesColumn = state.seriesCol;
  const target = conversionTarget(state, dataset);
  if (target && state.unit !== 'raw') {
    out.unitConvert = { from: target.from, to: state.unit, columns: target.columns };
  }
  return out;
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-muted">
      {label}
      {children}
    </label>
  );
}

export default function WidgetBuilder({ datasets, onAdd, onClose }) {
  const [state, setState] = useState({
    datasetId: '',
    chartType: 'bar',
    title: '',
    filters: [],
    groupBy: '',
    aggFn: 'count',
    aggCol: '',
    xCol: '',
    yCol: '',
    columns: [],
    sortCol: '',
    sortDir: 'asc',
    unit: 'auto',
    seriesCol: '',
  });
  const [preview, setPreview] = useState(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  const dataset = useMemo(() => datasets.find((d) => d.id === state.datasetId), [datasets, state.datasetId]);
  const set = (patch) => { setState((s) => ({ ...s, ...patch })); setPreview(null); };

  const filterable = dataset?.columns.filter((c) => c.filterable) || [];
  const aggregatable = dataset?.columns.filter((c) => c.aggregatable) || [];
  const numeric = dataset?.columns.filter((c) => c.type === 'number') || [];
  const convertible = dataset ? conversionTarget(state, dataset) : null;
  const widget = dataset ? buildWidget(state, dataset) : null;

  const doPreview = () => {
    if (!widget) return;
    setPreview(widget);
    setPreviewNonce((n) => n + 1);
  };

  return (
    <Panel
      title="New widget"
      actions={
        <button onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close builder">
          <X size={16} />
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3 items-end">
          <Field label="Dataset">
            <select
              className={inputCls}
              value={state.datasetId}
              onChange={(e) => set({ datasetId: e.target.value, filters: [], groupBy: '', aggCol: '', xCol: '', yCol: '', columns: [], sortCol: '', seriesCol: '' })}
            >
              <option value="">Select…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>{d.platform} — {d.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Chart type">
            <select className={inputCls} value={state.chartType} onChange={(e) => set({ chartType: e.target.value })}>
              {CHART_TYPES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Title (optional)">
            <input className={inputCls} value={state.title} onChange={(e) => set({ title: e.target.value })} placeholder="Widget title" />
          </Field>
        </div>

        {dataset && (state.chartType === 'bar' || state.chartType === 'pie') && (
          <div className="flex flex-wrap gap-3 items-end">
            <Field label="Group by">
              <select className={inputCls} value={state.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
                <option value="">Select…</option>
                {filterable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Aggregate">
              <select className={inputCls} value={state.aggFn} onChange={(e) => set({ aggFn: e.target.value })}>
                {AGG_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            {state.aggFn !== 'count' && (
              <Field label="Of column">
                <select className={inputCls} value={state.aggCol} onChange={(e) => set({ aggCol: e.target.value })}>
                  <option value="">Select…</option>
                  {aggregatable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </Field>
            )}
          </div>
        )}

        {dataset && state.chartType === 'stat' && (
          <div className="flex flex-wrap gap-3 items-end">
            <Field label="Aggregate">
              <select className={inputCls} value={state.aggFn} onChange={(e) => set({ aggFn: e.target.value })}>
                {AGG_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            {state.aggFn !== 'count' && (
              <Field label="Of column">
                <select className={inputCls} value={state.aggCol} onChange={(e) => set({ aggCol: e.target.value })}>
                  <option value="">Select…</option>
                  {aggregatable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </Field>
            )}
          </div>
        )}

        {dataset && state.chartType === 'line' && (
          <div className="flex flex-wrap gap-3 items-end">
            <Field label="X axis (time)">
              <select
                className={inputCls}
                value={
                  dataset.columns.some((c) => c.type === 'datetime' && c.key === state.xCol)
                    ? state.xCol
                    : dataset.columns.find((c) => c.type === 'datetime')?.key || ''
                }
                onChange={(e) => set({ xCol: e.target.value })}
              >
                {dataset.columns.filter((c) => c.type === 'datetime').map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Y axis">
              <select className={inputCls} value={state.yCol} onChange={(e) => set({ yCol: e.target.value })}>
                <option value="">Select…</option>
                {numeric.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Series by (optional)">
              <select className={inputCls} value={state.seriesCol} onChange={(e) => set({ seriesCol: e.target.value })}>
                <option value="">Single line</option>
                {filterable
                  .filter((c) => c.type !== 'datetime' && c.key !== state.yCol)
                  .map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </Field>
          </div>
        )}

        {dataset && state.chartType === 'table' && (
          <div className="flex flex-col gap-2">
            <span className="text-xs text-ink-muted">Columns (none selected = all)</span>
            <div className="flex flex-wrap gap-1.5">
              {dataset.columns.map((c) => {
                const on = state.columns.includes(c.key);
                return (
                  <button
                    key={c.key}
                    onClick={() => set({ columns: on ? state.columns.filter((k) => k !== c.key) : [...state.columns, c.key] })}
                    className={`px-2 py-0.5 rounded text-xs border ${on ? 'border-brand text-brand' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-3 items-end">
              <Field label="Sort by">
                <select className={inputCls} value={state.sortCol} onChange={(e) => set({ sortCol: e.target.value })}>
                  <option value="">Default</option>
                  {dataset.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </Field>
              <Field label="Direction">
                <select className={inputCls} value={state.sortDir} onChange={(e) => set({ sortDir: e.target.value })}>
                  <option value="asc">asc</option>
                  <option value="desc">desc</option>
                </select>
              </Field>
            </div>
          </div>
        )}

        {dataset && convertible && (
          <div className="flex flex-wrap gap-3 items-end">
            <Field label={`Display unit (source: ${convertible.from.toUpperCase()})`}>
              <select className={inputCls} value={state.unit} onChange={(e) => set({ unit: e.target.value })}>
                {DISPLAY_UNITS.map((u) => (
                  <option key={u} value={u}>{u === 'auto' ? 'Auto (best fit)' : u.toUpperCase()}</option>
                ))}
                <option value="raw">Raw (no conversion)</option>
              </select>
            </Field>
          </div>
        )}

        {dataset && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted">Filters</span>
              <button
                onClick={() => set({ filters: [...state.filters, { column: '', op: 'eq', value: '' }] })}
                className="text-xs text-brand hover:underline"
              >
                + add filter
              </button>
            </div>
            {state.filters.map((f, i) => {
              const col = filterable.find((c) => c.key === f.column);
              const patch = (p) => set({ filters: state.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="flex gap-2 items-center">
                  <select className={inputCls} value={f.column} onChange={(e) => patch({ column: e.target.value, value: '' })}>
                    <option value="">Column…</option>
                    {filterable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                  <select className={inputCls} value={f.op} onChange={(e) => patch({ op: e.target.value })}>
                    {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  {col?.type === 'boolean' ? (
                    <select className={inputCls} value={f.value} onChange={(e) => patch({ value: e.target.value })}>
                      <option value="">…</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className={inputCls}
                      type={col?.type === 'number' ? 'number' : 'text'}
                      value={f.value}
                      onChange={(e) => patch({ value: e.target.value })}
                      placeholder="Value"
                    />
                  )}
                  <button
                    onClick={() => set({ filters: state.filters.filter((_, j) => j !== i) })}
                    className="text-ink-faint hover:text-red-400"
                    aria-label="Remove filter"
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={doPreview}
            disabled={!widget}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-cohesity-border text-sm text-ink hover:border-brand disabled:opacity-40"
          >
            <Eye size={14} /> Preview
          </button>
          <button
            onClick={() => widget && onAdd(widget)}
            disabled={!widget}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-brand text-cohesity-black text-sm font-medium hover:opacity-90 disabled:opacity-40"
          >
            <Plus size={14} /> Add to dashboard
          </button>
          {!widget && dataset && <Badge tone="neutral">Complete the required fields to preview</Badge>}
        </div>

        {preview && (
          <div className="h-64 border border-cohesity-border rounded p-3">
            <WidgetView widget={preview} nonce={previewNonce} />
          </div>
        )}
      </div>
    </Panel>
  );
}
