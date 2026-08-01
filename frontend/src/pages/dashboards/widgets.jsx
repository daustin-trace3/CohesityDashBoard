// Widget rendering for custom dashboards. A widget is a saved
// { title, datasetId, chartType, query } — the query is replayed verbatim
// against POST /api/datasets/:id/query, so RBAC is enforced per-viewer at
// render time (a 403 renders as a lock message, not an error page).
import { useEffect, useState } from 'react';
import { Bar, Line, Pie } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Lock } from 'lucide-react';
import client from '../../api/client';
import { Spinner } from '../../components/ui/primitives';

ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

export const CHART_TYPES = [
  { id: 'table', label: 'Table' },
  { id: 'bar', label: 'Bar' },
  { id: 'pie', label: 'Pie' },
  { id: 'line', label: 'Line' },
  { id: 'stat', label: 'Stat' },
];

const PALETTE = ['#6CB33F', '#4E8FD4', '#D4A24E', '#C75D5D', '#8E6FC9', '#4EB8A8', '#B0B84E', '#C96FA8'];

const CHART_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5' } } },
  scales: {
    x: { ticks: { color: '#E5E5E5' }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5' }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

const fmtNum = (v) =>
  v == null ? '—' : typeof v === 'number' ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v);

export function useWidgetData(widget, nonce = 0) {
  const [state, setState] = useState({ loading: true, error: null, forbidden: false, data: null });

  useEffect(() => {
    if (!widget?.datasetId) return;
    let cancelled = false;
    setState({ loading: true, error: null, forbidden: false, data: null });
    client
      .post(`/datasets/${widget.datasetId}/query`, widget.query || {})
      .then((res) => !cancelled && setState({ loading: false, error: null, forbidden: false, data: res.data }))
      .catch((err) => {
        if (cancelled) return;
        const status = err.response?.status;
        setState({
          loading: false,
          forbidden: status === 403,
          error: err.response?.data?.message || err.response?.data?.error || err.message,
          data: null,
        });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget?.datasetId, JSON.stringify(widget?.query || {}), nonce]);

  return state;
}

function grouped(data) {
  return {
    labels: data.rows.map((r) => (r.group == null ? '—' : String(r.group))),
    values: data.rows.map((r) => r.value),
  };
}

function WidgetBody({ widget, data }) {
  const { chartType } = widget;

  if (chartType === 'stat') {
    const value = data.rows[0]?.value ?? data.rows[0]?.[data.columns[0]];
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-4xl font-semibold text-ink tnum">{fmtNum(value)}</span>
      </div>
    );
  }

  if (chartType === 'bar' || chartType === 'pie') {
    const g = grouped(data);
    const ds = {
      labels: g.labels,
      datasets: [
        {
          label: widget.title || 'Value',
          data: g.values,
          backgroundColor: chartType === 'pie' ? g.labels.map((_, i) => PALETTE[i % PALETTE.length]) : '#6CB33F',
        },
      ],
    };
    return chartType === 'pie' ? (
      <Pie data={ds} options={{ ...CHART_OPTS, scales: undefined }} />
    ) : (
      <Bar data={ds} options={CHART_OPTS} />
    );
  }

  if (chartType === 'line') {
    const [xKey, yKey] = data.columns;
    return (
      <Line
        data={{
          labels: data.rows.map((r) => String(r[xKey] ?? '—')),
          datasets: [
            {
              label: yKey,
              data: data.rows.map((r) => r[yKey]),
              borderColor: '#6CB33F',
              backgroundColor: 'rgba(108,179,63,0.15)',
              pointRadius: 0,
              tension: 0.25,
            },
          ],
        }}
        options={CHART_OPTS}
      />
    );
  }

  // table
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-muted border-b border-cohesity-border">
            {data.columns.map((c) => (
              <th key={c} className="py-1.5 pr-4 font-medium whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.slice(0, 100).map((row, i) => (
            <tr key={i} className="border-b border-cohesity-border/50">
              {data.columns.map((c) => (
                <td key={c} className={`py-1.5 pr-4 whitespace-nowrap ${typeof row[c] === 'number' ? 'tnum' : ''}`}>
                  {fmtNum(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > 100 && (
        <p className="text-xs text-ink-faint py-2">Showing first 100 of {data.rows.length} rows</p>
      )}
    </div>
  );
}

export function WidgetView({ widget, nonce }) {
  const { loading, error, forbidden, data } = useWidgetData(widget, nonce);

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Spinner size={20} /></div>;
  }
  if (forbidden) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-ink-faint">
        <Lock size={18} />
        <span className="text-sm">You don't have permission to view this data</span>
      </div>
    );
  }
  if (error) {
    return <div className="flex items-center justify-center h-full text-sm text-red-400">{error}</div>;
  }
  if (!data || !data.rows.length) {
    return <div className="flex items-center justify-center h-full text-sm text-ink-faint">No data</div>;
  }
  return <WidgetBody widget={widget} data={data} />;
}
