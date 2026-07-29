import { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, Pencil, Trash2, PlugZap, RefreshCw } from 'lucide-react';
import client from '../api/client';

const input = 'w-full bg-surface-raised border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-faint focus:border-brand/60 transition-colors';
const EMPTY = { name: '', url: '', apiKey: '', notes: '', enabled: true };

export default function TenantsAdminPage() {
  const [tenants, setTenants] = useState(null);
  const [form, setForm] = useState(null); // null = closed, {id?...} = add/edit
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await client.get('/tenants');
      setTenants(data.tenants);
    } catch {
      setError('Failed to load tenants.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm({ ...EMPTY }); setTestResult(null); setError(null); };
  const openEdit = (t) => {
    setForm({ id: t.id, name: t.name, url: t.url, apiKey: '', notes: t.notes || '', enabled: t.enabled, hasApiKey: t.hasApiKey });
    setTestResult(null);
    setError(null);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: form.name, url: form.url, notes: form.notes, enabled: form.enabled };
      if (form.apiKey) body.apiKey = form.apiKey;
      if (form.id) await client.put(`/tenants/${form.id}`, body);
      else await client.post('/tenants', body);
      setForm(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const body = { url: form.url, apiKey: form.apiKey || undefined, id: form.id };
      const { data } = await client.post('/tenants/test', body);
      setTestResult({ ok: true, text: `Connected — ${data.platforms} platform(s), ${Number(data.objects).toLocaleString()} objects` });
    } catch (err) {
      setTestResult({ ok: false, text: err.response?.data?.error || 'Connection failed.' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t) => {
    if (!window.confirm(`Remove tenant "${t.name}"? The ICC instance itself is not touched.`)) return;
    try {
      await client.delete(`/tenants/${t.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed.');
    }
  };

  const refresh = async (t) => {
    try {
      await client.post(`/tenants/${t.id}/refresh`);
      await load();
    } catch { /* row keeps its last state */ }
  };

  return (
    <div className="flex flex-col gap-4 animate-fade-in max-w-4xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Tenants</h1>
          <p className="text-xs text-ink-muted mt-0.5">Registered ICC instances. The API key is each instance's DASHBOARD_API_KEY — stored encrypted, used only server-side.</p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 bg-brand hover:bg-brand-dark text-white rounded-lg transition-colors cursor-pointer"
        >
          <Plus size={14} /> Add tenant
        </button>
      </div>

      {error && !form && <p className="text-xs text-status-crit">{error}</p>}

      <div className="panel overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-faint border-b border-cohesity-border">
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">URL</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">Enabled</th>
              <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tenants === null ? (
              <tr><td colSpan={5} className="px-4 py-6 text-ink-faint">Loading…</td></tr>
            ) : tenants.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-ink-muted">No tenants yet.</td></tr>
            ) : tenants.map((t) => (
              <tr key={t.id} className="border-b border-cohesity-border/50 last:border-0">
                <td className="px-4 py-2.5 font-semibold text-ink flex items-center gap-2">
                  <Building2 size={13} className="text-ink-faint" /> {t.name}
                </td>
                <td className="px-4 py-2.5 text-ink-muted font-mono text-[11px]">{t.url}</td>
                <td className="px-4 py-2.5">
                  {t.lastFetchOk === null ? <span className="text-ink-faint">—</span>
                    : t.lastFetchOk ? <span className="text-status-ok">reachable</span>
                    : <span className="text-status-crit" title={t.lastFetchError}>unreachable</span>}
                </td>
                <td className="px-4 py-2.5">{t.enabled ? 'yes' : 'no'}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => refresh(t)} title="Poll now" className="p-1.5 rounded-md text-ink-faint hover:text-brand hover:bg-surface-raised transition-colors cursor-pointer"><RefreshCw size={13} /></button>
                    <button onClick={() => openEdit(t)} title="Edit" className="p-1.5 rounded-md text-ink-faint hover:text-brand hover:bg-surface-raised transition-colors cursor-pointer"><Pencil size={13} /></button>
                    <button onClick={() => remove(t)} title="Remove" className="p-1.5 rounded-md text-ink-faint hover:text-status-crit hover:bg-surface-raised transition-colors cursor-pointer"><Trash2 size={13} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <form onSubmit={save} className="panel p-5 flex flex-col gap-3 max-w-xl">
          <p className="text-sm font-bold text-ink">{form.id ? `Edit tenant` : 'Add tenant'}</p>
          <input className={input} placeholder="Customer name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          <input className={input} placeholder="Instance URL (e.g. https://icc.customer.example)" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <input
            className={`${input} font-mono`}
            type="password"
            placeholder={form.hasApiKey ? 'API key (leave blank to keep current)' : 'DASHBOARD_API_KEY of the instance'}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            autoComplete="new-password"
          />
          <input className={input} placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Enabled (included in the rollup)
          </label>
          {testResult && (
            <p className={`text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>{testResult.text}</p>
          )}
          {error && <p className="text-xs text-status-crit">{error}</p>}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy} className="text-xs font-semibold px-3 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg transition-colors cursor-pointer">
              {form.id ? 'Save changes' : 'Add tenant'}
            </button>
            <button type="button" onClick={test} disabled={busy || !form.url} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink rounded-lg hover:border-brand/50 hover:text-brand disabled:opacity-50 transition-colors cursor-pointer">
              <PlugZap size={13} /> Test connection
            </button>
            <button type="button" onClick={() => setForm(null)} className="text-xs font-medium px-3 py-2 text-ink-muted hover:text-ink transition-colors cursor-pointer">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
