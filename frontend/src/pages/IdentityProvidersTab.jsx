import { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Plus, Pencil, Trash2, X, Copy, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import client from '../api/client';
import DirectoryTab from './DirectoryTab';
import { Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import { copyText } from '../utils/clipboard';
import {
  inputCls, numberCls, selectCls, SettingRow, Toggle, SettingGroup,
} from '../components/settings/SettingRow';

function errorMessage(err, fallback) {
  const d = err?.response?.data;
  if (d?.error) return d.field ? `${d.error} (${d.field})` : d.error;
  return fallback;
}

// SQLite stamps arrive without a zone; they are UTC.
function fmtWhen(v) {
  if (!v) return '';
  let s = String(v);
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

const btnPrimary = 'flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer';
const btnPlain = 'flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:bg-surface-overlay transition-colors disabled:opacity-40 cursor-pointer';

const OIDC_SETUP = [
  'In Okta Admin, Applications > Create App Integration > OIDC, Web Application.',
  'Sign-in redirect URI: {redirectUri}. Sign-out redirect: leave blank. Assign the groups that should sign in.',
  'Sign On tab > OpenID Connect ID Token > Groups claim filter: groups, Matches regex, .* (Okta sends at most 100 groups; the Management API sync covers the rest).',
];
const SAML_SETUP = [
  'In Okta Admin, Applications > Create App Integration > SAML 2.0.',
  'Single sign-on URL: {acsUrl}. Audience URI (SP Entity ID): {spEntityId}. Name ID format: EmailAddress. Application username: Okta username.',
  "Group Attribute Statements: name groups, filter Matches regex .*. Then copy the app's Identity Provider metadata URL into the field above and press Import.",
];

function blankForm(type) {
  return {
    name: 'Okta', slug: 'okta', type,
    issuer: '', clientId: '', clientSecret: '', clearClientSecret: false,
    scopes: 'openid profile email groups',
    idpEntityId: '', idpSsoUrl: '', idpCertPem: '', idpMetadataUrl: '',
    spEntityId: '', spKeyPem: '', clearSpKey: false,
    wantAssertionsSigned: true, allowIdpInitiated: false,
    claimSubject: type === 'saml' ? 'nameid' : 'sub',
    claimEmail: 'email', claimName: 'name', claimGroups: 'groups',
    jitEnabled: true,
    mgmtKind: 'none', mgmtBaseUrl: '', mgmtToken: '', clearMgmtToken: false,
    mgmtSyncMinutes: 60, mgmtDeactivateRemoved: true,
  };
}

function formFromProvider(p) {
  const f = blankForm(p.type);
  [
    'name', 'slug', 'issuer', 'clientId', 'scopes', 'idpEntityId', 'idpSsoUrl', 'idpCertPem',
    'idpMetadataUrl', 'spEntityId', 'wantAssertionsSigned', 'allowIdpInitiated',
    'claimSubject', 'claimEmail', 'claimName', 'claimGroups', 'jitEnabled',
    'mgmtKind', 'mgmtBaseUrl', 'mgmtSyncMinutes', 'mgmtDeactivateRemoved',
  ].forEach((k) => { if (p[k] != null) f[k] = p[k]; });
  f.type = p.type;
  return f;
}

function buildBody(f, isNew) {
  const body = {
    name: f.name.trim(), slug: f.slug.trim(),
    scopes: f.scopes, claimSubject: f.claimSubject, claimEmail: f.claimEmail,
    claimName: f.claimName, claimGroups: f.claimGroups, jitEnabled: f.jitEnabled,
    mgmtKind: f.mgmtKind, mgmtBaseUrl: f.mgmtBaseUrl.trim(),
    mgmtSyncMinutes: Number(f.mgmtSyncMinutes) || 60, mgmtDeactivateRemoved: f.mgmtDeactivateRemoved,
  };
  if (isNew) body.type = f.type;
  if (f.type === 'oidc') {
    body.issuer = f.issuer.trim();
    body.clientId = f.clientId.trim();
  } else {
    body.idpEntityId = f.idpEntityId.trim();
    body.idpSsoUrl = f.idpSsoUrl.trim();
    body.idpCertPem = f.idpCertPem;
    body.idpMetadataUrl = f.idpMetadataUrl.trim();
    body.spEntityId = f.spEntityId.trim();
    body.wantAssertionsSigned = f.wantAssertionsSigned;
    body.allowIdpInitiated = f.allowIdpInitiated;
  }
  // Secrets: '' keeps the saved value, null clears it, a string replaces it.
  if (f.clearClientSecret) body.clientSecret = null;
  else if (f.clientSecret) body.clientSecret = f.clientSecret;
  if (f.clearMgmtToken) body.mgmtToken = null;
  else if (f.mgmtToken) body.mgmtToken = f.mgmtToken;
  if (f.clearSpKey) body.spKeyPem = null;
  else if (f.spKeyPem) body.spKeyPem = f.spKeyPem;
  return body;
}

/* Modal shell, wide */
function Drawer({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative bg-cohesity-gray border border-cohesity-border rounded-lg w-full max-w-3xl max-h-[92vh] flex flex-col shadow-xl animate-fade-in">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-cohesity-border flex-shrink-0">
          <p className="text-sm font-bold text-ink">{title}</p>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink cursor-pointer"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function CopyRow({ label, value }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast({ type: 'error', title: 'Could not copy', message: 'Select the text and copy it manually.' });
    }
  };
  return (
    <div>
      <p className="text-[10px] font-medium text-ink-faint uppercase tracking-wider mb-0.5">{label}</p>
      <div className="flex items-center gap-2 bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2">
        <code className="text-xs font-mono text-ink break-all flex-1">{value}</code>
        <button type="button" onClick={copy} aria-label={`Copy ${label}`} className="text-ink-faint hover:text-brand cursor-pointer flex-shrink-0">
          {copied ? <Check size={14} className="text-status-ok" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

/* A secret input with the saved marker and a Clear link */
function SecretField({ id, isSet, value, onChange, cleared, onClear, placeholder, multiline }) {
  const common = {
    id, value, autoComplete: 'off',
    onChange: (e) => onChange(e.target.value),
    placeholder: isSet && !cleared ? 'Saved. Type to replace.' : placeholder,
    className: `${inputCls} ${multiline ? 'font-mono h-24' : ''}`,
  };
  return (
    <div className="flex flex-col gap-1">
      {multiline ? <textarea {...common} /> : <input type="password" {...common} />}
      <div className="flex items-center gap-3 text-[11px]">
        {isSet && !cleared && <span className="text-status-ok">saved</span>}
        {cleared && <span className="text-status-warn">will be cleared on save</span>}
        {isSet && !cleared && (
          <button type="button" onClick={onClear} className="text-ink-faint hover:text-status-crit underline cursor-pointer">Clear</button>
        )}
      </div>
    </div>
  );
}

function ChecksList({ result }) {
  if (!result) return null;
  return (
    <div className={`rounded-lg border px-3 py-2 mt-3 ${result.ok ? 'border-status-ok/30 bg-status-ok/5' : 'border-status-crit/30 bg-status-crit/5'}`}>
      <p className={`text-xs font-semibold ${result.ok ? 'text-status-ok' : 'text-status-crit'}`}>
        {result.ok ? 'All checks passed' : 'One or more checks failed'}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {(result.checks || []).map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex items-start gap-2 text-[11px]">
            <span className={`mt-0.5 flex-shrink-0 ${c.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {c.ok ? <Check size={12} /> : <X size={12} />}
            </span>
            <span className="text-ink">{c.name}</span>
            {c.detail && <span className="text-ink-muted break-all">{c.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SyncLog({ providerId, refreshKey }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    client.get(`/idp/providers/${providerId}/sync/status`)
      .then(({ data: d }) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ running: false, runs: [] }); });
    return () => { alive = false; };
  }, [providerId, refreshKey]);
  if (!data) return <p className="text-[11px] text-ink-faint">Loading sync log...</p>;
  return (
    <div>
      <p className="text-[11px] text-ink-muted mb-1.5">{data.running ? 'A sync is running now.' : 'Last 10 sync runs.'}</p>
      <div className="border border-cohesity-border rounded-lg overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-cohesity-border text-ink-faint text-[10px] uppercase tracking-wider">
              {['Status', 'Trigger', 'Started', 'Groups', 'Seen', 'Created', 'Updated', 'Deactivated', 'Message'].map((h) => (
                <th key={h} className="text-left px-2 py-1.5 font-semibold whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data.runs || []).map((r) => (
              <tr key={r.id} className="border-b border-cohesity-border/50 last:border-0">
                <td className="px-2 py-1.5"><Badge tone={r.status === 'ok' || r.status === 'success' ? 'ok' : r.status === 'error' ? 'crit' : 'neutral'}>{r.status}</Badge></td>
                <td className="px-2 py-1.5 text-ink-muted">{r.trigger}</td>
                <td className="px-2 py-1.5 text-ink-muted whitespace-nowrap">{fmtWhen(r.startedAt || r.started_at)}</td>
                <td className="px-2 py-1.5 text-ink-muted">{r.groupsSynced ?? r.groups_synced ?? 0}</td>
                <td className="px-2 py-1.5 text-ink-muted">{r.usersSeen ?? r.users_seen ?? 0}</td>
                <td className="px-2 py-1.5 text-ink-muted">{r.usersCreated ?? r.users_created ?? 0}</td>
                <td className="px-2 py-1.5 text-ink-muted">{r.usersUpdated ?? r.users_updated ?? 0}</td>
                <td className="px-2 py-1.5 text-ink-muted">{r.usersDeactivated ?? r.users_deactivated ?? 0}</td>
                <td className="px-2 py-1.5 text-ink-muted">{r.message || ''}</td>
              </tr>
            ))}
            {(data.runs || []).length === 0 && (
              <tr><td colSpan={9} className="px-2 py-3 text-center text-ink-faint">No sync runs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProviderDrawer({ initial, newType, onClose, onChanged }) {
  const { toast } = useToast();
  const [prov, setProv] = useState(initial || null);
  const [form, setForm] = useState(() => (initial ? formFromProvider(initial) : blankForm(newType)));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null); // 'test' | 'sync' | 'import'
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [syncKey, setSyncKey] = useState(0);
  const isNew = !prov;
  const isOidc = form.type === 'oidc';
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setType = (type) => setForm((f) => ({ ...f, type, claimSubject: type === 'saml' ? 'nameid' : 'sub' }));
  const setEv = (k) => (e) => set(k)(e.target.value);

  const adopt = (p) => {
    setProv(p);
    setForm(formFromProvider(p));
    onChanged();
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const body = buildBody(form, isNew);
      const { data } = isNew
        ? await client.post('/idp/providers', body)
        : await client.put(`/idp/providers/${prov.id}`, body);
      adopt(data);
      toast({ type: 'success', title: isNew ? 'Provider created' : 'Provider saved' });
      return data;
    } catch (err) {
      setError(errorMessage(err, 'Could not save the provider.'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (id) => {
    setBusy('test');
    setTestResult(null);
    try {
      const { data } = await client.post(`/idp/providers/${id}/test`);
      setTestResult(data);
    } catch (err) {
      const d = err?.response?.data;
      setTestResult(d && Array.isArray(d.checks) ? d : { ok: false, checks: [{ name: 'Test', ok: false, detail: errorMessage(err, 'Test failed.') }] });
    }
    try {
      const { data } = await client.get(`/idp/providers/${id}`);
      setProv(data);
      onChanged();
    } catch { /* the list refresh will catch up */ }
    setBusy(null);
  };

  const saveAndTest = async () => {
    const saved = await save();
    if (saved) await runTest(saved.id);
  };

  const importMetadata = async () => {
    setError(null);
    setBusy('import');
    try {
      const { data } = await client.post('/idp/providers/import-metadata', { url: form.idpMetadataUrl.trim() });
      setForm((f) => ({ ...f, idpEntityId: data.entityId || '', idpSsoUrl: data.ssoUrl || '', idpCertPem: data.certPem || '' }));
      toast({ type: 'success', title: 'Metadata imported', message: 'Review the fields, then Save.' });
    } catch (err) {
      setError(errorMessage(err, 'Could not import the metadata.'));
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setBusy('sync');
    try {
      await client.post(`/idp/providers/${prov.id}/sync`);
      toast({ type: 'success', title: 'Sync finished' });
    } catch (err) {
      toast({ type: 'error', title: 'Sync failed', message: errorMessage(err, '') });
    }
    setSyncKey((k) => k + 1);
    try {
      const { data } = await client.get(`/idp/providers/${prov.id}`);
      setProv(data);
      onChanged();
    } catch { /* ignore */ }
    setBusy(null);
  };

  const urls = prov?.urls;
  const steps = (isOidc ? OIDC_SETUP : SAML_SETUP).map((s) => s
    .replace('{redirectUri}', urls?.redirectUri || '(save the provider first)')
    .replace('{acsUrl}', urls?.acsUrl || '(save the provider first)')
    .replace('{spEntityId}', urls?.spEntityId || '(save the provider first)'));
  const okta = form.mgmtKind === 'okta';

  return (
    <Drawer title={isNew ? 'Add Okta' : `Edit ${prov.name}`} onClose={onClose}>
      <div className="flex flex-col gap-1">
        <SettingGroup title="Connection">
          <SettingRow label="Protocol" htmlFor="idp-type" tip="How ICC talks to Okta. OpenID Connect is the simpler setup and the recommended choice; pick SAML 2.0 when your Okta app is a SAML app. Fixed after the provider is created.">
            {isNew ? (
              <select id="idp-type" value={form.type} onChange={(e) => setType(e.target.value)} className={selectCls}>
                <option value="oidc">OpenID Connect (recommended)</option>
                <option value="saml">SAML 2.0</option>
              </select>
            ) : (
              <p className="text-xs text-ink-muted py-1.5">{isOidc ? 'OpenID Connect' : 'SAML 2.0'}</p>
            )}
          </SettingRow>
          <SettingRow label="Name" htmlFor="idp-name">
            <input id="idp-name" value={form.name} onChange={setEv('name')} className={inputCls} />
          </SettingRow>
          <SettingRow label="Slug" htmlFor="idp-slug" tip="Used in the sign-in URLs. Lowercase letters, digits and hyphens, 2 to 32 characters.">
            <input id="idp-slug" value={form.slug} onChange={setEv('slug')} readOnly={!isNew} className={`${inputCls} font-mono${isNew ? '' : ' opacity-70 cursor-not-allowed'}`} placeholder="okta" title={isNew ? undefined : 'The slug is part of the URLs registered with the IdP and cannot change after creation.'} />
          </SettingRow>
          {isOidc ? (
            <>
              <SettingRow label="Issuer URL" htmlFor="idp-issuer" tip="The Okta org or authorization server URL, for example https://example.okta.com. Changing it clears the saved client secret.">
                <input id="idp-issuer" value={form.issuer} onChange={setEv('issuer')} className={inputCls} placeholder="https://example.okta.com" />
              </SettingRow>
              <SettingRow label="Client ID" htmlFor="idp-client-id">
                <input id="idp-client-id" value={form.clientId} onChange={setEv('clientId')} className={`${inputCls} font-mono`} />
              </SettingRow>
              <SettingRow label="Client secret" htmlFor="idp-client-secret">
                <SecretField id="idp-client-secret" isSet={!!prov?.clientSecretSet} value={form.clientSecret}
                  onChange={(v) => setForm((f) => ({ ...f, clientSecret: v, clearClientSecret: false }))}
                  cleared={form.clearClientSecret} onClear={() => setForm((f) => ({ ...f, clientSecret: '', clearClientSecret: true }))}
                  placeholder="Client secret from the Okta app" />
              </SettingRow>
              <SettingRow label="Scopes" htmlFor="idp-scopes" tip="Space separated. Must include openid.">
                <input id="idp-scopes" value={form.scopes} onChange={setEv('scopes')} className={inputCls} />
              </SettingRow>
            </>
          ) : (
            <>
              <SettingRow label="IdP metadata URL" htmlFor="idp-meta" tip="Okta: the app's Identity Provider metadata URL. Import fills the three fields below; nothing is saved until you press Save.">
                <div className="flex gap-2">
                  <input id="idp-meta" value={form.idpMetadataUrl} onChange={setEv('idpMetadataUrl')} className={inputCls} placeholder="https://example.okta.com/app/.../sso/saml/metadata" />
                  <button type="button" onClick={importMetadata} disabled={busy === 'import' || !form.idpMetadataUrl.trim()} className={btnPlain}>
                    {busy === 'import' ? 'Importing...' : 'Import'}
                  </button>
                </div>
              </SettingRow>
              <SettingRow label="IdP entity ID" htmlFor="idp-entity">
                <input id="idp-entity" value={form.idpEntityId} onChange={setEv('idpEntityId')} className={inputCls} />
              </SettingRow>
              <SettingRow label="IdP sign-on URL" htmlFor="idp-sso">
                <input id="idp-sso" value={form.idpSsoUrl} onChange={setEv('idpSsoUrl')} className={inputCls} />
              </SettingRow>
              <SettingRow label="IdP certificate (PEM)" htmlFor="idp-cert">
                <textarea id="idp-cert" value={form.idpCertPem} onChange={setEv('idpCertPem')} className={`${inputCls} font-mono h-24`} placeholder="-----BEGIN CERTIFICATE-----" />
              </SettingRow>
              <SettingRow label="SP entity ID" htmlFor="idp-sp-entity" tip="Leave blank to use the metadata URL shown under URLs for Okta.">
                <input id="idp-sp-entity" value={form.spEntityId} onChange={setEv('spEntityId')} className={inputCls} />
              </SettingRow>
              <SettingRow label="Signing key (PEM)" htmlFor="idp-sp-key" tip="Optional. When set, ICC signs its authentication requests with this private key.">
                <SecretField id="idp-sp-key" multiline isSet={!!prov?.spKeySet} value={form.spKeyPem}
                  onChange={(v) => setForm((f) => ({ ...f, spKeyPem: v, clearSpKey: false }))}
                  cleared={form.clearSpKey} onClear={() => setForm((f) => ({ ...f, spKeyPem: '', clearSpKey: true }))}
                  placeholder="-----BEGIN PRIVATE KEY-----" />
              </SettingRow>
              <SettingRow label="Require signed assertions" htmlFor="idp-signed">
                <Toggle id="idp-signed" checked={form.wantAssertionsSigned} onChange={set('wantAssertionsSigned')} />
              </SettingRow>
              <SettingRow label="Allow IdP-initiated sign-in" htmlFor="idp-initiated" tip="Accept a response that was not started from ICC. It lands on the home page.">
                <Toggle id="idp-initiated" checked={form.allowIdpInitiated} onChange={set('allowIdpInitiated')} />
              </SettingRow>
            </>
          )}
        </SettingGroup>

        <SettingGroup title="Claims">
          <SettingRow label={isOidc ? 'Subject claim' : 'Subject attribute'} htmlFor="idp-c-sub" tip={isOidc ? 'Okta: sub is the Okta user id.' : 'nameid uses the SAML NameID.'}>
            <input id="idp-c-sub" value={form.claimSubject} onChange={setEv('claimSubject')} className={`${inputCls} font-mono`} />
          </SettingRow>
          <SettingRow label="Email" htmlFor="idp-c-email">
            <input id="idp-c-email" value={form.claimEmail} onChange={setEv('claimEmail')} className={`${inputCls} font-mono`} />
          </SettingRow>
          <SettingRow label="Display name" htmlFor="idp-c-name">
            <input id="idp-c-name" value={form.claimName} onChange={setEv('claimName')} className={`${inputCls} font-mono`} />
          </SettingRow>
          <SettingRow label="Groups" htmlFor="idp-c-groups">
            <input id="idp-c-groups" value={form.claimGroups} onChange={setEv('claimGroups')} className={`${inputCls} font-mono`} />
          </SettingRow>
          <SettingRow label="Create users on first sign-in" htmlFor="idp-jit" tip="When off, only users added or imported by an administrator can sign in.">
            <Toggle id="idp-jit" checked={form.jitEnabled} onChange={set('jitEnabled')} />
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Management API">
          <SettingRow label="Kind" htmlFor="idp-m-kind" tip="With an Okta API token ICC can search Okta groups and users, and sync membership on a schedule.">
            <select id="idp-m-kind" value={form.mgmtKind} onChange={setEv('mgmtKind')} className={`${selectCls} max-w-xs`}>
              <option value="none">None</option>
              <option value="okta">Okta</option>
            </select>
          </SettingRow>
          {okta && (
            <>
              <SettingRow label="Base URL" htmlFor="idp-m-url" tip="Your Okta org, for example https://example.okta.com. Changing it clears the saved token.">
                <input id="idp-m-url" value={form.mgmtBaseUrl} onChange={setEv('mgmtBaseUrl')} className={inputCls} placeholder="https://example.okta.com" />
              </SettingRow>
              <SettingRow label="API token" htmlFor="idp-m-token" tip="Okta Admin > Security > API > Tokens. A token expires after 30 days without use.">
                <SecretField id="idp-m-token" isSet={!!prov?.mgmtTokenSet} value={form.mgmtToken}
                  onChange={(v) => setForm((f) => ({ ...f, mgmtToken: v, clearMgmtToken: false }))}
                  cleared={form.clearMgmtToken} onClear={() => setForm((f) => ({ ...f, mgmtToken: '', clearMgmtToken: true }))}
                  placeholder="SSWS token" />
              </SettingRow>
              <SettingRow label="Sync every (minutes)" htmlFor="idp-m-min" tip="5 to 1440.">
                <input id="idp-m-min" type="number" min={5} max={1440} value={form.mgmtSyncMinutes} onChange={setEv('mgmtSyncMinutes')} className={numberCls} />
              </SettingRow>
              <SettingRow label="Deactivate removed users" htmlFor="idp-m-deact" tip="A user no longer in any linked Okta group is disabled at the next sync. Pinned users are kept.">
                <Toggle id="idp-m-deact" checked={form.mgmtDeactivateRemoved} onChange={set('mgmtDeactivateRemoved')} />
              </SettingRow>
              {!isNew && (
                <div className="py-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button type="button" onClick={syncNow} disabled={busy === 'sync'} className={btnPlain}>
                      <RefreshCw size={12} className={busy === 'sync' ? 'animate-spin' : ''} /> {busy === 'sync' ? 'Syncing...' : 'Sync now'}
                    </button>
                    {prov.mgmtLastSyncAt && (
                      <span className="text-[11px] text-ink-muted">
                        Last sync {fmtWhen(prov.mgmtLastSyncAt)}: {prov.mgmtLastStatus || 'unknown'}
                      </span>
                    )}
                  </div>
                  {prov.mgmtLastError && <p className="text-[11px] text-status-crit">{prov.mgmtLastError}</p>}
                  <SyncLog providerId={prov.id} refreshKey={syncKey} />
                </div>
              )}
            </>
          )}
        </SettingGroup>

        <SettingGroup title="URLs for Okta">
          {!urls ? (
            <p className="text-[11px] text-ink-faint py-3">Save the provider to get its redirect and metadata URLs.</p>
          ) : (
            <div className="py-3 flex flex-col gap-2.5">
              {urls.urlsFromRequest && (
                <p className="text-[11px] text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-lg px-3 py-2">
                  icc_base_url is not set (Global Settings &gt; Intelligence &gt; Agent notifications), so these URLs are built from this request's host. Set it before pasting them into Okta on an install behind a proxy.
                </p>
              )}
              {isOidc ? (
                <CopyRow label="Sign-in redirect URI" value={urls.redirectUri} />
              ) : (
                <>
                  <CopyRow label="Single sign-on URL (ACS)" value={urls.acsUrl} />
                  <CopyRow label="Audience URI (SP entity ID)" value={urls.spEntityId} />
                  <CopyRow label="SP metadata URL" value={urls.metadataUrl} />
                </>
              )}
            </div>
          )}
          <ol className="list-decimal pl-5 text-[11px] text-ink-muted leading-relaxed flex flex-col gap-1 pb-2">
            {steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </SettingGroup>

        {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2 mt-3">{error}</p>}
        <ChecksList result={testResult} />

        <div className="flex items-center gap-2 pt-4 mt-3 border-t border-cohesity-border/60 flex-wrap">
          <button type="button" onClick={save} disabled={saving || !!busy || !form.name.trim() || !form.slug.trim()} className={btnPrimary}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button type="button" onClick={saveAndTest} disabled={saving || !!busy || !form.name.trim() || !form.slug.trim()} className={btnPrimary}>
            <ShieldCheck size={13} /> {busy === 'test' ? 'Testing...' : 'Save and test'}
          </button>
          <button type="button" onClick={onClose} className={btnPlain}>Close</button>
        </div>
      </div>
    </Drawer>
  );
}

function TestedState({ p }) {
  if (p.testError) return <Badge tone="crit">{`Test failed: ${p.testError}`}</Badge>;
  if (p.testedAt) return <Badge tone="ok">{`Tested ${fmtWhen(p.testedAt)}`}</Badge>;
  return <Badge tone="warn">Not tested</Badge>;
}

export default function IdentityProvidersTab() {
  const { toast } = useToast();
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState(null);
  const [drawer, setDrawer] = useState(null); // { initial } | { newType }

  const load = useCallback(() => {
    setError(null);
    client.get('/idp/providers')
      .then(({ data }) => setProviders(data))
      .catch((err) => setError(errorMessage(err, 'Could not load identity providers.')));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggleEnabled = async (p) => {
    try {
      await client.put(`/idp/providers/${p.id}`, { enabled: !p.enabled });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not change the provider', message: errorMessage(err, '') });
    }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete provider "${p.name}"? Its linked groups and their access grants are removed. Users stay.`)) return;
    try {
      await client.delete(`/idp/providers/${p.id}`);
      toast({ type: 'success', title: 'Provider deleted' });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not delete the provider', message: errorMessage(err, '') });
    }
  };

  const edit = async (p) => {
    try {
      const { data } = await client.get(`/idp/providers/${p.id}`);
      setDrawer({ initial: data });
    } catch (err) {
      toast({ type: 'error', title: 'Could not load the provider', message: errorMessage(err, '') });
    }
  };

  if (error) return <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>;
  if (!providers) return <p className="text-xs text-ink-faint">Loading...</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-bold text-ink flex items-center gap-2"><Fingerprint size={15} className="text-brand" /> Identity providers</p>
        <p className="text-[11px] text-ink-muted mt-0.5">Where accounts come from besides local sign-in. Active Directory and Okta can run side by side; access always comes from linked groups.</p>
      </div>

      <DirectoryTab />

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-ink">Okta</p>
          <p className="text-[11px] text-ink-muted mt-0.5">Single sign-on through Okta, with optional Okta group and user lookup for RBAC.</p>
        </div>
        <button onClick={() => setDrawer({ newType: 'oidc' })} className={btnPrimary}><Plus size={13} /> Add Okta</button>
      </div>

      {providers.length === 0 && (
        <div className="panel p-6 text-center text-xs text-ink-faint">No Okta provider yet. Local and Active Directory sign-in keep working without one.</div>
      )}

      {providers.map((p) => (
        <div key={p.id} className="panel p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <p className="text-sm font-bold text-ink">{p.name}</p>
              <Badge tone="info">Okta</Badge>
              <span className="text-[10px] text-ink-faint">{p.type === 'saml' ? 'SAML 2.0' : 'OpenID Connect'}</span>
              <span className="text-[11px] text-ink-faint font-mono">{p.slug}</span>
              <TestedState p={p} />
            </div>
            <div className="flex items-center gap-3">
              <label className={`inline-flex items-center gap-2 select-none ${p.testedAt || p.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                title={p.testedAt || p.enabled ? '' : 'Run Save and test before enabling this provider.'}>
                <input type="checkbox" checked={!!p.enabled} disabled={!p.testedAt && !p.enabled}
                  onChange={() => toggleEnabled(p)} className="accent-brand cursor-pointer" />
                <span className="text-xs text-ink-muted">{p.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
              <button onClick={() => edit(p)} aria-label={`Edit ${p.name}`} className="text-ink-faint hover:text-brand cursor-pointer"><Pencil size={13} /></button>
              <button onClick={() => remove(p)} aria-label={`Delete ${p.name}`} className="text-ink-faint hover:text-status-crit cursor-pointer"><Trash2 size={13} /></button>
            </div>
          </div>
          <p className="text-[11px] text-ink-muted">
            {p.linkedGroups ?? 0} linked group{p.linkedGroups === 1 ? '' : 's'}, {p.users ?? 0} user{p.users === 1 ? '' : 's'}
            {p.mgmtKind === 'okta' ? ', Management API on' : ''}
          </p>
        </div>
      ))}

      {drawer && (
        <ProviderDrawer key={drawer.initial ? drawer.initial.id : `new-${drawer.newType}`}
          initial={drawer.initial} newType={drawer.newType}
          onClose={() => setDrawer(null)} onChanged={load} />
      )}
    </div>
  );
}
