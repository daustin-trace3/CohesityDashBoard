import { useEffect, useState } from 'react';
import client from '../api/client';
import HardwareModal from './HardwareModal';

function formatTB(bytes) {
  if (bytes == null || bytes === 0) return '—';
  const tb = bytes / 1e12;
  if (tb >= 0.01) return `${tb.toFixed(2)} TB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export default function ClusterCard({ cluster, onIntervalChange, onTagClick, selected = false, onSelect }) {
  const [metrics, setMetrics] = useState(null);
  const [sparkRows, setSparkRows] = useState([]);
  const [alertSummary, setAlertSummary] = useState({ count: 0, level: 'none' });
  const [hardwareOpen, setHardwareOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [metricsResp, alertsResp] = await Promise.allSettled([
        client.get(`/metrics/${cluster.id}/history?days=7`),
        client.get(`/alerts?clusterId=${cluster.id}&resolved=0`)
      ]);
      if (metricsResp.status === 'fulfilled' && metricsResp.value.data.length > 0) {
        const rows = metricsResp.value.data;
        setMetrics(rows[rows.length - 1]);
        setSparkRows(rows);
      }
      if (alertsResp.status === 'fulfilled') {
        const a = alertsResp.value.data;
        setAlertSummary({
          count: a.length,
          level: a.some(x => x.severity === 'critical') ? 'critical'
               : a.some(x => x.severity === 'warning') ? 'warning'
               : a.length > 0 ? 'info' : 'none'
        });
      }
    };
    load();
  }, [cluster.id]);

  const used = metrics?.used_bytes ?? 0;
  const total = metrics?.total_capacity_bytes ?? 0;
  const available = total - used;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const pctDisplay = total > 0 ? `${pct.toFixed(2)}%` : '—';

  const pctColor = pct >= 86 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#6CB33F';
  const barColor = pct >= 86 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-cohesity-green';
  const isPulsing = pct >= 90;

  const savings = metrics?.data_reduction_ratio ??
    (metrics?.logical_bytes > 0 && metrics?.used_bytes > 0
      ? parseFloat((metrics.logical_bytes / metrics.used_bytes).toFixed(2))
      : null);
  const tags = (cluster.tags || '').split(',').map(t => t.trim()).filter(Boolean);

  const alertColor = alertSummary.level === 'critical' ? 'text-red-400'
    : alertSummary.level === 'warning' ? 'text-amber-400'
    : 'text-gray-500';

  const SparkLine = ({ rows, color }) => {
    if (!rows || rows.length < 2) return null;
    const vals = rows.map(r => r.used_bytes || 0);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1;
    const W = 100, H = 24;
    const points = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - ((v - min) / range) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 24 }} preserveAspectRatio="none">
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  };

  return (
    <>
      <div
        className={`border rounded p-3 flex flex-col gap-1.5 transition-colors cursor-pointer ${
          selected
            ? 'bg-cohesity-green bg-opacity-10 border-cohesity-green'
            : isPulsing
              ? 'bg-cohesity-gray border-red-500 pulse-critical'
              : 'bg-cohesity-gray border-cohesity-border hover:border-cohesity-green'
        }`}
        onClick={() => onSelect && onSelect(cluster.id)}
      >
        {/* Name + alert badge */}
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-cohesity-text truncate leading-tight">{cluster.name}</p>
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-0.5 mt-0.5">
                {tags.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    onClick={e => { e.stopPropagation(); onTagClick && onTagClick(tag); }}
                    className="text-[9px] text-cohesity-green bg-cohesity-black border border-cohesity-border px-1.5 py-0.5 rounded hover:border-cohesity-green transition-colors"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-gray-600">
                {cluster.connection_type === 'helios' ? 'Helios' : cluster.vip || 'Direct'}
              </p>
            )}
          </div>
          {alertSummary.count > 0 && (
            <span className={`text-[10px] flex-shrink-0 font-semibold ${alertColor}`}>
              ⚠ {alertSummary.count}
            </span>
          )}
        </div>

        {/* Big % */}
        <div className="text-2xl font-bold leading-none" style={{ color: pctColor }}>
          {pctDisplay}
        </div>

        {/* Progress bar */}
        <div className="h-1.5 bg-cohesity-black rounded overflow-hidden">
          <div
            className={`h-full ${barColor} transition-all duration-500`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-0.5">
          <div>
            <p className="text-[9px] text-gray-500 uppercase tracking-wide">Used</p>
            <p className="text-xs text-cohesity-text font-medium">{formatTB(used)}</p>
          </div>
          <div>
            <p className="text-[9px] text-gray-500 uppercase tracking-wide">Capacity</p>
            <p className="text-xs text-cohesity-text font-medium">{formatTB(total)}</p>
          </div>
          <div>
            <p className="text-[9px] text-gray-500 uppercase tracking-wide">Available</p>
            <p className="text-xs text-cohesity-text font-medium">{formatTB(available > 0 ? available : null)}</p>
          </div>
          <div>
            <p className="text-[9px] text-gray-500 uppercase tracking-wide">Savings</p>
            <p className="text-xs text-cohesity-text font-medium">
              {savings ? `${savings.toFixed(2)}x` : '—'}
            </p>
          </div>
        </div>

        {sparkRows.length >= 2 && (
          <div className="mt-1 opacity-60">
            <SparkLine rows={sparkRows} color={pctColor} />
          </div>
        )}

        {/* Footer: version + hardware button */}
        <div className="flex items-center justify-between mt-0.5">
          {metrics?.software_version
            ? <p className="text-[9px] text-gray-600">v{metrics.software_version}</p>
            : <span />}
          <button
            onClick={(e) => { e.stopPropagation(); setHardwareOpen(true); }}
            className="text-[9px] text-gray-500 border border-cohesity-border rounded px-1.5 py-0.5 hover:border-cohesity-green hover:text-cohesity-green transition-colors"
          >
            HW Info
          </button>
        </div>
      </div>

      {hardwareOpen && (
        <HardwareModal cluster={cluster} onClose={() => setHardwareOpen(false)} />
      )}
    </>
  );
}
