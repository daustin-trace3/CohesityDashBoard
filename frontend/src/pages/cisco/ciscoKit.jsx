// Small pieces shared by the Cisco switching and routing analytics pages.
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { DASH } from '../logicmonitor/helpers';
import { BRAND, OLDER_VERSION } from './ciscoShared';

export const n = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
export const fmt1 = (v, unit = '') => (n(v) == null ? DASH : `${Math.round(Number(v) * 10) / 10}${unit}`);
export const stateTone = (s) => (s === 'failed' ? 'crit' : s === 'degraded' ? 'warn' : s === 'ok' ? 'ok' : 'neutral');
export const sevTone = (s) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'neutral');

// A forecast cell: days (an estimate) with its basis text underneath, or "insufficient data".
// f is { days, text } from the service; a bare number falls back to a short basis note.
export function ForecastCell({ f }) {
  const days = n(f?.days);
  const text = f?.text || (days == null ? 'insufficient data' : 'estimate');
  if (days == null) return <span className="text-[11px] text-ink-faint" title={text}>{text}</span>;
  return (
    <span className="tnum" title={text}>
      <span className="text-ink text-[12px]">{`${days < 1 ? '< 1' : Math.round(days)} d`}</span>
      <span className="block text-[10px] text-ink-faint max-w-[190px] truncate">{text}</span>
    </span>
  );
}

// Page frame: header, load and error states, and the "feed missing" note when the connector has not shipped it.
export function AnalyticsFrame({ icon, title, description, state, empty, emptyText, children }) {
  const { data, error, loading, reload, loadedAt } = state;
  const shapeOk = !!data && typeof data === 'object';
  return (
    <div className="animate-fade-in">
      <PageHeader icon={icon} title={title} description={description}>
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>
      {error && <p className="text-sm text-status-crit mb-3">{error}</p>}
      {!error && !loading && !shapeOk && <p className="text-sm text-status-warn mb-3">{OLDER_VERSION}</p>}
      {loading ? <LoadingPanel label={`Loading ${title.toLowerCase()}...`} height={200} /> : shapeOk && data.available === false ? (
        <div className="panel p-6 text-sm text-ink-muted text-center" style={{ borderTop: `3px solid ${BRAND}` }}>
          {emptyText || 'The LogicMonitor connector does not provide this data yet. The page fills in once the connector update is installed.'}
        </div>
      ) : shapeOk && empty ? (
        <div className="panel p-6 text-sm text-ink-muted text-center" style={{ borderTop: `3px solid ${BRAND}` }}>{emptyText || 'Nothing to show yet.'}</div>
      ) : shapeOk ? children : null}
    </div>
  );
}

export const Chip = ({ children, tone = 'neutral' }) => <Badge tone={tone}>{children}</Badge>;
