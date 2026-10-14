import { fmtNum, fmtMs } from '../helpers';
import Sparkline from './Sparkline';
import { COLORS } from './layout';

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
      <b className="text-[15px] font-bold tnum" style={{ color: v > 0 ? color : '#5F7081' }}>{fmtNum(v)}</b>
      <span className="text-[11px] text-ink-muted"> {l}</span>
    </span>
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
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {sites.map((n) => {
            const col = tone(n.state);
            const series = n.reachability && Array.isArray(n.reachability.series) ? n.reachability.series : null;
            return (
              <div
                key={n.siteKey}
                role="button"
                tabIndex={0}
                title={tipFor(n) || undefined}
                data-testid="site-chip"
                onClick={() => onOpenSite(n.siteKey)}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpenSite(n.siteKey); }}
                className="relative overflow-hidden min-w-0 rounded-xl border bg-surface px-3 pt-3 pb-2 cursor-pointer transition-all hover:-translate-y-0.5 hover:border-[#2b3b4b] hover:bg-surface-raised"
                style={{ borderColor: `${col}66` }}
              >
                <span className="absolute left-0 right-0 top-0 h-[2px]" style={{ background: col }} />
                <p className="text-[10px] font-bold tracking-wide" style={{ color: col }}>{label(n.state)}</p>
                <p className="text-[13px] font-bold text-ink truncate mt-0.5" title={n.siteName || String(n.siteKey)}>{n.siteName || String(n.siteKey)}</p>
                <p className="flex items-baseline gap-1.5 my-1.5">
                  <Count n={n.devicesDead} l="dead" color={COLORS.crit} />
                  <span className="text-[11px] text-ink-faint">-</span>
                  <Count n={n.interfacesDown} l="down" color={COLORS.warn} />
                </p>
                {series && <Sparkline values={series} color={col} width={114} height={28} stretch />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
