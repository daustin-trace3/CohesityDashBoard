import { fmtNum, fmtMs } from '../helpers';
import Sparkline from './Sparkline';
import { COLORS } from './layout';
import { useHoverCard } from '../../../components/ui/HoverCard';

const list = (v) => (Array.isArray(v) ? v : []);
const RANK = { critical: 3, warning: 2 };
const rank = (s) => RANK[String(s || '').toLowerCase()] || 1;
const tone = (s) => (rank(s) === 3 ? COLORS.crit : rank(s) === 2 ? COLORS.warn : COLORS.ok);
const label = (s) => (rank(s) === 3 ? 'CRITICAL' : rank(s) === 2 ? 'WARNING' : 'OK');

// Worst state first, then by name.
export function sortSites(nodes) {
  return list(nodes).filter((n) => n && n.siteKey != null).slice()
    .sort((a, b) => rank(b.state) - rank(a.state) || String(a.siteName || a.siteKey).localeCompare(String(b.siteName || b.siteKey)));
}

function tipFor(n) {
  const w = n.reachability && n.reachability.worst;
  if (!w || typeof w !== 'object') return '';
  const from = w.fromLabel || w.checkpointLabel || w.from || '';
  const rtt = w.rttAvgMs != null ? fmtMs(w.rttAvgMs) : null;
  const loss = w.lossPct != null ? `loss ${w.lossPct}%` : null;
  const dir = n.reachability.direction;
  const prefix = dir === 'in' ? 'Inbound: ' : dir === 'out' ? 'From this site: ' : '';
  return prefix + [`Worst check: ${w.checkName || 'unnamed'}`, from ? `from ${from}` : null, rtt, loss].filter(Boolean).join(', ');
}

function Count({ n, label: l, color }) {
  const v = Number(n) || 0;
  return (
    <span>
      <b className="text-[13px] font-bold tnum" style={{ color: v > 0 ? color : '#5F7081' }}>{fmtNum(v)}</b>
      <span className="text-[10px] text-ink-muted"> {l}</span>
    </span>
  );
}

// WAN state of a site (round 13): ok / degraded / down, or null when the site has no WAN circuit.
const WAN = {
  ok: { letter: 'OK', color: COLORS.ok, word: 'up' },
  degraded: { letter: 'DEG', color: COLORS.warn, word: 'degraded' },
  down: { letter: 'DOWN', color: COLORS.crit, word: 'down' },
};
const wanOf = (n) => WAN[String(n.wanState || '').toLowerCase()] || null;

function wanSentence(n) {
  const w = wanOf(n);
  if (!w) return 'No WAN circuit identified at this site.';
  const total = Number(n.wanTotal) || 0;
  const down = Number(n.wanDown) || 0;
  if (String(n.wanState).toLowerCase() === 'down') return `WAN down: ${down} of ${total} circuit(s) down. The site has no WAN path.`;
  if (String(n.wanState).toLowerCase() === 'degraded') {
    return down > 0
      ? `WAN degraded: running on ${Math.max(0, total - down)} of ${total} circuit(s). The site is still reachable.`
      : 'WAN degraded: a circuit is flapping. The site is still reachable.';
  }
  return `WAN up: ${total} circuit(s) up.`;
}

function NameList({ title, names, color, more }) {
  const l = list(names);
  if (!l.length) return null;
  return (
    <div className="mt-1.5">
      <p className="font-semibold" style={{ color }}>{title}</p>
      {l.slice(0, 10).map((x, i) => <p key={i} className="text-ink-muted truncate">{x}</p>)}
      {more > 0 && <p className="text-ink-faint">{`and ${more} more`}</p>}
    </div>
  );
}

export function SiteHoverBody({ n }) {
  const dead = list(n.deadDevices);
  const degraded = list(n.degradedDevices);
  const ports = list(n.portsDownNames);
  const issuesTop = list(n.issuesTop);
  const deadMore = Math.max(0, (Number(n.devicesDead) || 0) - dead.length);
  const portsMore = Math.max(0, (Number(n.interfacesDown) || 0) - ports.length);
  const w = n.watch || {};
  const episodes = (Number(w.critical) || 0) + (Number(w.degrading) || 0);
  const clean = !dead.length && !degraded.length && !ports.length && !episodes && !issuesTop.length && !(Number(n.openIssues) > 0);
  return (
    <div data-testid="site-hover">
      <p className="text-[13px] font-bold text-ink">{n.siteName || String(n.siteKey)}</p>
      <p style={{ color: (wanOf(n) || {}).color || '#94A3B3' }}>{wanSentence(n)}</p>
      {list(n.reasons).map((r, i) => <p key={i} className="text-ink" data-testid="site-reason">{r}</p>)}
      {Number(n.circuitsDown) > 0 && <p className="text-status-warn">{`${n.circuitsDown} circuit(s) down`}</p>}
      <NameList title={`Dead devices (${fmtNum(n.devicesDead)})`} names={dead} color={COLORS.crit} more={deadMore} />
      <NameList title="Degraded devices" names={degraded} color={COLORS.warn} />
      {(Number(n.openIssues) > 0 || issuesTop.length > 0) && (
        <div className="mt-1.5">
          <p className="font-semibold" style={{ color: COLORS.warn }}>{`Open issues (${fmtNum(n.openIssues ?? issuesTop.length)})`}</p>
          {issuesTop.slice(0, 5).map((i, k) => {
            const t = String(i.target || '');
            return <p key={k} className="text-ink-muted truncate" title={t}>{`${i.severity} ${i.type}: ${t.length > 60 ? `${t.slice(0, 59)}~` : t}`}</p>;
          })}
        </div>
      )}
      <NameList title={`Ports down (${fmtNum(n.interfacesDown)})`} names={ports} color={COLORS.warn} more={portsMore} />
      {episodes > 0 && (
        <p className="mt-1.5" style={{ color: w.critical > 0 ? COLORS.crit : COLORS.warn }}>
          {`Open latency episodes: ${fmtNum(w.critical || 0)} critical, ${fmtNum(w.degrading || 0)} degrading`}
        </p>
      )}
      {clean && <p className="mt-1.5 text-ink-faint">No dead devices, down ports or open episodes.</p>}
      <p className="mt-2 text-ink-faint">Click opens Site 360.</p>
    </div>
  );
}

function SiteChip({ n, onOpenSite }) {
  const col = tone(n.state);
  const wan = wanOf(n);
  const series = n.reachability && Array.isArray(n.reachability.series) ? n.reachability.series : null;
  const { bind, card } = useHoverCard(<SiteHoverBody n={n} />);
  return (
    <div
      {...bind}
      role="button"
      tabIndex={0}
      title={tipFor(n) || undefined}
      data-testid="site-chip"
      onClick={() => onOpenSite(n.siteKey)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpenSite(n.siteKey); }}
      className="relative overflow-hidden min-w-0 rounded-lg border bg-surface px-2.5 pt-2 pb-1.5 cursor-pointer transition-all hover:-translate-y-0.5 hover:border-[#2b3b4b] hover:bg-surface-raised"
      style={{ borderColor: `${col}66` }}
    >
      <span className="absolute left-0 right-0 top-0 h-[2px]" style={{ background: col }} />
      <p className="flex items-center justify-between text-[9px] font-bold tracking-wide leading-tight" style={{ color: col }}>
        <span>{label(n.state)}</span>
        {wan && (
          <span className="inline-flex items-center gap-1" data-testid="site-wan" style={{ color: wan.color }}>
            <i className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: wan.color }} />WAN {wan.letter}
          </span>
        )}
      </p>
      <p className="text-[12px] font-bold text-ink truncate leading-snug" title={n.siteName || String(n.siteKey)}>{n.siteName || String(n.siteKey)}</p>
      <p className="flex items-baseline gap-1 leading-snug">
        <Count n={n.devicesDead} l="dead" color={COLORS.crit} />
        <span className="text-[10px] text-ink-faint">-</span>
        <Count n={n.interfacesDown} l="down" color={COLORS.warn} />
      </p>
      {(n.watch && (n.watch.critical > 0 || n.watch.degrading > 0)) && (
        <p className="text-[9px] font-semibold leading-tight" data-testid="site-watch"
          style={{ color: n.watch.critical > 0 ? COLORS.crit : COLORS.warn }}
          title="Open latency watch episodes at this site (Site Reachability page)">
          {n.watch.critical > 0 ? `${fmtNum(n.watch.critical)} critical` : `${fmtNum(n.watch.degrading)} degrading`}{' '}latency
        </p>
      )}
      {series && <div className="mt-0.5"><Sparkline values={series} color={col} width={114} height={14} stretch /></div>}
      {card}
    </div>
  );
}

export default function SitesBand({ nodes, onOpenSite }) {
  const sites = sortSites(nodes);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mx-1 mb-2.5">
        <b className="text-[13px] font-bold text-ink">Sites</b>
        <span className="text-[11px] text-ink-muted">{fmtNum(sites.length)} sites, worst first. Sparkline is 24 h RTT, inbound or from the site's collector. Click opens Site 360.</span>
      </div>
      {sites.length === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No sites derived yet. Sites come from device groups and hostname prefixes once a portal has been polled.
        </div>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {sites.map((n) => <SiteChip key={n.siteKey} n={n} onOpenSite={onOpenSite} />)}
        </div>
      )}
    </div>
  );
}
