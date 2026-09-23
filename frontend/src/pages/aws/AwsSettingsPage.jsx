import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, Search, X, SlidersHorizontal } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import PlatformSettingsLayout from '../../components/PlatformSettingsLayout';
import { BRAND, fmtWhen } from './helpers';
import PlatformAlertNotifications from '../../components/PlatformAlertNotifications';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

const PROBE_SERVICES = ['ec2', 'ebs', 'lightsail', 'ecs', 's3', 'bedrock', 'cost', 'rds', 'lambda', 'dynamo', 'ecr', 'vpc'];

const CRED_TONE = { role: 'ok', stored: 'ok', session: 'warn', profile: 'ok', env: 'brand', none: 'neutral' };
const CRED_LABEL = { role: 'Assume role', stored: 'Access key', session: 'Session key', profile: 'Named profile', env: 'Env fallback', none: 'Host identity' };
const BASE_LABEL = { stored: 'stored key', session: 'session key', profile: 'named profile', env: 'server env', host: 'host identity' };

const EMPTY_FORM = {
  name: '', region: 'us-east-2', pollingIntervalMinutes: 10,
  authMode: 'key', baseSource: 'host',
  accessKeyId: '', secretAccessKey: '', sessionToken: '', credentialExpiresAt: '',
  roleArn: '', externalId: '', roleSessionName: 'icc', profileName: '',
};

// ISO -> value for <input type="datetime-local"> in the browser's zone.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtExpiry(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return { text: 'expired', tone: 'crit' };
  if (mins < 60) return { text: `expires in ${mins}m`, tone: 'warn' };
  if (mins < 48 * 60) return { text: `expires in ${Math.round(mins / 60)}h`, tone: mins < 120 ? 'warn' : 'neutral' };
  return { text: `expires ${new Date(ms).toLocaleDateString()}`, tone: 'neutral' };
}

// Portal to <body> — the page wrapper's fade-in animation leaves a transform
// applied (fill-mode: both), which would re-anchor position:fixed to the
// page div and cut off the modal top on scrolled/short pages.
function ProbeModal({ account, onClose }) {
  const [service, setService] = useState('ec2');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const runProbe = (svc) => {
    setLoading(true);
    setError(false);
    setResult(null);
    client.get(`/aws/accounts/${account.id}/probe`, { params: { service: svc }, timeout: 120000 })
      .then(({ data }) => setResult(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { runProbe(service); }, [account.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-3xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <Search size={15} className="text-brand" /> Raw probe — {account.name}
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">Live per-service fetch against AWS — read-only, does not touch stored data.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <select value={service} onChange={(e) => { setService(e.target.value); runProbe(e.target.value); }}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
            {PROBE_SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={() => runProbe(service)} disabled={loading}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5">
            {loading && <Spinner size={12} />} Run
          </button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0 flex-1">
          {error ? (
            <div className="text-sm text-status-crit py-6 text-center">Probe failed — the account may be unreachable.</div>
          ) : loading || result == null ? (
            <div className="py-10 flex justify-center"><Spinner size={20} /></div>
          ) : (
            <pre className="bg-surface-overlay rounded-lg p-3 text-[11px] text-ink-muted whitespace-pre-wrap break-all">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function AwsSettingsPage() {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [probeAccount, setProbeAccount] = useState(null);
  const [costSpikePct, setCostSpikePct] = useState('');
  const [rdsStorageWarnPct, setRdsStorageWarnPct] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  const loadAccounts = () => client.get('/aws/accounts')
    .then(({ data }) => setAccounts(data))
    .catch(() => setAccounts([]));

  useEffect(() => {
    loadAccounts();
    client.get('/aws/config')
      .then(({ data }) => {
        setCostSpikePct(String(data.costSpikePct));
        setRdsStorageWarnPct(String(data.rdsStorageWarnPct));
      })
      .catch(() => { setCostSpikePct('30'); setRdsStorageWarnPct('15'); });
  }, []);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const { data } = await client.put('/aws/config', { costSpikePct: Number(costSpikePct), rdsStorageWarnPct: Number(rdsStorageWarnPct) });
      setCostSpikePct(String(data.costSpikePct));
      setRdsStorageWarnPct(String(data.rdsStorageWarnPct));
      toast({ type: 'success', title: 'Thresholds saved', message: `Cost spike above ${data.costSpikePct}% day-over-day, RDS storage below ${data.rdsStorageWarnPct}% free.` });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Enter valid threshold values.' });
    } finally {
      setSavingConfig(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Which credential fields the current mode uses.
  const usesKey = form.authMode === 'key' || (form.authMode === 'role' && form.baseSource === 'key');
  const usesProfile = form.authMode === 'profile' || (form.authMode === 'role' && form.baseSource === 'profile');

  // Body shared by save and test: blank strings clear, omitted keeps stored.
  const credentialBody = (forTest) => {
    const body = { authMode: form.authMode };
    if (usesKey) {
      body.accessKeyId = form.accessKeyId.trim();
      if (form.secretAccessKey) body.secretAccessKey = form.secretAccessKey;
      body.sessionToken = form.sessionToken.trim();
      body.credentialExpiresAt = form.credentialExpiresAt ? new Date(form.credentialExpiresAt).toISOString() : '';
    } else if (!forTest) {
      body.accessKeyId = '';
      body.clearSecret = true;
      body.sessionToken = '';
      body.credentialExpiresAt = '';
    }
    body.profileName = usesProfile ? form.profileName.trim() : '';
    if (form.authMode === 'role') {
      body.roleArn = form.roleArn.trim();
      body.roleSessionName = form.roleSessionName.trim() || 'icc';
      if (form.externalId || !forTest) body.externalId = form.externalId;
    } else if (!forTest) {
      body.roleArn = '';
      body.externalId = '';
    }
    return body;
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body = { ...credentialBody(true), region: form.region };
      if (editingId) body.id = editingId;
      // Nothing typed into a stored field means test what is stored.
      for (const k of Object.keys(body)) if (body[k] === '' && k !== 'region') delete body[k];
      const { data } = await client.post('/aws/accounts/test', body);
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const blankForm = () => {
    setForm(EMPTY_FORM);
    setTestResult(null);
  };

  const startEdit = (a) => {
    setEditingId(a.id);
    setForm({
      ...EMPTY_FORM,
      name: a.name, region: a.region || 'us-east-2', pollingIntervalMinutes: a.pollingIntervalMinutes || 10,
      authMode: a.authMode || 'key',
      baseSource: a.baseSource === 'stored' || a.baseSource === 'session' ? 'key' : a.baseSource === 'profile' ? 'profile' : 'host',
      accessKeyId: a.accessKeyId || '', secretAccessKey: '', sessionToken: '',
      credentialExpiresAt: toLocalInput(a.credentialExpiresAt),
      roleArn: a.roleArn || '', externalId: '', roleSessionName: a.roleSessionName || 'icc', profileName: a.profileName || '',
    });
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditingId(null); blankForm(); };

  const add = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        region: form.region.trim() || 'us-east-2',
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 10,
        ...credentialBody(false),
      };
      if (editingId) {
        await client.put(`/aws/accounts/${editingId}`, body);
        toast({ type: 'success', title: 'Account updated', message: form.secretAccessKey ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored credentials unchanged.' });
      } else {
        await client.post('/aws/accounts', body);
        toast({ type: 'success', title: 'Account registered', message: 'First poll started — data appears shortly.' });
      }
      setEditingId(null);
      blankForm();
      await loadAccounts();
    } catch (err) {
      toast({ type: 'error', title: editingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`Remove AWS account "${a.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/aws/accounts/${a.id}`);
      await loadAccounts();
      toast({ type: 'success', title: `Removed ${a.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const refresh = async (a) => {
    setRefreshingId(a.id);
    try {
      await client.post(`/aws/accounts/${a.id}/refresh`, {}, { timeout: 300000 });
      await loadAccounts();
      toast({ type: 'success', title: `${a.name} refreshed` });
    } catch (err) {
      toast({ type: 'error', title: `Refresh failed for ${a.name}`, message: err?.response?.data?.error });
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim()
    && (form.authMode !== 'role' || form.roleArn.trim())
    && (!usesProfile || form.profileName.trim());
  const [section, setSection] = useState('sources');
  const SECTIONS = [
    { key: 'sources', label: 'Accounts', icon: Server },
    { key: 'thresholds', label: 'Alert Thresholds', icon: SlidersHorizontal },
    { key: 'notify', label: 'Alert Notifications', icon: BellRing },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="AWS Settings" description="Register AWS accounts — credentials are encrypted at rest, or fall back to the server's environment variables" />

      <PlatformSettingsLayout brand={BRAND} label="AWS" sections={SECTIONS} active={section} onSelect={setSection}>
      {section === 'sources' && (<>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'account'}` : 'Add an AWS account'}</p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          Read-only IAM permissions are sufficient for polling. Secrets are encrypted at rest. Assume role is the option that never
          hands ICC a user key: the account owner creates a role with a trust policy (and an external ID) and ICC assumes it from
          a stored key, a named profile, or the identity of the box ICC runs on (instance profile, IAM Roles Anywhere, or the
          server's <code>AWS_ACCESS_KEY_ID</code> / <code>AWS_SECRET_ACCESS_KEY</code>).
        </p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Prod AWS" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Authentication</label>
            <select value={form.authMode} onChange={set('authMode')} className={inp}>
              <option value="key">Access key (long-lived or session)</option>
              <option value="role">Assume role (STS)</option>
              <option value="profile">Named profile on the ICC server</option>
            </select>
          </div>
          {form.authMode === 'role' && (
            <div>
              <label className="block text-xs font-semibold text-ink mb-1">Assume the role from</label>
              <select value={form.baseSource} onChange={set('baseSource')} className={inp}>
                <option value="host">This server's identity (instance profile, Roles Anywhere, env)</option>
                <option value="key">An access key entered below</option>
                <option value="profile">A named profile on this server</option>
              </select>
            </div>
          )}
          {form.authMode === 'role' && (
            <>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Role ARN</label>
                <input value={form.roleArn} onChange={set('roleArn')} placeholder="arn:aws:iam::123456789012:role/ICCReadOnly" className={inp} spellCheck={false} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">External ID{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep current</span> : <span className="font-normal text-ink-faint"> (optional, from the trust policy)</span>}</label>
                <input type="password" value={form.externalId} onChange={set('externalId')} className={inp} spellCheck={false} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Session name</label>
                <input value={form.roleSessionName} onChange={set('roleSessionName')} placeholder="icc" className={inp} spellCheck={false} />
              </div>
            </>
          )}
          {usesKey && (
            <>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Access key ID</label>
                <input value={form.accessKeyId} onChange={set('accessKeyId')} placeholder={form.authMode === 'key' ? 'AKIA... or ASIA... (blank = server env or host identity)' : 'AKIA... or ASIA...'} className={inp} spellCheck={false} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Secret access key{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep current</span> : ''}</label>
                <input type="password" value={form.secretAccessKey} onChange={set('secretAccessKey')} placeholder={editingId ? 'leave blank to keep current' : ''} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Session token <span className="font-normal text-ink-faint">(temporary credentials only)</span></label>
                <input type="password" value={form.sessionToken} onChange={set('sessionToken')} placeholder={editingId ? 'blank = keep current, clears when a new secret is entered' : 'from STS, Identity Center or the CLI'} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Session expires <span className="font-normal text-ink-faint">(optional; ICC warns before and stops polling after)</span></label>
                <input type="datetime-local" value={form.credentialExpiresAt} onChange={set('credentialExpiresAt')} className={inp} />
              </div>
            </>
          )}
          {usesProfile && (
            <div>
              <label className="block text-xs font-semibold text-ink mb-1">Profile name <span className="font-normal text-ink-faint">(in ~/.aws on the ICC server: SSO, credential_process, Roles Anywhere)</span></label>
              <input value={form.profileName} onChange={set('profileName')} placeholder="icc-prod" className={inp} spellCheck={false} />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Region</label>
            <select value={form.region} onChange={set('region')} className={inp}>
              <option value="us-east-1">us-east-1 (N. Virginia)</option>
              <option value="us-east-2">us-east-2 (Ohio)</option>
              <option value="us-west-1">us-west-1 (N. California)</option>
              <option value="us-west-2">us-west-2 (Oregon)</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={saving || !canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add account'}
          </button>
          {editingId && (
            <button onClick={cancelEdit}
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer">
              Cancel
            </button>
          )}
          <button onClick={test} disabled={testing}
            className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-2">
            {testing && <Spinner size={13} />} Test connection
          </button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok
                ? `Connected as ${testResult.identity?.arn || 'unknown identity'} (account ${testResult.identity?.account || '?'}), ${testResult.instanceCount} instance(s) visible`
                : testResult.error}
            </span>
          )}
        </div>
      </div>

      </>)}
      {section === 'thresholds' && (<>
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
          How far above the prior day's spend yesterday's total must be (and at least $1) before the Overview raises a cost-spike warning,
          and how low an RDS instance's free storage can drop before it's flagged.
        </p>
        <div className="flex items-end gap-3">
          <div className="w-56">
            <label className="block text-xs font-semibold text-ink mb-1">Cost spike (% day-over-day)</label>
            <input type="number" min={5} max={500} value={costSpikePct}
              onChange={(e) => setCostSpikePct(e.target.value)} className={inp} />
          </div>
          <div className="w-56">
            <label className="block text-xs font-semibold text-ink mb-1">RDS free storage warning (%)</label>
            <input type="number" min={5} max={50} value={rdsStorageWarnPct}
              onChange={(e) => setRdsStorageWarnPct(e.target.value)} className={inp} />
          </div>
          <button onClick={saveConfig}
            disabled={savingConfig || !costSpikePct || Number(costSpikePct) < 5 || Number(costSpikePct) > 500
              || !rdsStorageWarnPct || Number(rdsStorageWarnPct) < 5 || Number(rdsStorageWarnPct) > 50}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {savingConfig ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      </>)}
      {section === 'notify' && (<>
      <div>
        <PlatformAlertNotifications platform="aws" label="AWS" />
      </div>

      </>)}
      {section === 'sources' && (<>
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Registered Accounts</p>
        {accounts == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : accounts.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No AWS accounts registered yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Region</th>
                <th className="py-2 pr-3">Credentials</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last Poll</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink whitespace-nowrap">{a.name}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap">{a.region}</td>
                    <td className="py-2 pr-3">
                      {(() => {
                        const exp = fmtExpiry(a.credentialExpiresAt);
                        const title = a.credSource === 'role'
                          ? `${a.roleArn} from ${BASE_LABEL[a.baseSource] || a.baseSource}`
                          : a.credSource === 'profile' ? `~/.aws profile ${a.profileName}`
                            : a.credSource === 'env' ? "Falling back to the server's .env credentials"
                              : a.credSource === 'none' ? 'No key stored: the SDK uses the identity of the server ICC runs on' : undefined;
                        return (
                          <span title={title} className="inline-flex items-center gap-1.5">
                            <Badge tone={exp?.tone === 'crit' ? 'crit' : (CRED_TONE[a.credSource] || 'neutral')}>
                              {CRED_LABEL[a.credSource] || a.credSource}
                            </Badge>
                            {exp && <span className={`text-[10px] ${exp.tone === 'crit' ? 'text-status-crit' : exp.tone === 'warn' ? 'text-status-warn' : 'text-ink-faint'}`}>{exp.text}</span>}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={a.lastPollStatus === 'error' ? 'crit' : a.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {a.lastPollStatus === 'error' ? 'Error' : a.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {a.lastPollStatus === 'error' && a.lastPollError && (
                        <p className="text-[10px] text-status-crit mt-0.5 max-w-[260px] truncate" title={a.lastPollError}>{a.lastPollError}</p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(a.lastPollAt)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => setProbeAccount(a)} title="Raw probe" aria-label={`Probe ${a.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Search size={13} />
                        </button>
                        <button onClick={() => startEdit(a)} title="Edit connection / update credentials" aria-label={`Edit ${a.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => refresh(a)} disabled={refreshingId === a.id} title="Poll now" aria-label={`Poll ${a.name} now`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
                          <RefreshCw size={13} className={refreshingId === a.id ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => remove(a)} title="Remove" aria-label={`Remove ${a.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-status-crit hover:border-status-crit/50 transition-colors cursor-pointer">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
          The AWS platform tab itself is enabled from Global Settings (gear icon → Platforms).
        </p>
      </div>

      </>)}
      </PlatformSettingsLayout>
      {probeAccount && <ProbeModal account={probeAccount} onClose={() => setProbeAccount(null)} />}
    </div>
  );
}
