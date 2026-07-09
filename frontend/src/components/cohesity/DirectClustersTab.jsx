import { useEffect, useState } from 'react';
import { Save, PlugZap, Server, Plus, Pencil, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { Badge } from '../ui/primitives';
import { useToast } from '../ui/Toaster';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-ink-faint mt-1">{hint}</p>}
    </div>
  );
}

/**
 * Add/edit form for a directly-connected Cohesity cluster.
 * `initial` omitted/null => add mode (POST). `initial` a cluster row => edit mode (PUT).
 */
export function DirectClusterForm({ initial, onSaved, onCancel }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [vip, setVip] = useState(initial?.vip || '');
  const [authType, setAuthType] = useState(initial?.auth_type || 'apikey');
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('local');
  const [pollingInterval, setPollingInterval] = useState(initial?.polling_interval_minutes || 15);
  const [sslVerify, setSslVerify] = useState(!!initial?.ssl_verify);
  const [tags, setTags] = useState(
    initial?.tags ? initial.tags.split(',').map(t => t.trim()).filter(Boolean) : []
  );
  const [tagInput, setTagInput] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags(prev => [...prev, t]);
    setTagInput('');
  };

  const buildCredentials = () => {
    if (authType === 'apikey') {
      return apiKey ? { apiKey } : undefined;
    }
    return (username || password) ? { username, password, domain } : undefined;
  };

  const canSave = name.trim() && vip.trim() && (
    isEdit || (authType === 'apikey' ? !!apiKey.trim() : !!(username.trim() && password))
  );
  const canTest = vip.trim() && (authType === 'apikey' ? !!apiKey.trim() : !!(username.trim() && password));

  const handleSave = async () => {
    setError(null);
    setSubmitting(true);
    const credentials = buildCredentials();
    const payload = {
      name: name.trim(),
      vip: vip.trim(),
      auth_type: authType,
      polling_interval_minutes: Number(pollingInterval) || 15,
      ssl_verify: sslVerify,
      tags: tags.join(', '),
    };
    try {
      if (isEdit) {
        if (credentials !== undefined) payload.credentials = credentials;
        await client.put(`/cohesity/clusters/${initial.id}`, payload);
      } else {
        payload.connection_type = 'direct';
        payload.credentials = credentials || {};
        await client.post('/cohesity/clusters', payload);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await client.post('/cohesity/clusters/test', {
        connection_type: 'direct',
        vip: vip.trim(),
        auth_type: authType,
        credentials: buildCredentials() || {},
        ssl_verify: sslVerify,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="border border-cohesity-border rounded-lg p-3">
      <p className="text-xs font-semibold text-ink mb-3">{isEdit ? `Edit — ${initial.name}` : 'Add direct cluster'}</p>
      {error && <p className="text-[12px] text-status-crit mb-2">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Cluster name">
          <input value={name} onChange={e => setName(e.target.value)} className={inp} />
        </Field>
        <Field label="VIP / Hostname">
          <input value={vip} onChange={e => setVip(e.target.value)} placeholder="e.g. 192.168.1.100 or mycluster.company.com" className={inp} spellCheck={false} />
        </Field>

        <div className="sm:col-span-2">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">Auth type</label>
          <div className="flex gap-4">
            {[['apikey', 'API Key'], ['userpass', 'Username / Password']].map(([val, label]) => (
              <label key={val} className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                <input type="radio" name={`direct-auth-${initial?.id || 'new'}`} value={val} checked={authType === val} onChange={() => setAuthType(val)} className="accent-brand" />
                {label}
              </label>
            ))}
          </div>
        </div>

        {authType === 'apikey' ? (
          <Field label="API key" hint={isEdit ? 'Stored — leave blank to keep.' : undefined}>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={isEdit ? '•••••• (stored — leave blank to keep)' : ''}
              autoComplete="new-password"
              className={inp}
            />
          </Field>
        ) : (
          <>
            <Field label="Username" hint={isEdit ? 'Leave blank to keep the stored username.' : undefined}>
              <input
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder={isEdit ? '•••••• (stored — leave blank to keep)' : ''}
                autoComplete="username"
                className={inp}
              />
            </Field>
            <Field label="Password" hint={isEdit ? 'Leave blank to keep the stored password.' : undefined}>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={isEdit ? '•••••• (stored — leave blank to keep)' : ''}
                autoComplete="new-password"
                className={inp}
              />
            </Field>
            <Field label="Domain">
              <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="local" className={inp} />
            </Field>
          </>
        )}

        <Field label="Polling interval (min)">
          <input type="number" min={5} value={pollingInterval} onChange={e => setPollingInterval(e.target.value)} className={inp} />
        </Field>

        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
            <input type="checkbox" checked={sslVerify} onChange={e => setSslVerify(e.target.checked)} className="accent-brand cursor-pointer" />
            Verify SSL certificate
          </label>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">Tags</label>
          <div className="flex flex-wrap gap-1 mb-2 min-h-[24px]">
            {tags.map(tag => (
              <span key={tag} className="inline-flex items-center gap-1 bg-surface-overlay border border-cohesity-border text-xs text-brand px-2 py-0.5 rounded">
                {tag}
                <button type="button" onClick={() => setTags(prev => prev.filter(t => t !== tag))} className="text-ink-faint hover:text-status-crit leading-none">×</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }}
              placeholder="Type a tag and press Enter"
              className={inp}
            />
            <button type="button" onClick={addTag} className="px-3 py-2 bg-surface-overlay border border-cohesity-border rounded-lg text-xs text-brand hover:border-brand/40 transition-colors">Add</button>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-ink-faint mt-3">
        {authType === 'apikey' ? (
          <>Requires an API key created on the cluster: Cohesity UI → Settings → Access Management → API Keys. A read-only role is sufficient for monitoring.{' '}
          <a href="https://developers.cohesity.com/v1-cluster-7.3.1/docs/getting-started" target="_blank" rel="noreferrer" className="underline hover:text-ink">Getting started with the Cohesity API</a></>
        ) : (
          <>Local or AD cluster account with at least a Viewer role. Domain is &lsquo;local&rsquo; for cluster-local users; use your AD domain otherwise.</>
        )}
      </p>

      {testResult && (
        <p className={`text-[12px] mt-2 ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
          {testResult.ok ? `✓ Connected — ${testResult.clusterName || 'cluster'} (${testResult.softwareVersion || 'unknown version'})` : `✗ ${testResult.error}`}
        </p>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={handleTest}
          disabled={testing || !canTest}
          title={!canTest && isEdit ? 'Type credentials above to test' : undefined}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40"
        >
          <PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          onClick={handleSave}
          disabled={submitting || !canSave}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40"
        >
          <Save size={13} /> {submitting ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="text-xs font-medium px-3.5 py-2 text-ink-faint hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function DirectClustersTab() {
  const { toast } = useToast();
  const [clusters, setClusters] = useState(null);
  const [mode, setMode] = useState(null); // null | 'add' | { edit: row }
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const load = () => {
    client.get('/cohesity/clusters')
      .then(({ data }) => setClusters(data.filter(c => c.connection_type === 'direct')))
      .catch(() => setClusters([]));
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (row) => {
    if (!window.confirm('Removing a cluster deletes its collected history.')) return;
    setDeleteConfirm(row.id);
    try {
      await client.delete(`/cohesity/clusters/${row.id}`);
      toast({ type: 'success', title: 'Cluster removed', message: row.name });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Delete failed', message: err.response?.data?.error || 'Delete failed.' });
    } finally {
      setDeleteConfirm(null);
    }
  };

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Server size={14} className="text-brand" />
          </div>
          <p className="text-sm font-bold text-ink">Direct clusters</p>
        </div>
        {!mode && (
          <button
            onClick={() => setMode('add')}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors"
          >
            <Plus size={13} /> Add cluster
          </button>
        )}
      </div>

      {mode && (
        <div className="mb-4">
          <DirectClusterForm
            initial={mode?.edit}
            onSaved={() => { setMode(null); load(); toast({ type: 'success', title: mode?.edit ? 'Cluster updated' : 'Cluster added' }); }}
            onCancel={() => setMode(null)}
          />
        </div>
      )}

      {clusters == null ? (
        <p className="text-sm text-ink-muted py-6 text-center">Loading…</p>
      ) : clusters.length === 0 ? (
        <p className="text-sm text-ink-muted py-6 text-center">No direct clusters configured yet. Add one to connect a standalone Cohesity cluster.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Cluster</th>
                <th className="py-2 pr-3">VIP / Hostname</th>
                <th className="py-2 pr-3">Auth type</th>
                <th className="py-2 pr-3">Poll interval</th>
                <th className="py-2 pr-3">TLS</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {clusters.map(c => (
                <tr key={c.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink font-medium">{c.name}</td>
                  <td className="py-2 pr-3 text-ink-muted">{c.vip}</td>
                  <td className="py-2 pr-3"><Badge tone="info">{c.auth_type === 'apikey' ? 'API Key' : 'User/Pass'}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted tnum">{c.polling_interval_minutes}m</td>
                  <td className="py-2 pr-3">{c.ssl_verify ? <Badge tone="ok">Verified</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                  <td className="py-2 pr-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        onClick={() => setMode({ edit: c })}
                        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors"
                      >
                        <Pencil size={12} /> Edit
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        disabled={deleteConfirm === c.id}
                        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-status-crit hover:border-status-crit/40 transition-colors disabled:opacity-40"
                      >
                        <Trash2 size={12} /> {deleteConfirm === c.id ? 'Removing…' : 'Delete'}
                      </button>
                    </div>
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
