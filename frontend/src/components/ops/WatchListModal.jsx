import { useCallback, useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel, timeAgo } from '../ui/primitives';
import Sparkline from './Sparkline';
import { fmtObs } from './ObservationModal';

const obsValues = (series) => (Array.isArray(series) ? series.map((p) => (p ? p.v : null)) : []);

/**
 * Episodes the agent is watching: over their line for a poll or two, not yet an
 * incident. Shell is the page's ModalShell (it lives in OpsAgentPage.jsx, which
 * imports this file, so it is passed in). pulse changes whenever the agent
 * moves, which refetches the list.
 */
export default function WatchListModal({ onClose, Shell, onOpenObservation, pulse }) {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(null);

  const load = useCallback(() => client.get('/ops-agent/observations', { params: { scope: 'watching' } })
    .then(({ data }) => { setRows(Array.isArray(data) ? data : []); setFailed(null); })
    .catch((e) => setFailed(e?.response?.data?.error || 'Failed to load the watch list.')), []);
  useEffect(() => { load(); }, [load, pulse]);

  return (
    <Shell size="md" icon={Eye} onClose={onClose} title="Watching"
      subtitle={rows ? `${rows.length} episode${rows.length === 1 ? '' : 's'} over the line but not yet an incident` : null}>
      {failed ? <p className="text-sm text-status-crit py-6 text-center">{failed}</p>
        : rows == null ? <LoadingPanel label="Loading the watch list..." height={120} />
        : rows.length === 0 ? (
          <p className="text-sm text-ink-muted py-6 text-center">Nothing is being watched. A VM or host over its line for one poll appears here; it becomes an incident only when it stays there or keeps coming back.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-1.5 pr-3 font-medium">Subject</th>
                <th className="py-1.5 pr-3 font-medium">Metric</th>
                <th className="py-1.5 pr-3 font-medium text-right">Now</th>
                <th className="py-1.5 pr-3 font-medium text-right">Peak</th>
                <th className="py-1.5 pr-3 font-medium text-right">Elevated</th>
                <th className="py-1.5 pr-3 font-medium">Since</th>
                <th className="py-1.5 font-medium">Trend</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} tabIndex={0} role="button" title="Open the observation" data-testid="watch-row"
                    onClick={() => onOpenObservation?.(r.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenObservation?.(r.id); } }}
                    className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay focus:bg-surface-overlay outline-none">
                    <td className="py-2 pr-3 text-ink">
                      {r.subject}
                      {r.hold && <Badge tone="info" className="ml-2">new VM</Badge>}
                      {r.hold && (
                        <div className="text-[11px] text-ink-faint font-normal" data-testid="watch-hold">
                          Held: {r.hold.reason} until {r.hold.until ? new Date(r.hold.until).toLocaleString() : '-'}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{r.label}</td>
                    <td className="py-2 pr-3 text-right tnum">{fmtObs(r.value, r.unit)}</td>
                    <td className="py-2 pr-3 text-right tnum">{fmtObs(r.peak, r.unit)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.elevatedSamples}/{r.samples}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{timeAgo(r.openedAt)}</td>
                    <td className="py-2"><Sparkline values={obsValues(r.series)} color="#38BDF8" width={90} height={22} fill={false} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Shell>
  );
}
