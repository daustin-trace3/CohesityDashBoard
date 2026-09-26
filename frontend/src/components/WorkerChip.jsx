import { Badge, timeAgo } from './ui/primitives';

function upFor(sec) {
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Polling and the Ops Agent tick run in the poller process, not in this page.
 * The poller process writes a heartbeat every 30s, so a page can say outright
 * whether background work is happening while nobody is watching, instead of
 * leaving a stale timestamp to be read as "it only runs when I look".
 */
export default function WorkerChip({ worker }) {
  const [tone, text, why] = !worker
    ? ['crit', 'Background worker not reporting',
      'The poller process has never written a heartbeat: either it is not running, or it is running a build older than this page. While it is down nothing polls and the agent never ticks.']
    : !worker.alive
      ? ['crit', `Background worker silent since ${timeAgo(worker.at)}`,
        `pid ${worker.pid}, started ${worker.startedAt}. A heartbeat is due every 30s and this one is stale, so the process is stopped, suspended or blocked.`]
      : ['ok', `Background worker up ${upFor(worker.uptimeSeconds)}`,
        `${worker.role}, pid ${worker.pid}, last heartbeat ${worker.ageSeconds}s ago. The uptime resets whenever the process restarts.`];
  return <span title={why}><Badge tone={tone}>{text}</Badge></span>;
}
