import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ExternalLink, AlertTriangle, Building2, Boxes, Layers } from 'lucide-react';
import client from '../api/client';

const HEALTH_DOT = {
  ok: 'bg-status-ok',
  warning: 'bg-status-warn',
  critical: 'bg-status-crit',
  unknown: 'bg-ink-faint',
};

const fnum = (v) => Number(v || 0).toLocaleString('en-US');

function fmtAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function tenantHealth(t) {
  if (!t.enabled) return 'unknown';
  if (t.lastFetchOk === false) return 'critical';
  if (!t.summary) return 'unknown';
  const { critical, warning } = t.summary.totals || {};
  if (critical) return 'critical';
  if (warning) return 'warning';
  return 'ok';
}

function StatCard({ icon: Icon, label, value, tone }) {
  return (
    <div className="panel px-4 py-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tone || 'bg-brand/10 text-brand'}`}>
        <Icon size={17} />
      </div>
      <div>
        <p className="text-lg font-bold text-ink tnum leading-tight">{value}</p>
        <p className="text-[11px] text-ink-muted">{label}</p>
      </div>
    </div>
  );
}

export default function PortalHome() {
  const [tenants, setTenants] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await client.get('/tenants');
      setTenants(data.tenants);
      setError(null);
    } catch {
      setError('Failed to load tenants.');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const { data } = await client.post('/tenants/refresh-all');
      setTenants(data.tenants);
    } catch {
      setError('Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  };

  if (tenants === null) {
    return <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-28" />)}</div>;
  }

  const enabled = tenants.filter((t) => t.enabled);
  const totals = enabled.reduce((acc, t) => {
    const s = t.summary?.totals;
    if (s) {
      acc.platforms += s.platforms || 0;
      acc.objects += s.objects || 0;
      acc.critical += s.critical || 0;
      acc.warning += s.warning || 0;
    }
    return acc;
  }, { platforms: 0, objects: 0, critical: 0, warning: 0 });

  const attention = enabled
    .flatMap((t) => (t.summary?.attention || []).map((a) => ({ ...a, tenant: t.name, tenantUrl: t.url })))
    .sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) || b.count - a.count)
    .slice(0, 12);

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Tenant Overview</h1>
          <p className="text-xs text-ink-muted mt-0.5">Cross-customer estate health, rolled up every 5 minutes.</p>
        </div>
        <button
          onClick={refreshAll}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink rounded-lg hover:border-brand/50 hover:text-brand disabled:opacity-50 transition-colors cursor-pointer"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh all
        </button>
      </div>

      {error && <p className="text-xs text-status-crit">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Building2} label="Tenants" value={fnum(enabled.length)} />
        <StatCard icon={Layers} label="Platforms" value={fnum(totals.platforms)} />
        <StatCard icon={Boxes} label="Objects" value={fnum(totals.objects)} />
        <StatCard
          icon={AlertTriangle}
          label="Critical / Warning"
          value={`${fnum(totals.critical)} / ${fnum(totals.warning)}`}
          tone={totals.critical ? 'bg-status-crit/10 text-status-crit' : 'bg-status-warn/10 text-status-warn'}
        />
      </div>

      {tenants.length === 0 && (
        <div className="panel px-5 py-10 text-center">
          <p className="text-sm text-ink-muted">
            No tenants registered yet. Add your first ICC instance under{' '}
            <Link to="/tenants" className="text-brand hover:underline">Tenants</Link>.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4 stagger-rows">
        {tenants.map((t, i) => {
          const health = tenantHealth(t);
          return (
            <div key={t.id} className="panel panel-hover p-4 flex flex-col gap-3" style={{ '--stagger-i': i }}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${HEALTH_DOT[health]}`} />
                  <p className="text-sm font-bold text-ink truncate">{t.name}</p>
                  {!t.enabled && <span className="chip border-cohesity-border text-ink-faint">disabled</span>}
                </div>
                <a
                  href={t.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] font-medium text-brand hover:text-brand-bright transition-colors flex-shrink-0"
                >
                  Open ICC <ExternalLink size={11} />
                </a>
              </div>

              {t.lastFetchOk === false ? (
                <p className="text-xs text-status-crit leading-relaxed">{t.lastFetchError || 'Unreachable'}</p>
              ) : !t.summary ? (
                <p className="text-xs text-ink-faint">No data yet.</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {t.summary.platforms.map((p) => (
                      <span
                        key={p.id}
                        className="chip border-cohesity-border text-ink-muted"
                        style={p.color ? { borderColor: `${p.color}55`, color: p.color } : undefined}
                        title={`${p.label}: ${fnum(p.objects)} objects`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${HEALTH_DOT[p.health] || 'bg-ink-faint'}`} />
                        {p.label}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-ink-muted tnum">
                    <span>{fnum(t.summary.totals?.objects)} objects</span>
                    {t.summary.totals?.critical > 0 && (
                      <span className="text-status-crit font-semibold">{fnum(t.summary.totals.critical)} critical</span>
                    )}
                    {t.summary.totals?.warning > 0 && (
                      <span className="text-status-warn font-semibold">{fnum(t.summary.totals.warning)} warning</span>
                    )}
                  </div>
                </>
              )}

              <p className="text-[10px] text-ink-faint mt-auto">Updated {fmtAgo(t.lastFetchAt)}</p>
            </div>
          );
        })}
      </div>

      {attention.length > 0 && (
        <div className="panel">
          <div className="px-4 py-3 border-b border-cohesity-border flex items-center gap-2">
            <AlertTriangle size={14} className="text-status-warn" />
            <p className="panel-title">Needs attention</p>
          </div>
          <div className="divide-y divide-cohesity-border/60">
            {attention.map((a, i) => (
              <div key={i} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${a.severity === 'critical' ? 'bg-status-crit' : 'bg-status-warn'}`} />
                <span className="text-ink-muted flex-shrink-0 w-40 truncate font-medium">{a.tenant}</span>
                <span className="text-ink flex-1 min-w-0 truncate">{a.text}</span>
                <span className="text-ink-faint flex-shrink-0">{a.platform}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
