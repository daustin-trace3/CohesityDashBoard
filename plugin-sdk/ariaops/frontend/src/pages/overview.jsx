import { Gauge, Boxes, Server, ShieldAlert, AlertTriangle } from '../icons.jsx';
import { LineChart } from '../charts.jsx';
import {
  apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo,
  BRAND, fmtNum, fmtWhen, asDate,
} from '../ui.jsx';

const tickStyle = { color: '#9CA3AF', font: { size: 10 } };
const gridStyle = { color: 'rgba(255,255,255,0.06)' };
const PALETTE = ['#78BE20', '#00A2C7', '#D4A24E', '#9B6CD4', '#C75D5D'];

export default function AriaOpsOverviewPage() {
  const [data, setData] = React.useState(null);
  const [history, setHistory] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiFetch('/ariaops/overview').then((json) => setData(json)),
    apiFetch('/ariaops/metrics-history?hours=168').then((json) => setHistory(json)).catch(() => setHistory([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => setData({ instances: [], totals: {} })), []);

  React.useEffect(() => { load(); }, [load]);

  const instances = data?.instances || [];
  const totals = data?.totals || {};

  const histRows = history || [];
  const times = [...new Set(histRows.map(h => h.captured_at))].sort();
  const instanceIds = [...new Set(histRows.map(h => h.instance_id))];
  const nameFor = (id) => instances.find(i => i.id === id)?.name || `#${id}`;
  const trendData = {
    labels: times.map(t => fmtWhen(t).split(',')[0]),
    datasets: instanceIds.flatMap((id, i) => {
      const color = PALETTE[i % PALETTE.length];
      const rows = histRows.filter(h => h.instance_id === id);
      const at = (t) => rows.find(r => r.captured_at === t);
      return [
        {
          label: `${nameFor(id)} — resources`, data: times.map(t => at(t)?.resources_total ?? null),
          borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true,
        },
        {
          label: `${nameFor(id)} — critical alerts`, data: times.map(t => at(t)?.alerts_critical ?? null),
          borderColor: color, backgroundColor: color, borderDash: [4, 3], borderWidth: 1.5, pointRadius: 0, tension: 0.3, spanGaps: true,
        },
      ];
    }),
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Aria Operations Overview" description="Resource health and alerts across all registered vROps instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data != null && instances.length === 0 && (
        <div className="panel p-4 mb-4 text-sm text-ink-muted">
          No Aria Operations instances registered yet. Add one under{' '}
          <ReactRouterDOM.Link to="/ariaops/settings" className="text-brand hover:underline">Settings</ReactRouterDOM.Link>.
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Boxes} label="Resources" value={fmtNum(totals.resources)}
          sub={`${fmtNum(totals.vms)} VMs`}
          tone="ok" />
        <StatCard icon={ShieldAlert} label="Health" value={fmtNum(totals.resourcesRed)}
          sub={`${fmtNum(totals.resourcesRed)} red · ${fmtNum(totals.resourcesYellow)} yellow`}
          tone={(totals.resourcesRed || 0) > 0 ? 'crit' : (totals.resourcesYellow || 0) > 0 ? 'warn' : 'ok'} />
        <StatCard icon={AlertTriangle} label="Active Alerts" value={fmtNum(totals.alerts)}
          sub={`${fmtNum(totals.alertsCritical)} critical · ${fmtNum(totals.alertsImmediate)} immediate`}
          tone={(totals.alertsCritical || 0) > 0 ? 'crit' : (totals.alertsWarning || 0) > 0 ? 'warn' : 'ok'} />
        <StatCard icon={Server} label="Instances" value={fmtNum(instances.length)}
          sub={`${instances.filter(i => i.lastPollStatus === 'success').length} up`}
          tone={instances.some(i => i.lastPollStatus === 'error') ? 'crit' : 'ok'} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Aria Operations Instances</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : instances.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {instances.map((o) => (
              <div key={o.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${o.lastPollStatus === 'success' ? 'bg-status-ok' : o.lastPollStatus === 'error' ? 'bg-status-crit' : 'bg-ink-faint'}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{o.name}</p>
                    <p className="text-[11px] text-ink-faint truncate">{o.host}{o.version ? ` · v${o.version}` : ''}</p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0">
                  <div className="flex items-center gap-1">
                    <Badge tone={o.lastPollStatus === 'error' ? 'crit' : o.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                      {o.lastPollStatus === 'error' ? 'Unreachable' : o.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                    </Badge>
                    <span className="text-[10px] text-ink-faint tnum">{fmtNum(o.counts?.resources)} res · {fmtNum(o.counts?.alerts)} alerts</span>
                  </div>
                  {o.lastPollAt && (
                    <span className="text-[10px] text-ink-faint whitespace-nowrap" title={asDate(o.lastPollAt)?.toLocaleString()}>
                      polled {timeAgo(asDate(o.lastPollAt))}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><AlertTriangle size={15} className="text-brand" /> Resources &amp; Critical Alerts (7d)</p>
        <p className="text-[11px] text-ink-faint mb-3">Per-instance resource count (solid) and critical-alert count (dashed) over the trailing week.</p>
        {history == null ? <LoadingPanel label="Loading…" height={190} /> : trendData.datasets.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No metrics history yet — appears after the first few polls.</div>
        ) : (
          <LineChart height={220} data={trendData} options={{
            plugins: { legend: { position: 'bottom', labels: { color: '#E5E5E5', boxWidth: 10, font: { size: 10 } } } },
            scales: { x: { ticks: tickStyle, grid: { display: false } }, y: { ticks: tickStyle, grid: gridStyle, beginAtZero: true } },
          }} />
        )}
      </div>
    </div>
  );
}
