import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Waypoints } from 'lucide-react';
import client from '../../api/client';
import { Badge } from '../ui/primitives';

const stateTone = (t) => (t === 'crit' ? 'crit' : t === 'warn' ? 'warn' : t === 'ok' ? 'ok' : 'neutral');
const checkTone = (c) => (c.lastStatus === 'down' || c.severity === 'critical' ? 'crit' : c.anomaly ? 'warn' : 'ok');

/** Dell device modal "Network" section: the switch ports behind a server from
 *  GET /api/dell/devices/:id/network. Renders nothing while loading, when the
 *  LogicMonitor platform is off (the route answers 404) or on any error. */
export default function DellNetworkSection({ deviceId, deviceName }) {
  const [net, setNet] = useState(null);

  useEffect(() => {
    let live = true;
    setNet(null);
    client.get(`/dell/devices/${deviceId}/network`)
      .then(({ data }) => { if (live) setNet(data); })
      .catch(() => { if (live) setNet(null); });
    return () => { live = false; };
  }, [deviceId]);

  if (!net) return null;
  const ports = net.switchPorts || [];
  const checks = net.checks || [];
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-ink flex items-center gap-1.5"><Waypoints size={13} className="text-brand" /> Network ({ports.length})</p>
        {deviceName && (
          <Link to={`/ops/topology?name=${encodeURIComponent(deviceName)}`} className="text-[11px] text-brand hover:underline">Open topology</Link>
        )}
      </div>
      {net.esxHost && <p className="text-[11px] text-ink-faint mb-1.5">Runs ESXi as {net.esxHost} in vCenter.</p>}
      {ports.length === 0 ? (
        <p className="text-xs text-ink-faint">No switch port is mapped to this server yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <th className="py-1.5 pr-3">Switch</th>
              <th className="py-1.5 pr-3">Port</th>
              <th className="py-1.5 pr-3">NIC</th>
              <th className="py-1.5 pr-3">Origin</th>
              <th className="py-1.5 pr-3">State</th>
            </tr></thead>
            <tbody>
              {ports.map((p, i) => (
                <tr key={`${p.sourceId}-${p.deviceId}-${p.port}-${i}`} className="border-b border-cohesity-border/40">
                  <td className="py-1.5 pr-3 text-ink">{p.deviceName || '-'}</td>
                  <td className="py-1.5 pr-3 text-ink-muted tnum">{p.port || '-'}</td>
                  <td className="py-1.5 pr-3 text-ink-muted tnum">{p.nic || '-'}</td>
                  <td className="py-1.5 pr-3 text-ink-faint">{p.source || '-'}</td>
                  <td className="py-1.5 pr-3"><Badge tone={stateTone(p.tone)}>{p.statusText || 'unknown'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {checks.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Reachability checks</p>
          <div className="flex flex-col gap-1">
            {checks.map((c) => {
              const worst = (c.locations || []).find((l) => l.isOverall) || (c.locations || [])[0];
              return (
                <div key={`${c.sourceId}-${c.checkId}`} className="flex items-center gap-2 bg-surface-overlay rounded-lg px-3 py-1.5">
                  <Badge tone={worst ? checkTone(worst) : 'neutral'}>{worst ? (worst.lastStatus || 'unknown') : 'unknown'}</Badge>
                  <span className="text-xs text-ink-muted">{c.name}{c.target ? ` (${c.target})` : ''}</span>
                  {worst && worst.rttAvgMs != null && <span className="text-[11px] text-ink-faint tnum ml-auto">{Number(worst.rttAvgMs).toFixed(1)} ms</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
