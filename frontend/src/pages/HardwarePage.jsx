import { useEffect, useState } from 'react';
import client from '../api/client';
import HardwareModal from '../components/HardwareModal';

export default function HardwarePage() {
  const [clusters, setClusters] = useState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    client.get('/clusters').then(({ data }) => setClusters(data)).catch(() => {});
  }, []);

  return (
    <div>
      <h2 className="text-lg font-semibold text-cohesity-text mb-4">Hardware</h2>

      {clusters.length === 0 ? (
        <p className="text-gray-500 text-sm">No clusters configured.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {clusters.map((cluster) => (
            <div
              key={cluster.id}
              className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4 flex flex-col gap-2"
            >
              <h3 className="font-semibold text-cohesity-text">{cluster.name}</h3>
              <span className="text-xs text-gray-400">
                {cluster.connection_type === 'helios' ? 'Helios' : `Direct — ${cluster.vip}`}
              </span>
              <button
                onClick={() => setSelected(cluster)}
                className="mt-2 text-sm border border-cohesity-border rounded px-3 py-1.5 hover:border-cohesity-green hover:text-cohesity-green transition-colors self-start"
              >
                View Hardware
              </button>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <HardwareModal cluster={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
