// Port of frontend/src/pages/unifi/PortHistoryModal.jsx onto the plugin ui/charts kit.
import { portalOrInline, LoadingPanel, apiFetch, fmtWhen, counterDelta, BRAND } from '../ui.jsx';
import { Activity, X } from '../icons.jsx';
import { LineChart } from '../charts.jsx';

const chartOpts = {
  scales: {
    x: { ticks: { maxTicksLimit: 8 } },
  },
};

export default function PortHistoryModal({ mac, portIdx, portLabel, deviceName, onClose }) {
  const [rows, setRows] = React.useState(null);
  const [hours, setHours] = React.useState(168);

  React.useEffect(() => {
    setRows(null);
    apiFetch(`/unifi/devices/${mac}/port-history?port=${portIdx}&hours=${hours}`)
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, [mac, portIdx, hours]);

  const labels = React.useMemo(() => (rows || []).map((r) => fmtWhen(r.captured_at)), [rows]);

  const upData = React.useMemo(() => (rows || []).map((r) => (r.up ? 1 : 0)), [rows]);

  const errorDeltas = React.useMemo(() => {
    if (!rows) return [];
    return rows.map((r, i) => {
      if (i === 0) return 0;
      const prev = rows[i - 1];
      const rx = counterDelta(prev, r, 'rx_errors') || 0;
      const tx = counterDelta(prev, r, 'tx_errors') || 0;
      return rx + tx;
    });
  }, [rows]);

  const byteDeltas = React.useMemo(() => {
    if (!rows) return { rx: [], tx: [] };
    const rx = []; const tx = [];
    rows.forEach((r, i) => {
      if (i === 0) { rx.push(0); tx.push(0); return; }
      const prev = rows[i - 1];
      rx.push((counterDelta(prev, r, 'rx_bytes') || 0) / 1e6);
      tx.push((counterDelta(prev, r, 'tx_bytes') || 0) / 1e6);
    });
    return { rx, tx };
  }, [rows]);

  const poeWattsData = React.useMemo(() => (rows || []).map((r) => (r.poe_power != null ? Number(r.poe_power) : null)), [rows]);
  const poeVoltsData = React.useMemo(() => (rows || []).map((r) => (r.poe_voltage != null ? Number(r.poe_voltage) : null)), [rows]);
  const hasPoe = poeWattsData.some((v) => v != null);

  const stateChart = { labels, datasets: [{ label: 'Link Up', data: upData, borderColor: BRAND, backgroundColor: 'rgba(0,111,255,0.15)', stepped: true, pointRadius: 0, borderWidth: 2, fill: true }] };
  const errChart = { labels, datasets: [{ label: 'Errors (delta)', data: errorDeltas, borderColor: '#C75D5D', backgroundColor: 'rgba(199,93,93,0.15)', pointRadius: 0, borderWidth: 2, tension: 0.2, fill: true }] };
  const trafficChart = {
    labels,
    datasets: [
      { label: 'RX MB', data: byteDeltas.rx, borderColor: BRAND, pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
      { label: 'TX MB', data: byteDeltas.tx, borderColor: '#6CB33F', pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
    ],
  };
  const poeChart = {
    labels,
    datasets: [
      { label: 'Watts', data: poeWattsData, borderColor: '#D4A24E', pointRadius: 0, borderWidth: 2, tension: 0.2, yAxisID: 'y' },
      { label: 'Volts', data: poeVoltsData, borderColor: '#8FA3B0', pointRadius: 0, borderWidth: 1.5, tension: 0.2, yAxisID: 'y1' },
    ],
  };
  const poeOpts = { scales: { x: chartOpts.scales.x, y: { position: 'left' }, y1: { position: 'right', grid: { drawOnChartArea: false } } } };
  const stateOpts = { scales: { x: chartOpts.scales.x, y: { min: -0.1, max: 1.1, ticks: { callback: (v) => (v === 1 ? 'Up' : v === 0 ? 'Down' : '') } } } };

  return portalOrInline(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-3xl max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            <Activity size={17} className="text-brand shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">Port {portIdx}{portLabel ? ` — ${portLabel}` : ''}</p>
              {deviceName && <p className="text-[11px] text-ink-faint truncate">{deviceName}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">
          <div className="flex items-center gap-1 mb-3">
            {[24, 168, 720].map((h) => (
              <button key={h} onClick={() => setHours(h)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${hours === h ? 'bg-brand/10 text-brand border border-brand/30' : 'text-ink-muted border border-transparent hover:text-ink'}`}>
                {h === 24 ? '24h' : h === 168 ? '7d' : '30d'}
              </button>
            ))}
          </div>
          {rows == null ? (
            <LoadingPanel label="Loading port history…" height={160} />
          ) : rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No history collected for this port yet.</div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-xs font-semibold text-ink mb-2">Link State</p>
                <LineChart data={stateChart} options={stateOpts} height={96} />
              </div>
              <div>
                <p className="text-xs font-semibold text-ink mb-2">Error Growth</p>
                <LineChart data={errChart} options={chartOpts} height={128} />
              </div>
              <div>
                <p className="text-xs font-semibold text-ink mb-2">Traffic</p>
                <LineChart data={trafficChart} options={chartOpts} height={128} />
              </div>
              {hasPoe && (
                <div>
                  <p className="text-xs font-semibold text-ink mb-2">PoE</p>
                  <LineChart data={poeChart} options={poeOpts} height={128} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
