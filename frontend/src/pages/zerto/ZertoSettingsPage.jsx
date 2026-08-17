import { useEffect, useMemo, useState } from 'react';
import { Settings, Cloud, CheckCircle2, XCircle, BellRing, Search } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

const sevTone = (s) => {
  const n = String(s || '').toLowerCase();
  if (n.includes('error') || n.includes('major')) return 'crit';
  if (n.includes('warning')) return 'warn';
  return 'info';
};

/** Per-alert-type SMTP notification matrix — every known Zerto alert code with
 *  an enable/disable toggle. Disabled codes never generate an SMTP email. */
function AlertTypesSection() {
  const { toast } = useToast();
  const [types, setTypes] = useState(null);
  const [search, setSearch] = useState('');
  const [entitySel, setEntitySel] = useState('');
  const [sevSel, setSevSel] = useState('');
  const [savingCode, setSavingCode] = useState(null);

  useEffect(() => {
    client.get('/zerto/alert-types')
      .then(({ data }) => setTypes(Array.isArray(data) ? data : []))
      .catch(() => setTypes([]));
  }, []);

  const entities = useMemo(
    () => [...new Set((types || []).map((t) => t.entity).filter(Boolean))].sort(),
    [types]
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (types || []).filter((t) =>
      (!entitySel || t.entity === entitySel) &&
      // 'Error/Warning' composite severities match either bucket.
      (!sevSel || String(t.severity || '').toLowerCase().includes(sevSel.toLowerCase())) &&
      (!q || t.code.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)));
  }, [types, search, entitySel, sevSel]);

  const toggle = async (t) => {
    setSavingCode(t.code);
    try {
      await client.put(`/zerto/alert-types/${encodeURIComponent(t.code)}`, { enabled: !t.enabled });
      setTypes((prev) => prev.map((x) => (x.code === t.code ? { ...x, enabled: !t.enabled } : x)));
    } catch (err) {
      toast({ type: 'error', title: `Failed to update ${t.code}`, message: err?.response?.data?.error });
    } finally {
      setSavingCode(null);
    }
  };

  const disabledCount = (types || []).filter((t) => !t.enabled).length;

  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="flex items-center gap-2 mb-1">
        <BellRing size={16} className="text-brand" />
        <p className="text-sm font-semibold text-ink">Alert notifications</p>
      </div>
      <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
        Which Zerto alert types may send SMTP emails. Disabled types are muted — the alert still
        shows in the dashboard, but no email is sent and reminders stop. Codes marked Active have
        alerts firing right now.{disabledCount > 0 && <> <b className="text-ink">{disabledCount}</b> type(s) currently muted.</>}
      </p>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search code or description…"
            className="w-full bg-surface-overlay border border-cohesity-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink outline-none focus:border-brand" />
        </div>
        <select value={entitySel} onChange={(e) => setEntitySel(e.target.value)}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand" aria-label="Entity">
          <option value="">All entities</option>
          {entities.map((en) => <option key={en} value={en}>{en}</option>)}
        </select>
        <select value={sevSel} onChange={(e) => setSevSel(e.target.value)}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand" aria-label="Severity">
          <option value="">All severities</option>
          <option value="Error">Error</option>
          <option value="Warning">Warning</option>
          <option value="Major">Major</option>
        </select>
        {types && <span className="text-[11px] text-ink-faint tnum ml-auto">{shown.length} of {types.length} types</span>}
      </div>

      {types == null ? (
        <LoadingPanel label="Loading alert types…" height={120} />
      ) : (
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto border border-cohesity-border/60 rounded-lg">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 px-3">Code</th>
                <th className="py-2 pr-3">Severity</th>
                <th className="py-2 pr-3">Entity</th>
                <th className="py-2 pr-3">Description</th>
                <th className="py-2 pr-3 text-right">Active</th>
                <th className="py-2 pr-3 text-right">Email</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.code} className={`border-b border-cohesity-border/40 ${t.enabled ? '' : 'opacity-60'}`}>
                  <td className="py-1.5 px-3 font-semibold tnum whitespace-nowrap">{t.code}</td>
                  <td className="py-1.5 pr-3">{t.severity ? <Badge tone={sevTone(t.severity)}>{t.severity}</Badge> : '—'}</td>
                  <td className="py-1.5 pr-3 text-ink-muted text-xs whitespace-nowrap">{t.entity || '—'}</td>
                  <td className="py-1.5 pr-3 text-ink-muted text-xs">
                    <span className="block" title={t.description || ''}>{t.description || '—'}</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    {t.activeCount > 0 ? <Badge tone="warn">{t.activeCount}</Badge> : <span className="text-ink-faint text-xs">—</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    <button onClick={() => toggle(t)} disabled={savingCode === t.code}
                      role="switch" aria-checked={t.enabled} aria-label={`Toggle emails for ${t.code}`}
                      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${t.enabled ? 'bg-brand' : 'bg-cohesity-border'}`}>
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${t.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ZertoSettingsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState('connection');
  const [status, setStatus] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [interval, setIntervalMin] = useState(15);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const loadStatus = () => client.get('/zerto/account')
    .then(({ data }) => {
      setStatus(data);
      setUsername(data.username || '');
      setBaseUrl(data.baseUrl || '');
      setIntervalMin(data.pollIntervalMinutes || 15);
    })
    .catch(() => setStatus({ configured: false }));

  useEffect(() => { loadStatus(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await client.put('/zerto/account', {
        username: username.trim(),
        password: password || undefined,
        baseUrl: baseUrl.trim() || undefined,
        pollIntervalMinutes: Number(interval) || 15,
      });
      setPassword('');
      await loadStatus();
      toast({ type: 'success', title: 'Zerto credentials saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await client.post('/zerto/account/test', {
        username: username.trim() || undefined,
        password: password || undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const SECTIONS = [
    { key: 'connection', label: 'Connection', icon: Cloud },
    { key: 'alerts', label: 'Alert Notifications', icon: BellRing },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="Zerto Settings" description="Zerto Analytics SaaS connection (analytics.zerto.com)" />

      {status == null ? (
        <LoadingPanel label="Loading…" height={140} />
      ) : (
        <div className="flex gap-4 items-start">
          {/* Section rail — same pattern as Global Settings */}
          <div className="w-56 shrink-0 panel p-2" style={{ borderTop: `3px solid ${BRAND}` }}>
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const isActive = tab === s.key;
              return (
                <button key={s.key} onClick={() => setTab(s.key)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors cursor-pointer ${isActive ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:bg-surface-overlay/60 hover:text-ink'}`}>
                  <Icon size={13} className={isActive ? 'text-brand' : 'text-ink-faint'} />
                  {s.label}
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-4">
          {tab === 'alerts' ? (
            <AlertTypesSection />
          ) : (
          <>
          <div className="panel p-4 max-w-3xl" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-2 mb-1">
              <Cloud size={16} className="text-brand" />
              <p className="text-sm font-semibold text-ink">Zerto Analytics account</p>
            </div>
            <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
              myZerto credentials with access to Zerto Analytics. The password is encrypted at rest;
              all sites, VPGs, alerts and protected VMs for the account are discovered automatically.
            </p>

            <div className="grid md:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Username</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="user@company.com" className={inp} spellCheck={false} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Password {status.hasPassword && <span className="text-ink-faint font-normal">(saved — leave blank to keep)</span>}</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={status.hasPassword ? '••••••••' : 'Password'} className={inp} />
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">API base URL <span className="text-ink-faint font-normal">(optional)</span></label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://analytics.api.zerto.com" className={inp} spellCheck={false} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
                <input type="number" min={5} max={1440} value={interval} onChange={(e) => setIntervalMin(e.target.value)} className={inp} />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={save} disabled={saving}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={test} disabled={testing}
                className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-2">
                {testing && <Spinner size={13} />} Test connection
              </button>
              {testResult && (
                <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
                  {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  {testResult.ok ? `Connected — ${testResult.sites} site(s) visible` : testResult.error}
                </span>
              )}
            </div>
          </div>

          <div className="panel p-4 max-w-3xl">
            <p className="text-sm font-semibold text-ink mb-3">Status</p>
            <div className="flex flex-col gap-2 text-sm max-w-md">
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Configured</span>
                <Badge tone={status.configured ? 'ok' : 'warn'}>{status.configured ? 'Yes' : 'No'}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Password source</span>
                <span className="text-ink-faint text-xs">{status.passSource || '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Sites discovered</span>
                <span className="text-ink tnum">{status.siteCount ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Last data capture</span>
                <span className="text-ink-faint text-xs tnum">{fmtWhen(status.lastCapture)}</span>
              </div>
            </div>
            <p className="text-[11px] text-ink-faint mt-4 leading-relaxed">
              The Zerto platform tab itself is enabled from Global Settings (gear icon → Platforms).
            </p>
          </div>
          </>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
