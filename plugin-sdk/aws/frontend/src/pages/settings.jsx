// Ported from frontend/src/pages/aws/AwsSettingsPage.jsx — createPortal(...,
// document.body) replaced with ui.jsx's portalOrInline(), toast replaced
// with inline status text, client.* replaced with apiFetch (auto CSRF on
// mutating requests via window.__ICC_CSRF_TOKEN__).
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, Search, X } from '../icons.jsx';
import { apiFetch, PageHeader, Badge, LoadingPanel, Spinner, portalOrInline, BRAND, fmtWhen } from '../ui.jsx';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

const PROBE_SERVICES = ['ec2', 'ebs', 'lightsail', 'ecs', 's3', 'bedrock', 'cost', 'rds', 'lambda', 'dynamo', 'ecr', 'vpc'];

const CRED_TONE = { stored: 'ok', env: 'brand', none: 'neutral' };
const CRED_LABEL = { stored: 'Stored', env: 'Env fallback', none: 'None' };

function ProbeModal({ account, onClose }) {
  const [service, setService] = React.useState('ec2');
  const [result, setResult] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);

  const runProbe = (svc) => {
    setLoading(true);
    setError(false);
    setResult(null);
    apiFetch(`/aws/accounts/${account.id}/probe`, { params: { service: svc } })
      .then((json) => setResult(json))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  React.useEffect(() => { runProbe(service); }, [account.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return portalOrInline(
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
    </div>
  );
}

export default function AwsSettingsPage() {
  const [accounts, setAccounts] = React.useState(null);
  const [form, setForm] = React.useState({ name: '', accessKeyId: '', secretAccessKey: '', region: 'us-east-2', pollingIntervalMinutes: 10 });
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [probeAccount, setProbeAccount] = React.useState(null);
  const [costSpikePct, setCostSpikePct] = React.useState('');
  const [rdsStorageWarnPct, setRdsStorageWarnPct] = React.useState('');
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [statusMsg, setStatusMsg] = React.useState(null);

  const flash = (type, title, message) => setStatusMsg({ type, title, message });

  const loadAccounts = () => apiFetch('/aws/accounts')
    .then((json) => setAccounts(json))
    .catch(() => setAccounts([]));

  React.useEffect(() => {
    loadAccounts();
    apiFetch('/aws/config')
      .then((json) => {
        setCostSpikePct(String(json.costSpikePct));
        setRdsStorageWarnPct(String(json.rdsStorageWarnPct));
      })
      .catch(() => { setCostSpikePct('30'); setRdsStorageWarnPct('15'); });
  }, []);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const json = await apiFetch('/aws/config', { method: 'PUT', body: { costSpikePct: Number(costSpikePct), rdsStorageWarnPct: Number(rdsStorageWarnPct) } });
      setCostSpikePct(String(json.costSpikePct));
      setRdsStorageWarnPct(String(json.rdsStorageWarnPct));
      flash('ok', 'Thresholds saved', `Cost spike above ${json.costSpikePct}% day-over-day, RDS storage below ${json.rdsStorageWarnPct}% free.`);
    } catch (err) {
      flash('err', 'Save failed', err?.payload?.error || 'Enter valid threshold values.');
    } finally {
      setSavingConfig(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body = editingId
        ? { id: editingId }
        : { accessKeyId: form.accessKeyId.trim() || undefined, secretAccessKey: form.secretAccessKey || undefined, region: form.region };
      const json = await apiFetch('/aws/accounts/test', { method: 'POST', body });
      setTestResult(json);
    } catch (err) {
      setTestResult(err?.payload || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const blankForm = () => {
    setForm({ name: '', accessKeyId: '', secretAccessKey: '', region: 'us-east-2', pollingIntervalMinutes: 10 });
    setTestResult(null);
  };

  const startEdit = (a) => {
    setEditingId(a.id);
    setForm({
      name: a.name, accessKeyId: a.accessKeyId || '', secretAccessKey: '',
      region: a.region || 'us-east-2', pollingIntervalMinutes: a.pollingIntervalMinutes || 10,
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
      };
      if (form.accessKeyId.trim()) body.accessKeyId = form.accessKeyId.trim();
      if (form.secretAccessKey) body.secretAccessKey = form.secretAccessKey;
      if (editingId) {
        await apiFetch(`/aws/accounts/${editingId}`, { method: 'PUT', body });
        flash('ok', 'Account updated', form.secretAccessKey ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored credentials unchanged.');
      } else {
        await apiFetch('/aws/accounts', { method: 'POST', body });
        flash('ok', 'Account registered', 'First poll started — data appears shortly.');
      }
      setEditingId(null);
      blankForm();
      await loadAccounts();
    } catch (err) {
      flash('err', editingId ? 'Update failed' : 'Registration failed', err?.payload?.error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`Remove AWS account "${a.name}"? Its collected inventory is deleted.`)) return;
    try {
      await apiFetch(`/aws/accounts/${a.id}`, { method: 'DELETE' });
      await loadAccounts();
      flash('ok', `Removed ${a.name}`);
    } catch (err) {
      flash('err', 'Remove failed', err?.payload?.error);
    }
  };

  const refresh = async (a) => {
    setRefreshingId(a.id);
    try {
      await apiFetch(`/aws/accounts/${a.id}/refresh`, { method: 'POST', body: {} });
      await loadAccounts();
      flash('ok', `${a.name} refreshed`);
    } catch (err) {
      flash('err', `Refresh failed for ${a.name}`, err?.payload?.error);
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim();

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="AWS Settings" description="Register AWS accounts — credentials are encrypted at rest, or fall back to the server's environment variables" />

      {statusMsg && (
        <div className={`panel p-3 mb-4 border ${statusMsg.type === 'err' ? 'border-status-crit/50' : 'border-status-ok/40'}`}>
          <p className={`text-sm font-semibold ${statusMsg.type === 'err' ? 'text-status-crit' : 'text-status-ok'}`}>{statusMsg.title}</p>
          {statusMsg.message && <p className="text-xs text-ink-muted mt-0.5">{statusMsg.message}</p>}
        </div>
      )}

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'account'}` : 'Add an AWS account'}</p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          Leave the access key and secret blank to fall back to the server's <code>AWS_ACCESS_KEY_ID</code> / <code>AWS_SECRET_ACCESS_KEY</code> environment variables.
          Read-only IAM permissions are sufficient for polling. The secret is encrypted at rest.
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
            <label className="block text-xs font-semibold text-ink mb-1">Access key ID</label>
            <input value={form.accessKeyId} onChange={set('accessKeyId')} placeholder="AKIA… (blank = use server env)" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Secret access key{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep current</span> : ''}</label>
            <input type="password" value={form.secretAccessKey} onChange={set('secretAccessKey')} placeholder={editingId ? 'leave blank to keep current' : 'blank = use server env'} className={inp} />
          </div>
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
          <button onClick={add} disabled={saving || !canSubmit} className="aw-btn-primary">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add account'}
          </button>
          {editingId && (
            <button onClick={cancelEdit} className="aw-btn-ghost">
              Cancel
            </button>
          )}
          <button onClick={test} disabled={testing} className="aw-btn-ghost">
            {testing && <Spinner size={13} />} Test connection
          </button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok ? `Connected — ${testResult.instanceCount} instance(s) visible` : testResult.error}
            </span>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
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
            className="aw-btn-primary">
            {savingConfig ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

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
                      <span title={a.credSource === 'env' ? "Falling back to the server's .env credentials" : undefined}>
                        <Badge tone={CRED_TONE[a.credSource] || 'neutral'}>
                          {CRED_LABEL[a.credSource] || a.credSource}
                        </Badge>
                      </span>
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

      {probeAccount && <ProbeModal account={probeAccount} onClose={() => setProbeAccount(null)} />}
    </div>
  );
}
