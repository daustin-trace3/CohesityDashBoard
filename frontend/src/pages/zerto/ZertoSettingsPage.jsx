import { useEffect, useState } from 'react';
import { Settings, Cloud, CheckCircle2, XCircle } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

export default function ZertoSettingsPage() {
  const { toast } = useToast();
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

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="Zerto Settings" description="Zerto Analytics SaaS connection (analytics.zerto.com)" />

      {status == null ? (
        <LoadingPanel label="Loading…" height={140} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
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

          <div className="panel p-4">
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
        </div>
      )}
    </div>
  );
}
