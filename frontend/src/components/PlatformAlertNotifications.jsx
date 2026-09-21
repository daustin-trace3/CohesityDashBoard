import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, Save, Send, Search, AlertTriangle } from 'lucide-react';
import client from '../api/client';
import { useToast } from './ui/Toaster';
import { LoadingPanel } from './ui/primitives';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

/**
 * Per-platform alert email settings: this platform's own recipients, minimum
 * severity, on/off, and the per-alert-type mute catalog. Mirrors Zerto's
 * AlertTypesSection (zerto/ZertoSettingsPage.jsx) and the global panels on
 * AdminSettingsPage - mount on a platform's own Settings page under an
 * "Alert Notifications" tab/section. Pass hideTypes for Zerto, which keeps
 * its own alert-type list right below this component.
 */
export default function PlatformAlertNotifications({ platform, label, hideTypes = false }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [recipients, setRecipients] = useState('');
  const [minSeverity, setMinSeverity] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [search, setSearch] = useState('');
  const [savingType, setSavingType] = useState(null);

  const load = useCallback(() => client.get(`/alert-notify/${platform}`, { params: { _: Date.now() } })
    .then(({ data: d }) => {
      setData(d);
      setRecipients(d.recipients || '');
      setMinSeverity(d.minSeverity || '');
      setEnabled(!!d.enabled);
    })
    .catch(() => toast({ type: 'error', title: 'Could not load', message: `Could not load ${label} alert notification settings.` })),
  [platform, label, toast]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { data: d } = await client.put(`/alert-notify/${platform}`, {
        recipients, minSeverity: minSeverity || null, enabled,
      });
      setData((prev) => ({ ...prev, ...d }));
      toast({ type: 'success', title: 'Alert notification settings saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await client.post(`/alert-notify/${platform}/test`);
      setTestResult({ ok: true, msg: 'Test email sent.' });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.response?.data?.error || 'Could not send the test email.' });
    } finally {
      setTesting(false);
    }
  };

  const toggleType = async (t) => {
    setSavingType(t.type);
    try {
      await client.put(`/alert-notify/${platform}/types/${encodeURIComponent(t.type)}`, { enabled: !t.enabled });
      setData((prev) => ({
        ...prev,
        types: prev.types.map((x) => (x.type === t.type ? { ...x, enabled: !t.enabled } : x)),
      }));
    } catch (err) {
      toast({ type: 'error', title: `Failed to update ${t.label || t.type}`, message: err?.response?.data?.error });
    } finally {
      setSavingType(null);
    }
  };

  const types = data?.types || [];
  const shownTypes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return types;
    return types.filter((t) => (t.label || t.type).toLowerCase().includes(q) || t.type.toLowerCase().includes(q));
  }, [types, search]);
  const mutedCount = types.filter((t) => !t.enabled).length;

  if (data == null) {
    return <LoadingPanel label="Loading alert notification settings..." height={160} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {!data.smtpReady && (
        <p className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5 flex items-center gap-1.5">
          <AlertTriangle size={13} className="shrink-0" />
          SMTP is not set up yet. Configure it in <Link to="/admin/notifications" className="underline underline-offset-2">Global Settings, Notifications</Link>.
        </p>
      )}

      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-3">
          <BellRing size={16} className="text-brand" />
          <p className="text-sm font-semibold text-ink">Alert notifications</p>
        </div>

        <div className="flex flex-col gap-4">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-brand mt-0.5 cursor-pointer"
            />
            <span className="text-xs text-ink-muted leading-relaxed">
              <span className="font-semibold text-ink">Send alert email for this platform</span>
            </span>
          </label>

          <div>
            <label htmlFor={`${platform}-alert-recipients`} className="block text-xs font-semibold text-ink mb-1">Recipients</label>
            <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
              {data.globalRecipientsSet
                ? 'Leave blank to use the default recipients from Global Settings.'
                : 'Leave blank to use the default recipients from Global Settings - no default recipients are set.'}
            </p>
            <input
              id={`${platform}-alert-recipients`}
              type="text"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="name@example.com, name2@example.com"
              className={inp}
            />
          </div>

          <div>
            <label htmlFor={`${platform}-alert-min-severity`} className="block text-xs font-semibold text-ink mb-1">Minimum severity</label>
            <select
              id={`${platform}-alert-min-severity`}
              value={minSeverity}
              onChange={(e) => setMinSeverity(e.target.value)}
              className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
            >
              <option value="">Use global default ({data.globalMinSeverity})</option>
              <option value="info">Info and above</option>
              <option value="warning">Warning and above</option>
              <option value="critical">Critical only</option>
            </select>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
              <Save size={13} /> {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={sendTest} disabled={testing || !data.smtpReady}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40 cursor-pointer">
              <Send size={13} /> {testing ? 'Sending...' : 'Send test email'}
            </button>
            {testResult && (
              <span className={`text-[12px] ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>{testResult.msg}</span>
            )}
          </div>
        </div>
      </div>

      {!hideTypes && (
        <div className="panel p-4">
          <div className="flex items-center gap-2 mb-1">
            <BellRing size={16} className="text-brand" />
            <p className="text-sm font-semibold text-ink">Alert types</p>
          </div>
          <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
            Which alert types on this platform may send email. A new type appears here, enabled, the
            first time ICC sees it. A disabled type still shows on the dashboard and Service Status -
            it just does not send email.{mutedCount > 0 && <> <b className="text-ink">{mutedCount}</b> type(s) currently muted.</>}
          </p>

          {types.length > 12 && (
            <div className="relative max-w-sm mb-3">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search alert types..."
                className="w-full bg-surface-overlay border border-cohesity-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink outline-none focus:border-brand" />
            </div>
          )}

          {types.length === 0 ? (
            <p className="text-xs text-ink-faint py-6 text-center">Alert types appear here after ICC has seen them from this platform.</p>
          ) : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-cohesity-border/60 rounded-lg">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 pr-3">First seen</th>
                    <th className="py-2 pr-3">Last seen</th>
                    <th className="py-2 pr-3 text-right">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {shownTypes.map((t) => (
                    <tr key={t.type} className={`border-b border-cohesity-border/40 ${t.enabled ? '' : 'opacity-60'}`}>
                      <td className="py-1.5 px-3 font-semibold whitespace-nowrap">{t.label || t.type}</td>
                      <td className="py-1.5 pr-3 text-ink-muted text-xs whitespace-nowrap">{t.firstSeen ? new Date(t.firstSeen).toLocaleString() : '-'}</td>
                      <td className="py-1.5 pr-3 text-ink-muted text-xs whitespace-nowrap">{t.lastSeen ? new Date(t.lastSeen).toLocaleString() : '-'}</td>
                      <td className="py-1.5 pr-3 text-right">
                        <button onClick={() => toggleType(t)} disabled={savingType === t.type}
                          role="switch" aria-checked={t.enabled} aria-label={`Toggle emails for ${t.label || t.type}`}
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
      )}
    </div>
  );
}
