import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link, Navigate } from 'react-router-dom';
import { Save, Layers, KeyRound, Settings, Mail } from 'lucide-react';
import client from '../api/client';
import { Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import AdminNav from '../components/AdminNav';
import IntelligenceSettingsPage from './IntelligenceSettingsPage';
import { SWITCHER_MODES, getSwitcherMode } from '../components/PlatformSwitcher';

// Sections rendered by this page; Users & Access and Plugins are their own
// routed pages sharing the same AdminNav shell.
const LOCAL_SECTIONS = ['intelligence', 'platforms', 'license', 'notifications'];
// Sections that use the whole column: tabbed pages, not single forms.
const WIDE_SECTIONS = ['intelligence'];
// Old Intelligence routes (and bare /admin), kept as aliases that redirect to
// the matching tab of /admin/intelligence so bookmarks keep working.
const INTEL_ALIASES = { ai: 'provider', agent: 'agent', 'agent-capabilities': 'capabilities', 'agent-privacy': 'privacy' };

const NOTIFY_PLATFORMS = [
  { key: 'cohesity', label: 'Cohesity' },
  { key: 'pure', label: 'Pure Storage' },
  { key: 'netapp', label: 'NetApp' },
  { key: 'zerto', label: 'Zerto' },
  { key: 'vcenter', label: 'VMware vCenter' },
  { key: 'dell', label: 'Dell (OME)' },
  { key: 'aria', label: 'Aria Automation' },
  { key: 'aws', label: 'AWS' },
  { key: 'bluecat', label: 'BlueCat Address Manager' },
  { key: 'brocade', label: 'Brocade SAN' },
  { key: 'netbackup', label: 'NetBackup' },
  { key: 'proxmox', label: 'Proxmox VE' },
];

export default function AdminSettingsPage() {
  const { section } = useParams();
  const [params] = useSearchParams();
  const intelAlias = section === undefined ? (params.get('tab') || 'provider') : INTEL_ALIASES[section];
  const tab = LOCAL_SECTIONS.includes(section) ? section : 'intelligence';
  // Platform enable/disable moved to the merged Platforms page (/admin/plugins).
  const [customDashboardsEnabled, setCustomDashboardsEnabled] = useState(false);
  const [switcherMode, setSwitcherModeState] = useState(getSwitcherMode);
  const [opsOverviewStyle, setOpsOverviewStyle] = useState('classic');
  const [dnsServer, setDnsServer] = useState('');
  const [cohesityAlertWindowDays, setCohesityAlertWindowDays] = useState(5);
  const [license, setLicense] = useState(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const [notify, setNotify] = useState(null);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifyPassword, setNotifyPassword] = useState('');
  const [notifyPasswordCleared, setNotifyPasswordCleared] = useState(false);
  const [savingNotify, setSavingNotify] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);

  useEffect(() => {
    Promise.allSettled([
      client.get('/settings'),
      client.get('/license/status'),
    ]).then(([s, l]) => {
      if (l.status === 'fulfilled') setLicense(l.value.data);
      if (s.status === 'fulfilled') {
        const d = s.value.data;
        setCustomDashboardsEnabled(!!d.featureCustomDashboardsEnabled);
        setOpsOverviewStyle(d.opsOverviewStyle || 'classic');
        setDnsServer(d.dnsServer || '');
        setCohesityAlertWindowDays(d.cohesityAlertWindowDays ?? 5);
      }
    }).finally(() => setLoading(false));
  }, []);

  // Features tab only: the Intelligence tabs save their own fields.
  const save = async () => {
    setSaving(true);
    try {
      await client.put('/settings', {
        featureCustomDashboardsEnabled: customDashboardsEnabled,
        opsOverviewStyle,
        dnsServer,
        cohesityAlertWindowDays: Number(cohesityAlertWindowDays) || 0,
      });
      window.dispatchEvent(new Event('platforms-changed'));
      window.dispatchEvent(new Event('ops-style-changed'));
      toast({ type: 'success', title: 'Settings saved', message: 'Global settings updated.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save settings. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const activateLicense = async () => {
    const key = licenseKeyInput.trim();
    if (!key) return;
    setActivating(true);
    try {
      const { data } = await client.post('/license/activate', { key });
      setLicense(data);
      setLicenseKeyInput('');
      toast({
        type: 'success',
        title: 'License updated',
        message: data.effectiveExpiry ? `Valid through ${data.effectiveExpiry}.` : 'License applied.',
      });
    } catch (err) {
      toast({ type: 'error', title: 'Could not apply license', message: err?.response?.data?.error || 'Invalid or expired key.' });
    } finally {
      setActivating(false);
    }
  };

  useEffect(() => {
    if (tab !== 'notifications' || notify) return;
    setNotifyLoading(true);
    client.get('/settings/notifications')
      .then(({ data }) => setNotify(data))
      .catch(() => toast({ type: 'error', title: 'Could not load', message: 'Could not load notification settings.' }))
      .finally(() => setNotifyLoading(false));
  }, [tab, notify, toast]);

  const saveNotify = async () => {
    if (!notify) return;
    setSavingNotify(true);
    try {
      const payload = {
        smtpEnabled: notify.smtpEnabled,
        smtpHost: notify.smtpHost,
        smtpPort: Number(notify.smtpPort) || 587,
        smtpEncryption: notify.smtpEncryption,
        smtpAuthMethod: notify.smtpAuthMethod,
        smtpUsername: notify.smtpUsername,
        smtpFrom: notify.smtpFrom,
        smtpRecipients: notify.smtpRecipients,
        alertMinSeverity: notify.alertMinSeverity,
        alertPlatforms: notify.alertPlatforms,
        reminderHours: Number(notify.reminderHours) || 0,
      };
      if (notifyPassword) payload.smtpPassword = notifyPassword;
      else if (notifyPasswordCleared) payload.smtpPassword = '';
      const { data } = await client.put('/settings/notifications', payload);
      setNotify(data);
      setNotifyPassword('');
      setNotifyPasswordCleared(false);
      toast({ type: 'success', title: 'Settings saved', message: 'Alert notification settings updated.' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Could not save notification settings. Try again.' });
    } finally {
      setSavingNotify(false);
    }
  };

  const sendTestNotify = async () => {
    setTestingNotify(true);
    try {
      await client.post('/settings/notifications/test');
      toast({ type: 'success', title: 'Test email sent', message: 'Check the configured recipients.' });
    } catch (err) {
      toast({ type: 'error', title: 'Test email failed', message: err?.response?.data?.error || 'Could not send the test email.' });
    } finally {
      setTestingNotify(false);
    }
  };

  if (intelAlias) return <Navigate to={`/admin/intelligence?tab=${encodeURIComponent(intelAlias)}`} replace />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
          <Settings size={16} className="text-brand" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-ink">Global Settings</h1>
          <p className="text-xs text-ink-muted mt-0.5">Estate-wide administration — AI, platforms, and product licensing. Platform-specific credentials live on each platform's own Settings page.</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-5 items-start">
        <AdminNav />
        <div className={`flex flex-col gap-4 flex-1 min-w-0 ${WIDE_SECTIONS.includes(tab) ? '' : 'max-w-3xl'}`}>

      {tab === 'intelligence' && <IntelligenceSettingsPage />}


      {/* Features & preferences (platform enable/disable lives on the merged Platforms page) */}
      {tab === 'platforms' && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Layers size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Features & Preferences</p>
            <p className="text-[11px] text-ink-muted">
              Preview features, switcher style, and estate-wide preferences. Platform on/off toggles moved to the{' '}
              <Link to="/admin/plugins" className="text-brand hover:text-brand-bright">Platforms</Link> page.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3 mt-4">
            <div>
              <p className="text-xs font-semibold text-ink mb-1 mt-2">Preview features</p>
              <label className="flex items-start gap-2.5 cursor-pointer select-none mt-1">
                <input type="checkbox" checked={customDashboardsEnabled} onChange={e => setCustomDashboardsEnabled(e.target.checked)}
                  className="accent-brand mt-0.5 cursor-pointer" />
                <span className="text-xs text-ink-muted leading-relaxed">
                  <span className="font-semibold text-ink">Custom Dashboards</span><br />
                  Show the Custom Dashboards page under Estate and enable its APIs. Leave off while the
                  feature is still being refined — when off it is hidden from all users.
                </span>
              </label>
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <p className="text-xs font-semibold text-ink mb-1 mt-2">Ops Monitor default view</p>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                The overview style every user lands on at /ops. The toggle on the page itself is a
                temporary override for that browser session. Saved with the button below.
              </p>
              <div className="flex flex-col gap-1.5">
                {[
                  { id: 'classic', label: 'Classic', hint: 'card grid with the estate strip' },
                  { id: 'drift', label: 'Drift', hint: 'light, floating cards, curve sparks' },
                  { id: 'nocturne', label: 'Nocturne', hint: 'dark, estate health ring, ranked ledger' },
                ].map(o => (
                  <label key={o.id} className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input type="radio" name="ops-overview-style" className="accent-brand cursor-pointer"
                      checked={opsOverviewStyle === o.id} onChange={() => setOpsOverviewStyle(o.id)} />
                    <span className="text-xs text-ink-muted"><span className="text-ink font-medium">{o.label}</span>, {o.hint}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <p className="text-xs font-semibold text-ink mb-1 mt-2">Platform switcher style</p>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                How the platform selector is presented — trial the styles and we'll keep the winner.
                Applies immediately, saved per browser.
              </p>
              <div className="flex flex-col gap-1.5">
                {SWITCHER_MODES.map(m => (
                  <label key={m.id} className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input type="radio" name="switcher-mode" className="accent-brand cursor-pointer"
                      checked={switcherMode === m.id}
                      onChange={() => {
                        localStorage.setItem('platform-switcher-mode', m.id);
                        setSwitcherModeState(m.id);
                        window.dispatchEvent(new Event('switcher-mode-changed'));
                      }} />
                    <span className="text-xs text-ink-muted">{m.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <label htmlFor="dns-server" className="block text-xs font-semibold text-ink mb-1 mt-2">DNS resolver <span className="text-ink-faint font-normal">(optional)</span></label>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                DNS server IP (or hostname) used to reverse-resolve IP addresses to names across the dashboard — e.g. NFS client IPs. Leave blank to disable hostname lookups.
              </p>
              <input id="dns-server" type="text" value={dnsServer} onChange={e => setDnsServer(e.target.value)}
                placeholder="e.g. 172.17.0.10"
                className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none tnum" />
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <label htmlFor="cohesity-alert-window" className="block text-xs font-semibold text-ink mb-1 mt-2">Cohesity alert window (days)</label>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                A Cohesity alert counts only while it has fired within this many days. Older open alerts that nobody resolved on the cluster drop off every page at the next poll, and come back if they fire again. 0 keeps every open alert.
              </p>
              <input id="cohesity-alert-window" type="number" min="0" max="365" step="1" value={cohesityAlertWindowDays}
                onChange={e => setCohesityAlertWindowDays(e.target.value)}
                className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum" />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Product license — status only, key is never displayed */}
      {tab === 'license' && !license && (
        <div className="panel p-4">
          <p className="text-xs text-ink-faint">License status is unavailable right now.</p>
        </div>
      )}
      {tab === 'license' && license && (
        <div className="panel p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
              <KeyRound size={14} className="text-brand" />
            </div>
            <div>
              <p className="text-sm font-bold text-ink">Product License</p>
              <p className="text-[11px] text-ink-muted">This installation's license status. Renewals apply automatically once payment is processed.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Badge tone={license.state === 'valid' ? 'ok' : license.state === 'grace' ? 'warn' : 'crit'}>
              {license.state === 'valid' ? 'Valid' : license.state === 'grace' ? 'Expired — grace period' : 'Not licensed'}
            </Badge>
            {license.customer && (
              <span className="text-xs text-ink-muted">Licensed to <span className="text-ink font-semibold">{license.customer}</span></span>
            )}
            {license.effectiveExpiry && (
              <span className="text-xs text-ink-muted">Expires <span className="text-ink font-semibold tnum">{license.effectiveExpiry}</span>
                {license.state === 'valid' && license.daysLeft != null && <span className="text-ink-faint"> · {license.daysLeft} days left</span>}
                {license.state === 'grace' && license.graceDaysLeft != null && <span className="text-status-crit font-semibold"> · locks in {license.graceDaysLeft} day{license.graceDaysLeft === 1 ? '' : 's'}</span>}
              </span>
            )}
          </div>
        </div>
      )}

      {tab === 'license' && (
        <div className="panel p-4 mt-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
              <KeyRound size={14} className="text-brand" />
            </div>
            <div>
              <p className="text-sm font-bold text-ink">Update license key</p>
              <p className="text-[11px] text-ink-muted">Paste a new product license key (starts with <code>CDBL-</code>) to replace the current one — e.g. a multi-year renewal.</p>
            </div>
          </div>
          <textarea
            value={licenseKeyInput}
            onChange={(e) => setLicenseKeyInput(e.target.value)}
            rows={3}
            placeholder="CDBL-…"
            spellCheck={false}
            className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-[11px] font-mono text-ink focus:border-brand/60 outline-none mt-3"
          />
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={activateLicense}
              disabled={activating || !licenseKeyInput.trim()}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <KeyRound size={13} /> {activating ? 'Applying…' : 'Apply license key'}
            </button>
          </div>
        </div>
      )}

      {/* Alert Notifications */}

      {tab === 'notifications' && (
      <>
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Mail size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">SMTP Server</p>
            <p className="text-[11px] text-ink-muted">Email delivery settings used to send alert notifications.</p>
          </div>
        </div>

        {notifyLoading || !notify ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4 mt-4">
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={notify.smtpEnabled}
                onChange={e => setNotify(s => ({ ...s, smtpEnabled: e.target.checked }))}
                className="accent-brand mt-0.5 cursor-pointer"
              />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Enable SMTP email notifications</span>
              </span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="smtp-host" className="block text-xs font-semibold text-ink mb-1">Host</label>
                <input
                  id="smtp-host"
                  type="text"
                  value={notify.smtpHost}
                  onChange={e => setNotify(s => ({ ...s, smtpHost: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                />
              </div>
              <div>
                <label htmlFor="smtp-port" className="block text-xs font-semibold text-ink mb-1">Port</label>
                <input
                  id="smtp-port"
                  type="number" min="1" max="65535" step="1"
                  value={notify.smtpPort}
                  onChange={e => setNotify(s => ({ ...s, smtpPort: e.target.value }))}
                  className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
                />
              </div>
              <div>
                <label htmlFor="smtp-encryption" className="block text-xs font-semibold text-ink mb-1">Encryption</label>
                <select
                  id="smtp-encryption"
                  value={notify.smtpEncryption}
                  onChange={e => setNotify(s => ({ ...s, smtpEncryption: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
                >
                  <option value="none">None</option>
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">SSL/TLS</option>
                </select>
              </div>
              <div>
                <label htmlFor="smtp-auth-method" className="block text-xs font-semibold text-ink mb-1">Auth method</label>
                <select
                  id="smtp-auth-method"
                  value={notify.smtpAuthMethod}
                  onChange={e => setNotify(s => ({ ...s, smtpAuthMethod: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
                >
                  <option value="none">None</option>
                  <option value="login">Username &amp; password</option>
                </select>
              </div>
            </div>

            {notify.smtpAuthMethod !== 'none' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="smtp-username" className="block text-xs font-semibold text-ink mb-1">Username</label>
                  <input
                    id="smtp-username"
                    type="text"
                    autoComplete="off"
                    value={notify.smtpUsername}
                    onChange={e => setNotify(s => ({ ...s, smtpUsername: e.target.value }))}
                    className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-2.5 mb-1 flex-wrap">
                    <label htmlFor="smtp-password" className="text-xs font-semibold text-ink">Password</label>
                    {notify.smtpPasswordSet && !notifyPasswordCleared && (
                      <button
                        onClick={() => { setNotifyPasswordCleared(true); setNotifyPassword(''); }}
                        className="text-[10px] text-ink-faint hover:text-status-crit underline underline-offset-2 transition-colors cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <input
                    id="smtp-password"
                    type="password"
                    autoComplete="off"
                    value={notifyPassword}
                    onChange={e => { setNotifyPassword(e.target.value); setNotifyPasswordCleared(false); }}
                    placeholder={notify.smtpPasswordSet && !notifyPasswordCleared ? 'unchanged — leave blank to keep' : ''}
                    className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs font-mono text-ink focus:border-brand/60 outline-none"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="smtp-from" className="block text-xs font-semibold text-ink mb-1">From address</label>
                <input
                  id="smtp-from"
                  type="text"
                  value={notify.smtpFrom}
                  onChange={e => setNotify(s => ({ ...s, smtpFrom: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                />
              </div>
              <div>
                <label htmlFor="smtp-recipients" className="block text-xs font-semibold text-ink mb-1">Default recipients</label>
                <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
                  Comma-separated email addresses. Used by any platform that has not set its own recipients
                  on its Settings page, under Alert Notifications.
                </p>
                <input
                  id="smtp-recipients"
                  type="text"
                  value={notify.smtpRecipients}
                  onChange={e => setNotify(s => ({ ...s, smtpRecipients: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {!notifyLoading && notify && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Mail size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Alert Filtering</p>
            <p className="text-[11px] text-ink-muted">Which alerts trigger an email.</p>
          </div>
        </div>

        <div className="flex flex-col gap-4 mt-4">
          <div>
            <label htmlFor="alert-min-severity" className="block text-xs font-semibold text-ink mb-1">Default minimum severity</label>
            <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
              Alerts below this severity are not emailed, for any platform that has not set its own minimum
              severity on its Settings page.
            </p>
            <select
              id="alert-min-severity"
              value={notify.alertMinSeverity}
              onChange={e => setNotify(s => ({ ...s, alertMinSeverity: e.target.value }))}
              className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
            >
              <option value="info">Info and above</option>
              <option value="warning">Warning and above</option>
              <option value="critical">Critical only</option>
            </select>
          </div>

          <div className="flex flex-col gap-2">
            {NOTIFY_PLATFORMS.map(p => (
              <label key={p.key} className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!notify.alertPlatforms?.[p.key]}
                  onChange={e => setNotify(s => ({ ...s, alertPlatforms: { ...s.alertPlatforms, [p.key]: e.target.checked } }))}
                  className="accent-brand mt-0.5 cursor-pointer"
                />
                <span className="text-xs text-ink-muted leading-relaxed">
                  <span className="font-semibold text-ink">{p.label}</span>
                </span>
              </label>
            ))}
          </div>

          <div>
            <label htmlFor="reminder-hours" className="block text-xs font-semibold text-ink mb-1">Reminder interval (hours)</label>
            <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">Unresolved alerts re-notify at this interval — 0 disables reminders</p>
            <input
              id="reminder-hours"
              type="number" min="0" max="168" step="1"
              value={notify.reminderHours}
              onChange={e => setNotify(s => ({ ...s, reminderHours: e.target.value }))}
              className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={sendTestNotify}
              disabled={testingNotify}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-surface-overlay border border-cohesity-border text-ink rounded-lg hover:bg-surface transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Mail size={13} /> {testingNotify ? 'Sending…' : 'Send test email'}
            </button>
            <button
              onClick={saveNotify}
              disabled={savingNotify}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Save size={13} /> {savingNotify ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      </div>
      )}
      </>
      )}
        </div>
      </div>
    </div>
  );
}
