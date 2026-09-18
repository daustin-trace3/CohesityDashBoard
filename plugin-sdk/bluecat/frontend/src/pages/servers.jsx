// Servers - ported from the built-in BluecatServersPage.jsx.
import { Server } from '../icons.jsx';
import client from '../api.js';
import {
  useToast, PageHeader, Badge, LoadingPanel, ErrorPanel, RefreshButton, LastUpdated,
  BRAND, fmtWhen, connectedTone, connectedLabel, deployStatusTone,
} from '../ui.jsx';

export default function BluecatServersPage() {
  const { toast } = useToast();
  const [rows, setRows] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => {
    setFailed(false);
    return client.get('/bluecat/servers')
      .then(({ data }) => { setRows(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
      .catch(() => { setRows(null); setFailed(true); toast({ type: 'error', title: 'Failed to load servers' }); });
  }, [toast]);

  React.useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Servers" description="BlueCat DNS/DHCP servers and their deployment status">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {failed ? (
        <ErrorPanel label="Failed to load servers." onRetry={load} height={160} />
      ) : rows == null ? (
        <LoadingPanel label="Loading servers..." height={160} />
      ) : rows.length === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">No servers found.</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((s) => {
            const roles = Array.isArray(s.roles) ? s.roles : [];
            return (
              <div key={s.id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{s.name || `Server ${s.serverId}`}</p>
                    <p className="text-[11px] text-ink-faint truncate">{s.address || '-'}{s.sourceName ? ` - ${s.sourceName}` : ''}</p>
                  </div>
                  <Badge tone={connectedTone(s.connected)}>{connectedLabel(s.connected)}</Badge>
                </div>
                <p className="text-[11px] text-ink-muted mb-2">
                  {s.profile || 'Unknown profile'}{s.version ? ` - v${s.version}` : ''}
                </p>
                {roles.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {roles.map((r, i) => (
                      <Badge key={i} tone="neutral">{r.roleType || r.type || 'role'}</Badge>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between text-[11px] text-ink-faint mt-2 pt-2 border-t border-cohesity-border/50">
                  <span>Last deploy</span>
                  <span className="flex items-center gap-1.5">
                    <Badge tone={deployStatusTone(s.lastDeployStatus)}>{s.lastDeployStatus || 'unknown'}</Badge>
                    {fmtWhen(s.lastDeployAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
