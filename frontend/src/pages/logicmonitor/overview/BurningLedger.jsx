import { Badge } from '../../../components/ui/primitives';
import { fmtNum, fmtSince, fmtWhen, severityTone, toDate } from '../helpers';
import Sparkline from './Sparkline';
import { COLORS } from './layout';

const GRID = 'lg:grid lg:grid-cols-[26px_78px_112px_minmax(0,1fr)_220px_110px_170px] lg:gap-3.5 lg:items-center';

const sevColor = (s) => (s === 'critical' ? COLORS.crit : s === 'warning' ? COLORS.warn : COLORS.info);

function hopText(h) {
  if (!h || typeof h !== 'object') return '';
  return [h.deviceName, h.port].filter(Boolean).join(' ') || h.text || '';
}

export default function BurningLedger({ rows, total, onOpenIssues, onOpenSite }) {
  const list = Array.isArray(rows) ? rows : [];
  const open = Number.isFinite(Number(total)) ? Number(total) : list.length;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mx-1 mb-2.5">
        <b className="text-[13px] font-bold text-ink">Burning, {fmtNum(list.length)} of {fmtNum(open)} open issues</b>
        <span className="text-[11px] text-ink-muted">ranked by severity, then age. Likely hop is the first failing device on the path.</span>
      </div>
      <div className="panel py-1.5">
        {list.length === 0 ? (
          <p className="text-sm text-status-ok py-4 text-center">Nothing is burning. No open issues.</p>
        ) : list.map((r, i) => {
          const row = r || {};
          const sev = String(row.severity || '').toLowerCase();
          const hop = hopText(row.likelyHop);
          const sinceDate = toDate(row.since);
          const age = sinceDate ? fmtSince(Math.max(0, Date.now() - sinceDate.getTime())) : '-';
          const series = row.metric && Array.isArray(row.metric.series) ? row.metric.series : null;
          return (
            <div
              key={row.issueKey || i}
              role="button"
              tabIndex={0}
              onClick={onOpenIssues}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpenIssues(); }}
              className={`${GRID} flex flex-col gap-1.5 px-6 py-3 border-t border-cohesity-border first:border-t-0 cursor-pointer transition-colors hover:bg-surface-raised`}
            >
              <div className="text-xs text-ink-faint tnum hidden lg:block">{i + 1}</div>
              <div><Badge tone={severityTone(sev)}>{sev ? sev.toUpperCase() : 'UNKNOWN'}</Badge></div>
              <div className="text-[13px] font-semibold text-ink min-w-0">
                {row.siteKey ? (
                  <button
                    className="text-left truncate max-w-full hover:underline cursor-pointer"
                    onClick={(e) => { e.stopPropagation(); onOpenSite(row.siteKey); }}
                  >{row.siteName || row.siteKey}</button>
                ) : <span className="text-ink-faint">-</span>}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink truncate" title={row.target || ''}>{row.target || row.type || '-'}</p>
                <p className="text-xs text-ink-muted mt-0.5 leading-snug overflow-hidden" title={row.message || ''} style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{row.message || ''}</p>
              </div>
              <div className="text-xs text-ink-muted min-w-0">
                <span className="block text-[11px] text-ink-faint">Likely hop</span>
                <span className="block text-xs text-ink truncate" title={row.likelyHop && row.likelyHop.text ? row.likelyHop.text : hop}>{hop || '-'}</span>
              </div>
              <div className="text-xs text-ink-muted tnum" title={row.since ? fmtWhen(row.since) : ''}>
                <span className="block text-[11px] text-ink-faint">since</span>
                <span className="block text-ink font-semibold">{age}</span>
              </div>
              <div className="flex items-center lg:justify-end gap-2 text-[11px] text-ink-faint">
                {series && row.metric.label && <span>{row.metric.label}</span>}
                {series && <Sparkline values={series} color={sevColor(sev)} />}
              </div>
            </div>
          );
        })}
        {open > list.length && list.length > 0 && (
          <div className="px-6 pt-2 pb-1 border-t border-cohesity-border">
            <button onClick={onOpenIssues} className="text-xs text-brand cursor-pointer hover:underline">View all {fmtNum(open)} issues</button>
          </div>
        )}
      </div>
    </div>
  );
}
