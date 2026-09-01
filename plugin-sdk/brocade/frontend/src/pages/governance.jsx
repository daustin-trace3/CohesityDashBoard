import { ShieldCheck, GitCommitVertical, ShieldAlert, Lock, Users, KeyRound, Radio } from '../icons.jsx';
import client from '../api.js';
import { useToast, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtWhen } from '../ui.jsx';

function Section({ icon: Icon, title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Icon size={15} className="text-brand" /> {title}</p>
      {children}
    </div>
  );
}

function NavChip({ count, tone }) {
  if (!count) return null;
  const cls = tone === 'crit' ? 'bg-status-crit/15 text-status-crit'
    : tone === 'warn' ? 'bg-status-warn/15 text-status-warn'
    : 'bg-surface-overlay text-ink-faint';
  return <span className={`ml-auto tnum text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${cls}`}>{count}</span>;
}

export default function BrocadeGovernancePage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = ReactRouterDOM.useSearchParams();
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [rawSection, setSection] = React.useState(searchParams.get('section') || 'firmware');
  const [fabricDetail, setFabricDetail] = React.useState(null);
  const section = ['firmware', 'eos', 'certs', 'zoning', 'maps', 'server'].includes(rawSection) ? rawSection : 'firmware';

  const load = React.useCallback(() => client.get('/brocade/governance')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({}); toast({ type: 'error', title: 'Failed to load governance data' }); }), [toast]);

  React.useEffect(() => { load(); }, [load]);

  const selectSection = (id) => {
    setSection(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('section', id);
      return next;
    }, { replace: true });
  };

  const firmware = data?.firmware || [];
  const eos = data?.eos || [];
  const fosLifecycle = data?.fosLifecycle || [];
  const certs = data?.certs || [];
  const zoneAccess = data?.zoneAccess || [];
  const mapsCallhome = data?.mapsCallhome || [];
  const passwordPolicy = data?.passwordPolicy;
  const users = data?.users || [];
  const roles = data?.roles || [];
  const aors = data?.aors || [];
  const recentZoneChanges = data?.recentZoneChanges || [];

  const nav = React.useMemo(() => {
    const driftCount = firmware.filter((f) => f.drift).length;
    const certWarn = certs.filter((c) => c.daysLeft <= 60).length;
    const certCrit = certs.some((c) => c.daysLeft < 0);
    const mapsOff = mapsCallhome.filter((m) => !m.mapsEnabled).length;
    const eosPast = fosLifecycle.filter((s) => s.status === 'eos' || s.status === 'lsa').length || eos.length;
    const eosNearing = fosLifecycle.filter((s) => s.status === 'nearing').length;
    return [
      { id: 'firmware', label: 'Firmware Compliance', icon: GitCommitVertical, count: driftCount, tone: driftCount ? 'warn' : 'default' },
      { id: 'eos', label: 'End-of-Support', icon: ShieldAlert, count: eosPast + eosNearing, tone: eosPast ? 'crit' : eosNearing ? 'warn' : 'default' },
      { id: 'certs', label: 'Certificates', icon: Lock, count: certWarn, tone: certCrit ? 'crit' : certWarn ? 'warn' : 'default' },
      { id: 'zoning', label: 'Zone Security', icon: ShieldCheck, count: zoneAccess.length, tone: zoneAccess.length ? 'warn' : 'default' },
      { id: 'maps', label: 'MAPS / Call-home', icon: Radio, count: mapsOff, tone: mapsOff ? 'warn' : 'default' },
      { id: 'server', label: 'SANnav Server', icon: KeyRound, count: 0, tone: 'default' },
    ];
  }, [firmware, eos, fosLifecycle, certs, zoneAccess, mapsCallhome]);

  if (data == null) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={ShieldCheck} title="Governance" description="Firmware compliance, security posture and SANnav administration" />
        <LoadingPanel label="Loading governance…" height={300} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Governance" description="Firmware compliance, security posture and SANnav administration">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex gap-4 items-start">
        <div className="panel p-2 w-56 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => selectSection(n.id)}
              className={`flex items-center gap-2 w-full text-left text-xs rounded-lg px-2.5 py-2 transition-colors cursor-pointer ${
                section === n.id ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay/60'
              }`}
            >
              <n.icon size={14} className={section === n.id ? 'text-brand' : 'text-ink-faint'} />
              <span className="truncate">{n.label}</span>
              <NavChip count={n.count} tone={n.tone} />
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {section === 'firmware' && (
            <>
              <Section icon={GitCommitVertical} title="Firmware Compliance">
                {firmware.length === 0 ? (
                  <p className="text-sm text-ink-muted py-4 text-center">No fabric firmware data.</p>
                ) : (
                  <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-1.5">
                    {firmware.map((f) => (
                      <button
                        key={f.fabricName}
                        type="button"
                        onClick={() => setFabricDetail(fabricDetail === f.fabricName ? null : f.fabricName)}
                        className={`text-left text-xs rounded-lg px-3 py-2 transition-colors cursor-pointer ${
                          fabricDetail === f.fabricName ? 'bg-surface-overlay ring-1 ring-brand/60' : 'bg-surface-overlay hover:ring-1 hover:ring-cohesity-border'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-ink truncate">{f.fabricName}</span>
                          {f.drift && <Badge tone="info">Drift</Badge>}
                        </div>
                        <p className="text-ink-faint mt-0.5">{(f.versions || []).map((v) => `${v.version} (${v.count})`).join(', ')}</p>
                      </button>
                    ))}
                  </div>
                )}
              </Section>
              {fabricDetail && (() => {
                const f = firmware.find((x) => x.fabricName === fabricDetail);
                if (!f) return null;
                return (
                  <div className="mt-4">
                    <Section icon={GitCommitVertical} title={`${f.fabricName} — switches by firmware`}>
                      <div className="flex flex-col gap-2.5">
                        {(f.versions || []).map((v, vi) => (
                          <div key={v.version || vi}>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs text-ink tnum font-semibold">{v.version || 'Unknown'}</span>
                              <span className="text-[11px] text-ink-faint tnum">{v.count} switch{v.count === 1 ? '' : 'es'}</span>
                              {vi === 0 && f.drift ? <Badge tone="ok">Baseline (majority)</Badge>
                                : vi > 0 ? <Badge tone="warn">Out of compliance</Badge> : null}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(v.switches || []).map((name) => (
                                <span key={name} className={`chip ${vi > 0 ? 'bg-status-warn/10 text-status-warn border-status-warn/25' : 'bg-surface-overlay text-ink-muted border-cohesity-border'}`}>{name}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Section>
                  </div>
                );
              })()}
            </>
          )}

          {section === 'eos' && (() => {
            const groups = [
              { key: 'eos', title: 'Past end of support', tone: 'crit', items: fosLifecycle.filter((s) => s.status === 'eos') },
              { key: 'lsa', title: 'Legacy Support & Availability (LSA)', tone: 'warn', items: fosLifecycle.filter((s) => s.status === 'lsa') },
              { key: 'nearing', title: 'Nearing end of support (≤ 12 months)', tone: 'warn', items: fosLifecycle.filter((s) => s.status === 'nearing') },
              { key: 'supported', title: 'Supported', tone: 'ok', items: fosLifecycle.filter((s) => s.status === 'supported') },
              { key: 'unknown', title: 'Unknown firmware train', tone: 'neutral', items: fosLifecycle.filter((s) => s.status === 'unknown') },
            ].filter((g) => g.items.length > 0);
            return (
              <Section icon={ShieldAlert} title="Firmware End-of-Support (FOS lifecycle)">
                {fosLifecycle.length === 0 ? (
                  <p className="text-sm text-ink-muted py-4 text-center">No switch firmware data.</p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {groups.map((g) => (
                      <div key={g.key}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <p className="text-[11px] uppercase tracking-wide text-ink-faint">{g.title}</p>
                          <Badge tone={g.tone}>{g.items.length}</Badge>
                        </div>
                        <div className="grid md:grid-cols-2 gap-1.5">
                          {g.items.map((s) => (
                            <div key={s.id} className="flex items-center justify-between gap-2 text-xs bg-surface-overlay rounded-lg px-3 py-2">
                              <div className="min-w-0">
                                <span className="text-ink truncate block">{s.name}</span>
                                <span className="text-ink-faint">{s.firmware || '—'}{s.fabricName ? ` · ${s.fabricName}` : ''}</span>
                              </div>
                              <div className="text-right shrink-0">
                                {s.status === 'eos' && s.eosDate && (
                                  <><Badge tone="crit">EOS {s.eosDate}</Badge>
                                  <p className="text-[10px] text-ink-faint tnum mt-0.5">{Math.abs(s.eosDays)}d ago</p></>
                                )}
                                {s.status === 'eos' && !s.eosDate && <Badge tone="crit">EOS (SANnav)</Badge>}
                                {s.status === 'lsa' && <Badge tone="warn">LSA since {s.lsaDate}</Badge>}
                                {s.status === 'nearing' && (
                                  <><Badge tone="warn">EOS {s.eosDate}</Badge>
                                  <p className="text-[10px] text-ink-faint tnum mt-0.5">in {s.eosDays}d</p></>
                                )}
                                {s.status === 'supported' && (s.eosDate ? <Badge tone="ok">until {s.eosDate}</Badge> : <Badge tone="ok">Supported</Badge>)}
                                {s.status === 'unknown' && <Badge tone="neutral">—</Badge>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <p className="text-[10px] text-ink-faint pt-2 border-t border-cohesity-border">
                      Dates from Broadcom's FOS release lifecycle (Brocade-SW-Support-RM); firmware end of support, not hardware EOL. SANnav's own EOS flag is honored where the train is unmapped.
                    </p>
                  </div>
                )}
              </Section>
            );
          })()}

          {section === 'certs' && (
            <Section icon={Lock} title="Certificate Expiry">
              {certs.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">No certificate data.</p>
              ) : (
                <div className="grid md:grid-cols-2 gap-1.5">
                  {certs.map((c, i) => (
                    <div key={i} className="flex items-center justify-between text-xs bg-surface-overlay rounded-lg px-3 py-2">
                      <span className="text-ink truncate">{c.name} <span className="text-ink-faint">({c.type})</span></span>
                      <Badge tone={c.daysLeft < 0 ? 'crit' : c.daysLeft <= 60 ? 'warn' : 'ok'}>
                        {c.daysLeft < 0 ? 'Expired' : `${c.daysLeft}d left`}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {section === 'zoning' && (
            <div className="grid xl:grid-cols-2 gap-4 items-start">
              <Section icon={ShieldCheck} title="Zone Security">
                {zoneAccess.length === 0 ? (
                  <p className="text-sm text-status-ok py-4 text-center">No default-access configs found.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {zoneAccess.map((z, i) => (
                      <div key={i} className="flex items-center justify-between text-xs bg-status-warn/10 rounded-lg px-3 py-2">
                        <span className="text-ink">{z.fabricName} — {z.cfgName}</span>
                        <Badge tone="warn">All Access</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
              <Section icon={GitCommitVertical} title="Recent Zone Changes">
                {recentZoneChanges.length === 0 ? (
                  <p className="text-sm text-ink-muted py-4 text-center">No zone changes detected.</p>
                ) : (
                  <div className="flex flex-col gap-1 max-h-[28rem] overflow-y-auto">
                    {recentZoneChanges.map((c, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 text-xs bg-surface-overlay rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <span className="text-ink">{c.fabricName} — {c.changeType}</span>
                          {c.detail && <p className="text-[11px] text-ink-faint truncate">{c.detail}</p>}
                        </div>
                        <span className="text-ink-faint tnum shrink-0">{fmtWhen(c.detectedAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </div>
          )}

          {section === 'maps' && (
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
          )}

          {section === 'server' && (
            <Section icon={KeyRound} title="SANnav Server">
              {passwordPolicy ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 text-xs">
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
          )}
        </div>
      </div>
    </div>
  );
}
