import { useEffect, useState, useCallback } from 'react';
import { Settings, RefreshCw, Save, Clock, HardDrive, Play, Plus, Trash2, PlugZap } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, Badge } from '../../components/ui/primitives';
import { BRAND } from './helpers';

const MIN = 5;
const MAX = 1440;
const blankForm = { name: '', mgmt_host: '', username: '', password: '', ssl_verify: false, polling_interval_minutes: 15 };

export default function NetAppSettingsPage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [intervals, setIntervals] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [pollingId, setPollingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const [form, setForm] = useState(blankForm);
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(() => Promise.allSettled([client.get('/netapp/arrays'), client.get('/netapp/defaults')]).then(([a, d]) => {
    const list = a.status === 'fulfilled' ? a.value.data : [];
    setArrays(list);
    setIntervals(Object.fromEntries(list.map((x) => [x.id, String(x.polling_interval_minutes ?? 15)])));
    if (d.status === 'fulfilled' && d.value.data.username) setForm((f) => (f.username ? f : { ...f, username: d.value.data.username }));
    if (a.status === 'rejected') toast({ type: 'error', title: 'Failed to load NetApp clusters' });
  }), [toast]);

  useEffect(() => { load(); }, [load]);

  const saveInterval = async (array) => {
    const raw = Number(intervals[array.id]);
    if (!Number.isFinite(raw) || raw < MIN || raw > MAX) { toast({ type: 'error', title: 'Invalid interval', message: `Enter ${MIN}-${MAX} minutes.` }); return; }
    setSavingId(array.id);
    try {
      await client.put(`/netapp/arrays/${array.id}`, {
        name: array.name, mgmt_host: array.mgmt_host, username: array.username,
        ssl_verify: !!array.ssl_verify, polling_interval_minutes: raw,
      });
      toast({ type: 'success', title: 'Polling interval updated', message: `${array.name} now polls every ${raw} min.` });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Update failed', message: err?.response?.data?.error || 'Could not update.' });
    } finally { setSavingId(null); }
  };

  const pollNow = async (array) => {
    setPollingId(array.id);
    try { await client.post(`/netapp/arrays/${array.id}/poll`); toast({ type: 'success', title: 'Poll triggered', message: `Collecting from ${array.name}.` }); }
    catch (err) { toast({ type: 'error', title: 'Poll failed', message: err?.response?.data?.error || 'Poll failed.' }); }
    finally { setPollingId(null); }
  };

  const removeArray = async (array) => {
    setDeletingId(array.id);
    try { await client.delete(`/netapp/arrays/${array.id}`); toast({ type: 'success', title: 'Cluster removed', message: array.name }); load(); }
    catch (err) { toast({ type: 'error', title: 'Delete failed', message: err?.response?.data?.error || 'Could not delete.' }); }
    finally { setDeletingId(null); }
  };

  const testConn = async () => {
    setTesting(true); setTestResult(null);
    try {
      const { data } = await client.post('/netapp/arrays/test', {
        mgmt_host: form.mgmt_host, username: form.username, password: form.password, ssl_verify: form.ssl_verify,
      });
      setTestResult({ ok: true, msg: `${data.clusterName} · ${(data.ontapVersion || '').replace('NetApp Release ', '')}` });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.response?.data?.error || 'Connection failed' });
    } finally { setTesting(false); }
  };

  const addCluster = async () => {
    setAdding(true);
    try {
      await client.post('/netapp/arrays', { ...form, polling_interval_minutes: Number(form.polling_interval_minutes) || 15 });
      toast({ type: 'success', title: 'Cluster added', message: form.name });
      setForm({ ...blankForm, username: form.username });
      setTestResult(null);
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Add failed', message: err?.response?.data?.error || err?.response?.data?.errors?.[0]?.msg || 'Could not add cluster.' });
    } finally { setAdding(false); }
  };

  const canAdd = form.name && form.mgmt_host && form.username && form.password;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="NetApp Settings" description="Register ONTAP clusters and configure polling">
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      {/* Add cluster */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3"><Plus size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Add ONTAP Cluster</p></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Display name"><input value={form.name} onChange={set('name')} placeholder="nasft1" className={inp} /></Field>
          <Field label="Management host"><input value={form.mgmt_host} onChange={set('mgmt_host')} placeholder="nasft1.example.com" className={inp} /></Field>
          <Field label="Username"><input value={form.username} onChange={set('username')} placeholder="admin" className={inp} /></Field>
          <Field label="Password"><input type="password" value={form.password} onChange={set('password')} placeholder="••••••••" className={inp} autoComplete="new-password" /></Field>
          <Field label="Polling interval (min)"><input type="number" min={MIN} max={MAX} step="5" value={form.polling_interval_minutes} onChange={set('polling_interval_minutes')} className={inp} /></Field>
          <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer mt-6 select-none">
            <input type="checkbox" checked={form.ssl_verify} onChange={set('ssl_verify')} className="accent-brand cursor-pointer" /> Verify SSL certificate
          </label>
        </div>
        {testResult && (
          <p className={`text-[11px] mt-2 ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>{testResult.ok ? '✓ ' : '✗ '}{testResult.msg}</p>
        )}
        <div className="flex items-center gap-2 mt-3">
          <button onClick={testConn} disabled={testing || !form.mgmt_host || !form.username || !form.password}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
            <PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button onClick={addCluster} disabled={adding || !canAdd}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40">
            <Save size={13} /> {adding ? 'Adding…' : 'Add cluster'}
          </button>
        </div>
      </div>

      {/* Registered clusters */}
      {arrays == null ? (
        <LoadingPanel label="Loading clusters…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-6 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>No clusters registered yet.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {arrays.map((a) => {
            const edited = String(a.polling_interval_minutes ?? 15) !== String(intervals[a.id] ?? '');
            return (
              <div key={a.id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border flex-shrink-0" style={{ backgroundColor: `${BRAND}15`, borderColor: `${BRAND}40` }}><HardDrive size={16} style={{ color: BRAND }} /></div>
                    <div className="min-w-0"><p className="text-sm font-bold text-ink truncate">{a.name}</p><p className="text-[11px] text-ink-faint truncate">{a.mgmt_host} · {a.username}</p></div>
                  </div>
                  <Badge tone="neutral">ONTAP</Badge>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1"><Clock size={11} className="inline mr-1 -mt-0.5" />Interval (min)</label>
                    <input type="number" min={MIN} max={MAX} step="5" value={intervals[a.id] ?? ''} onChange={(e) => setIntervals((m) => ({ ...m, [a.id]: e.target.value }))} className="w-28 bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none tnum" />
                  </div>
                  <button onClick={() => saveInterval(a)} disabled={savingId === a.id || !edited}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40">
                    <Save size={13} /> {savingId === a.id ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => pollNow(a)} disabled={pollingId === a.id}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
                    <Play size={13} /> {pollingId === a.id ? 'Polling…' : 'Poll now'}
                  </button>
                  <button onClick={() => removeArray(a)} disabled={deletingId === a.id}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-red-800 text-red-400 rounded-lg hover:border-red-500 transition-colors disabled:opacity-50 ml-auto">
                    <Trash2 size={13} /> {deletingId === a.id ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
function Field({ label, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">{label}</label>
      {children}
    </div>
  );
}
