import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, GitCommitVertical, ShieldAlert, Lock, Users, KeyRound, Radio } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

function Section({ icon: Icon, title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Icon size={15} className="text-brand" /> {title}</p>
      {children}
    </div>
  );
}

export default function BrocadeGovernancePage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/brocade/governance')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({}); toast({ type: 'error', title: 'Failed to load governance data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  if (data == null) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={ShieldCheck} title="Governance" description="Firmware compliance, security posture and SANnav administration" />
        <LoadingPanel label="Loading governance…" height={300} />
      </div>
    );
  }

  const firmware = data.firmware || [];
  const eos = data.eos || [];
  const certs = data.certs || [];
  const zoneAccess = data.zoneAccess || [];
  const mapsCallhome = data.mapsCallhome || [];
  const passwordPolicy = data.passwordPolicy;
  const users = data.users || [];
  const roles = data.roles || [];
  const aors = data.aors || [];
  const recentZoneChanges = data.recentZoneChanges || [];

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Governance" description="Firmware compliance, security posture and SANnav administration">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <Section icon={GitCommitVertical} title="Firmware Compliance">
          {firmware.length === 0 ? (
            <p className="text-sm text-ink-muted py-4 text-center">No fabric firmware data.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {firmware.map((f) => (
                <div key={f.fabricName} className="text-xs bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ink">{f.fabricName}</span>
                    {f.drift && <Badge tone="info">Drift</Badge>}
                  </div>
                  <p className="text-ink-faint mt-0.5">{(f.versions || []).map((v) => `${v.version} (${v.count})`).join(', ')}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section icon={ShieldAlert} title="End-of-Support Switches">
          {eos.length === 0 ? (
            <p className="text-sm text-status-ok py-4 text-center">No EOS switches.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {eos.map((s) => (
                <div key={s.wwn || s.name} className="flex items-center justify-between text-xs bg-surface-overlay rounded-lg px-3 py-2">
                  <span className="text-ink">{s.name}</span>
                  <span className="text-ink-faint">{s.model || s.firmware_version || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section icon={Lock} title="Certificate Expiry">
          {certs.length === 0 ? (
            <p className="text-sm text-ink-muted py-4 text-center">No certificate data.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {certs.map((c, i) => (
                <div key={i} className="flex items-center justify-between text-xs bg-surface-overlay rounded-lg px-3 py-2">
                  <span className="text-ink">{c.name} <span className="text-ink-faint">({c.type})</span></span>
                  <Badge tone={c.daysLeft < 0 ? 'crit' : c.daysLeft <= 60 ? 'warn' : 'ok'}>
                    {c.daysLeft < 0 ? 'Expired' : `${c.daysLeft}d left`}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section icon={ShieldCheck} title="Zone Security">
          {zoneAccess.length === 0 ? (
            <p className="text-sm text-status-ok py-4 text-center">No default-access configs found.</p>
          ) : (
            <div className="flex flex-col gap-1.5 mb-3">
              {zoneAccess.map((z, i) => (
                <div key={i} className="flex items-center justify-between text-xs bg-status-warn/10 rounded-lg px-3 py-2">
                  <span className="text-ink">{z.fabricName} — {z.cfgName}</span>
                  <Badge tone="warn">All Access</Badge>
                </div>
              ))}
            </div>
          )}
          {recentZoneChanges.length > 0 && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">Recent Changes</p>
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                {recentZoneChanges.map((c, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px] text-ink-faint">
                    <span>{c.fabricName} — {c.changeType}</span>
                    <span className="tnum">{fmtWhen(c.detectedAt)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <Section icon={Radio} title="MAPS / Call-home Registration">
          {mapsCallhome.length === 0 ? (
            <p className="text-sm text-ink-muted py-4 text-center">No MAPS/Call-home data reported.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-1.5 pr-3">Switch</th>
                  <th className="py-1.5 pr-3">MAPS</th>
                  <th className="py-1.5 pr-3">Call-home</th>
                  <th className="py-1.5 pr-3">SNMP</th>
                  <th className="py-1.5 pr-3">Syslog</th>
                </tr></thead>
                <tbody>
                  {mapsCallhome.map((m, i) => (
                    <tr key={i} className="border-b border-cohesity-border/40">
                      <td className="py-1.5 pr-3 text-ink">{m.name}</td>
                      <td className="py-1.5 pr-3"><Badge tone={m.mapsEnabled ? 'ok' : 'neutral'}>{m.mapsEnabled ? 'On' : 'Off'}</Badge></td>
                      <td className="py-1.5 pr-3"><Badge tone={m.callhomeEnabled ? 'ok' : 'neutral'}>{m.callhomeEnabled ? 'On' : 'Off'}</Badge></td>
                      <td className="py-1.5 pr-3"><Badge tone={m.snmpRegistered ? 'ok' : 'neutral'}>{m.snmpRegistered ? 'Yes' : 'No'}</Badge></td>
                      <td className="py-1.5 pr-3"><Badge tone={m.syslogRegistered ? 'ok' : 'neutral'}>{m.syslogRegistered ? 'Yes' : 'No'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section icon={KeyRound} title="SANnav Server">
          {passwordPolicy ? (
            <div className="grid grid-cols-2 gap-3 mb-3 text-xs">
              {Object.entries(passwordPolicy).map(([k, v]) => (
                <div key={k}>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">{k}</p>
                  <p className="text-ink tnum">{String(v)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-muted mb-3">No password policy data (insufficient permissions or not fetched).</p>
          )}
          <div className="grid grid-cols-3 gap-3 text-xs pt-3 border-t border-cohesity-border">
            <div className="flex items-center gap-1.5"><Users size={12} className="text-brand" /> {users.length} users</div>
            <div>{roles.length} roles</div>
            <div>{aors.length} AORs</div>
          </div>
        </Section>
      </div>
    </div>
  );
}
