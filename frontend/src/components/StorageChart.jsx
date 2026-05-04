import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { useEffect, useState } from 'react';
import client from '../api/client';

function formatBytes(bytes) {
  if (bytes == null) return 'N/A';
  const tb = bytes / 1e12;
  if (tb >= 0.1) return `${tb.toFixed(2)} TB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function toTB(bytes) {
  return bytes != null ? parseFloat((bytes / 1e12).toFixed(3)) : null;
}

const WINDOWS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 }
];

export default function StorageChart({ clusterId }) {
  const [data, setData] = useState([]);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!clusterId) return;
    setLoading(true);
    client
      .get(`/metrics/${clusterId}/history?days=${days}`)
      .then(({ data: rows }) => {
        setData(
          rows.map((r) => ({
            time: new Date(r.captured_at).toLocaleDateString(),
            total: toTB(r.total_capacity_bytes),
            used: toTB(r.used_bytes),
            logical: toTB(r.logical_bytes)
          }))
        );
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [clusterId, days]);

  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-cohesity-text">Storage Trend</h3>
        <div className="flex gap-1">
          {WINDOWS.map(({ label, days: d }) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                days === d
                  ? 'bg-cohesity-green text-cohesity-black border-cohesity-green'
                  : 'border-cohesity-border text-gray-400 hover:border-cohesity-green'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-40 flex items-center justify-center text-gray-400 text-sm">
          Loading...
        </div>
      ) : data.length === 0 ? (
        <div className="h-40 flex items-center justify-center text-gray-500 text-sm">
          No data available
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#3D3D3D" />
            <XAxis dataKey="time" tick={{ fill: '#9ca3af', fontSize: 10 }} />
            <YAxis
              tick={{ fill: '#9ca3af', fontSize: 10 }}
              tickFormatter={(v) => `${v} TB`}
            />
            <Tooltip
              contentStyle={{ background: '#2C2C2C', border: '1px solid #3D3D3D', color: '#E5E5E5' }}
              formatter={(v) => [`${v} TB`]}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
            <Area type="monotone" dataKey="total" name="Total" stroke="#6CB33F" fill="#6CB33F22" strokeWidth={2} />
            <Area type="monotone" dataKey="used" name="Used" stroke="#f59e0b" fill="#f59e0b22" strokeWidth={2} />
            <Area type="monotone" dataKey="logical" name="Logical" stroke="#60a5fa" fill="#60a5fa22" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
