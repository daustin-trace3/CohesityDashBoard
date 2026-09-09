import { useEffect, useState, useCallback } from 'react';
import { Server } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtWhen, connectedTone, connectedLabel, deployStatusTone } from './helpers';

export default function BluecatServersPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/bluecat/servers')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load servers' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Servers" description="BlueCat DNS/DHCP servers and their deployment status">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {rows == null ? (
        <LoadingPanel label="Loading servers…" height={160} />
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
                    <p className="text-[11px] text-ink-faint truncate">{s.address || '—'}{s.sourceName ? ` · ${s.sourceName}` : ''}</p>
                  </div>
                  <Badge tone={connectedTone(s.connected)}>{connectedLabel(s.connected)}</Badge>
                </div>
                <p className="text-[11px] text-ink-muted mb-2">
                  {s.profile || 'Unknown profile'}{s.version ? ` · v${s.version}` : ''}
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
