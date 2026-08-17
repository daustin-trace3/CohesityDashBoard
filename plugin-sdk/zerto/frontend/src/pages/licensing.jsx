// Zerto Licensing — ported from frontend/src/pages/zerto/ZertoLicensingPage.jsx.
import { BadgeCheck, MonitorSmartphone, CalendarClock, Globe2, AlertTriangle } from '../icons.jsx';
import { apiFetch, PageHeader, Panel, StatCard, Badge, LoadingPanel, LastUpdated, BRAND, fmtNum } from '../ui.jsx';

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
  return Number.isFinite(d) ? d : null;
}

export default function ZertoLicensingPage() {
  const [licenses, setLicenses] = React.useState(null);

  React.useEffect(() => {
    apiFetch('/zerto/licenses')
      .then((json) => setLicenses(Array.isArray(json) ? json : []))
      .catch(() => setLicenses([]));
  }, []);

  const totals = React.useMemo(() => {
    if (!licenses?.length) return null;
    const used = licenses.reduce((s, l) => s + (l.usedVms || 0), 0);
    const available = licenses.reduce((s, l) => s + (l.availableVms || 0), 0);
    const expiry = licenses.map((l) => l.expirationDate).filter(Boolean).sort()[0] || null;
    return { used, available, pct: available ? Math.round((used / available) * 100) : null, expiry };
  }, [licenses]);

  if (licenses === null) return <LoadingPanel label="Loading license data…" />;

  const expiryDays = daysUntil(totals?.expiry);
  const licAlerts = (licenses || []).flatMap((l) => l.alerts || []);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={BadgeCheck} title="Zerto Licensing" description="License entitlement and per-site consumption — usage is counted in protected VMs">
        <LastUpdated date={licenses[0]?.updatedAt} prefix="Updated" />
      </PageHeader>

      {licenses.length === 0 ? (
        <Panel><p className="text-sm text-ink-muted py-6 text-center">
          No license data yet — it arrives with the next Zerto poll, or use Refresh on the Overview page.
        </p></Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard icon={BadgeCheck} label="Licensed VMs" value={fmtNum(totals.available)}
              sub={licenses.length === 1 ? licenses[0].licensePackage || 'allocated' : `${licenses.length} licenses`} tone="brand" />
            <StatCard icon={MonitorSmartphone} label="VMs Used" value={fmtNum(totals.used)}
              tone={totals.pct >= 95 ? 'crit' : totals.pct >= 80 ? 'warn' : 'ok'}
              sub={totals.pct != null ? `${totals.pct}% of entitlement` : undefined} />
            <StatCard icon={MonitorSmartphone} label="Headroom" value={fmtNum(totals.available - totals.used)}
              sub="VMs before license limit" />
            <StatCard icon={CalendarClock} label="Support Ends" value={totals.expiry ? String(totals.expiry).slice(0, 10) : '—'}
              tone={expiryDays == null ? 'default' : expiryDays <= 30 ? 'crit' : expiryDays <= 90 ? 'warn' : 'ok'}
              sub={expiryDays != null ? `${fmtNum(expiryDays)} days remaining` : undefined} />
          </div>

          {licAlerts.length > 0 && (
            <div className="panel p-4 mb-4">
              <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><AlertTriangle size={15} className="text-brand" /> License alerts</p>
              <div className="flex flex-col gap-2">
                {licAlerts.map((a, i) => (
                  <div key={a.identifier || i} className="flex items-center gap-2 bg-surface-overlay rounded-lg px-3 py-2">
                    <Badge tone={String(a.severity).toLowerCase() === 'error' ? 'crit' : 'warn'}>{a.severity || 'Warning'}</Badge>
                    <span className="text-sm text-ink">{a.description || a.type}</span>
                    {a.site?.name && <span className="text-xs text-ink-faint ml-auto">{a.site.name}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {licenses.map((l) => {
            const sites = [...(l.siteUsage || [])].sort((a, b) => (b.packageUsedVMsCount || 0) - (a.packageUsedVMsCount || 0));
            const siteTotal = sites.reduce((s, x) => s + (x.packageUsedVMsCount || 0), 0);
            return (
              <div key={l.licenseKey} className="panel p-4 mb-4">
                <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                  <p className="text-sm font-semibold text-ink flex items-center gap-2"><Globe2 size={15} className="text-brand" />
                    {`Usage by site${licenses.length > 1 ? ` — ${l.licensePackage || l.licenseKey.slice(0, 8)}` : ''}`}
                  </p>
                  <span className="text-[11px] text-ink-faint tnum">{fmtNum(l.usedVms)} of {fmtNum(l.availableVms)} VMs · key …{l.licenseKey.slice(-6)}</span>
                </div>
                {sites.length === 0 ? (
                  <p className="text-sm text-ink-muted py-4 text-center">No per-site usage reported for this license.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                          <th className="py-2 pr-3">Site</th>
                          <th className="py-2 pr-3 text-right">Protected VMs</th>
                          <th className="py-2 pr-3 w-2/5">Share of usage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sites.map((s) => {
                          const share = siteTotal ? (s.packageUsedVMsCount || 0) / siteTotal : 0;
                          return (
                            <tr key={s.siteIdentifier || s.siteName} className="border-b border-cohesity-border/50 last:border-0">
                              <td className="py-2 pr-3 text-ink">{s.siteName || s.siteIdentifier}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(s.packageUsedVMsCount)}</td>
                              <td className="py-2 pr-3">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, background: BRAND }} />
                                  </div>
                                  <span className="text-[11px] text-ink-faint tnum w-10 text-right">{Math.round(share * 100)}%</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
