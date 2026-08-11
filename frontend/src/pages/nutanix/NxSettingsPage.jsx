import { useEffect, useState, useCallback } from 'react';
import {
  Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil,
  ArrowRightLeft,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
const btnPrimary = 'px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer';
const btnGhost = 'px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer';
const iconBtn = 'flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

const TABS = [
  { key: 'prism_central', label: 'Prism Central' },
  { key: 'prism_element', label: 'Prism Element' },
];

// Side-menu sections (AdminNav styling) — one visible at a time.
const SECTIONS = [
  { key: 'sources', label: 'Prism Sources', icon: Server, group: 'Connections' },
  { key: 'move', label: 'Move Appliances', icon: ArrowRightLeft, group: 'Connections' },
  { key: 'thresholds', label: 'Alert Thresholds', icon: BellRing, group: 'Tuning' },
];

const blankSourceForm = (sourceType) => ({
  name: '', host: '', port: 9440, username: '', password: '',
  sslVerify: false, pollingIntervalMinutes: 15, sourceType,
});

function SourceTable({ sources, onEdit, onDelete, onPoll, pollingId }) {
  if (sources.length === 0) return <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
          <th className="py-2 pr-3">Name</th>
          <th className="py-2 pr-3">Host</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2 pr-3">Last Poll</th>
          <th className="py-2 pr-3 text-right">Clusters</th>
          <th className="py-2 pr-3 text-right">Actions</th>
        </tr></thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id} className="border-b border-cohesity-border/50">
              <td className="py-2 pr-3 text-ink whitespace-nowrap">{s.name}{s.isCe && <Badge tone="info" className="ml-1.5">CE</Badge>}</td>
              <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap">{s.host}:{s.port || 9440}</td>
              <td className="py-2 pr-3">
                <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                  {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                </Badge>
                {s.lastPollStatus === 'error' && s.lastPollError && (
                  <p className="text-[10px] text-status-crit mt-0.5 max-w-[220px] truncate" title={s.lastPollError}>{s.lastPollError}</p>
                )}
              </td>
              <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(s.lastPollAt)}</td>
              <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.clusterCount ?? '—'}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center justify-end gap-1.5">
                  <button onClick={() => onEdit(s)} title="Edit connection" aria-label={`Edit ${s.name}`} className={iconBtn}><Pencil size={13} /></button>
                  <button onClick={() => onPoll(s)} disabled={pollingId === s.id} title="Poll now" aria-label={`Poll ${s.name} now`} className={iconBtn}>
                    <RefreshCw size={13} className={pollingId === s.id ? 'animate-spin' : ''} />
                  </button>
                  <button onClick={() => onDelete(s)} title="Remove" aria-label={`Remove ${s.name}`}
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
  );
}

export default function NxSettingsPage() {
  const { toast } = useToast();
  const [section, setSection] = useState('sources');
  const [tab, setTab] = useState('prism_central');
  const [sources, setSources] = useState(null);
  const [form, setForm] = useState(blankSourceForm('prism_central'));
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pollingId, setPollingId] = useState(null);

  const [moveConns, setMoveConns] = useState(null);
  const [moveForm, setMoveForm] = useState({ name: '', host: '', username: '', password: '', sslVerify: false });
  const [moveEditingId, setMoveEditingId] = useState(null);
  const [moveSaving, setMoveSaving] = useState(false);
  const [movePollingId, setMovePollingId] = useState(null);

  const [config, setConfig] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);

  const loadSources = useCallback(() => client.get('/nutanix/sources')
    .then(({ data }) => setSources(data.sources || []))
    .catch(() => setSources([])), []);

  const loadMoveConns = useCallback(() => client.get('/nutanix/move/connections')
    .then(({ data }) => setMoveConns(data.connections || []))
    .catch(() => setMoveConns([])), []);

  useEffect(() => {
    loadSources();
    loadMoveConns();
    client.get('/nutanix/config')
      .then(({ data }) => setConfig(data))
      .catch(() => setConfig({ containerWarnPct: 85, containerCritPct: 95, clusterWarnPct: 80, clusterCritPct: 90, rpoGracePct: 50, runwayWarnDays: 90 }));
  }, [loadSources, loadMoveConns]);

  const set = (setter) => (k) => (e) => setter(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setF = set(setForm);
  const setMoveF = set(setMoveForm);

  const switchTab = (k) => {
    setTab(k);
    setEditingId(null);
    setForm(blankSourceForm(k));
    setTestResult(null);
  };

  // ── Prism sources ────────────────────────────────────────────────────────
  const testSource = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await client.post('/nutanix/sources/test', {
        sourceType: form.sourceType, host: form.host.trim(), port: Number(form.port) || 9440,
        username: form.username.trim(), password: form.password || undefined, sslVerify: form.sslVerify,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const startEditSource = (s) => {
    setTab(s.sourceType);
    setEditingId(s.id);
    setForm({
      name: s.name, host: s.host, port: s.port || 9440, username: s.username || '', password: '',
      sslVerify: !!s.sslVerify, pollingIntervalMinutes: s.pollingIntervalMinutes || 15, sourceType: s.sourceType,
    });
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEditSource = () => { setEditingId(null); setForm(blankSourceForm(tab)); setTestResult(null); };

  const saveSource = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), sourceType: form.sourceType, host: form.host.trim(),
        port: Number(form.port) || 9440, username: form.username.trim(),
        sslVerify: form.sslVerify, pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
      };
      if (editingId) {
        // Blank password = keep the stored one (omit from the PUT body).
        if (form.password) body.password = form.password;
        await client.put(`/nutanix/sources/${editingId}`, body);
        toast({ type: 'success', title: 'Source updated', message: form.password ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored password unchanged.' });
      } else {
        body.password = form.password;
        await client.post('/nutanix/sources', body);
        toast({ type: 'success', title: 'Source registered', message: 'First poll started — data appears shortly.' });
      }
      setEditingId(null);
      setForm(blankSourceForm(tab));
      setTestResult(null);
      await loadSources();
    } catch (err) {
      toast({ type: 'error', title: editingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const deleteSource = async (s) => {
    if (!window.confirm(`Remove source "${s.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/nutanix/sources/${s.id}`);
      await loadSources();
      toast({ type: 'success', title: `Removed ${s.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const pollSource = async (s) => {
    setPollingId(s.id);
    try {
      await client.post(`/nutanix/sources/${s.id}/poll`, {}, { timeout: 300000 });
      await loadSources();
      toast({ type: 'success', title: `${s.name} polled` });
    } catch (err) {
      toast({ type: 'error', title: `Poll failed for ${s.name}`, message: err?.response?.data?.error });
    } finally {
      setPollingId(null);
    }
  };

  const canSubmitSource = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);
  const tabSources = (sources || []).filter(s => s.sourceType === tab);

  // ── Move connections ────────────────────────────────────────────────────
  const startEditMove = (c) => {
    setMoveEditingId(c.id);
    setMoveForm({ name: c.name, host: c.host, username: c.username || '', password: '', sslVerify: !!c.sslVerify });
  };
  const cancelEditMove = () => { setMoveEditingId(null); setMoveForm({ name: '', host: '', username: '', password: '', sslVerify: false }); };

  const saveMove = async () => {
    setMoveSaving(true);
    try {
      const body = { name: moveForm.name.trim(), host: moveForm.host.trim(), username: moveForm.username.trim(), sslVerify: moveForm.sslVerify };
      if (moveEditingId) {
        if (moveForm.password) body.password = moveForm.password;
        await client.put(`/nutanix/move/connections/${moveEditingId}`, body);
        toast({ type: 'success', title: 'Move appliance updated' });
      } else {
        body.password = moveForm.password;
        await client.post('/nutanix/move/connections', body);
        toast({ type: 'success', title: 'Move appliance registered' });
      }
      cancelEditMove();
      await loadMoveConns();
    } catch (err) {
      toast({ type: 'error', title: moveEditingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setMoveSaving(false);
    }
  };

  const deleteMove = async (c) => {
    if (!window.confirm(`Remove Move appliance "${c.name}"?`)) return;
    try {
      await client.delete(`/nutanix/move/connections/${c.id}`);
      await loadMoveConns();
      toast({ type: 'success', title: `Removed ${c.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const pollMove = async (c) => {
    setMovePollingId(c.id);
    try {
      await client.post(`/nutanix/move/connections/${c.id}/poll`, {}, { timeout: 300000 });
      await loadMoveConns();
      toast({ type: 'success', title: `${c.name} polled` });
    } catch (err) {
      toast({ type: 'error', title: `Poll failed for ${c.name}`, message: err?.response?.data?.error });
    } finally {
      setMovePollingId(null);
    }
  };

  const canSubmitMove = moveForm.name.trim() && moveForm.host.trim() && moveForm.username.trim() && (moveEditingId || moveForm.password);

  // ── Alert thresholds ─────────────────────────────────────────────────────
  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const { data } = await client.put('/nutanix/config', {
        containerWarnPct: Number(config.containerWarnPct), containerCritPct: Number(config.containerCritPct),
        clusterWarnPct: Number(config.clusterWarnPct), clusterCritPct: Number(config.clusterCritPct),
        rpoGracePct: Number(config.rpoGracePct), runwayWarnDays: Number(config.runwayWarnDays),
      });
      setConfig(data);
      toast({ type: 'success', title: 'Thresholds saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="Nutanix Settings" description="Register Prism Central / Prism Element sources and Move appliances" />

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <nav className="w-full md:w-48 shrink-0 flex flex-row md:flex-col flex-wrap gap-x-6" aria-label="Nutanix settings sections">
          {['Connections', 'Tuning'].map((g) => (
            <div key={g} className="flex flex-col gap-0.5 min-w-[10rem] mb-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint px-2 mb-1">{g}</p>
              {SECTIONS.filter((s) => s.group === g).map((s) => {
                const Icon = s.icon;
                const active = section === s.key;
                return (
                  <button key={s.key} onClick={() => setSection(s.key)} aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] font-medium text-left transition-colors duration-150 cursor-pointer ${
                      active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
                    }`}>
                    <Icon size={13} className={active ? 'text-brand' : ''} /> {s.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0 max-w-3xl">
      {section === 'sources' && (<>
      {/* ── Prism source tabs ── */}
      <div className="flex items-center gap-1 mb-3">
        {TABS.map(t => (
          <button key={t.key} onClick={() => switchTab(t.key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold cursor-pointer transition-colors ${tab === t.key ? 'bg-brand/10 text-brand border border-brand/30' : 'text-ink-muted border border-transparent hover:text-ink'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          <Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'source'}` : `Add a ${TABS.find(t => t.key === tab)?.label}`}
        </p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          A read-only Prism account is sufficient for inventory. The password is encrypted at rest.
        </p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={setF('name')} placeholder="Prod Prism Central" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Host / IP</label>
            <input value={form.host} onChange={setF('host')} placeholder="prism.company.com" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Port</label>
            <input type="number" value={form.port} onChange={setF('port')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={setF('pollingIntervalMinutes')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Username</label>
            <input value={form.username} onChange={setF('username')} placeholder="monitor" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Password{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
            <input type="password" value={form.password} onChange={setF('password')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
          </div>
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.sslVerify} onChange={setF('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={saveSource} disabled={saving || !canSubmitSource} className={btnPrimary}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add source'}
          </button>
          {editingId && <button onClick={cancelEditSource} className={btnGhost}>Cancel</button>}
          <button onClick={testSource} disabled={testing || !form.host.trim() || !form.username.trim()}
            className={`${btnGhost} hover:border-brand/40 inline-flex items-center gap-2`}>
            {testing && <Spinner size={13} />} Test connection
          </button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok ? `Connected${testResult.productVersion ? ` — ${testResult.apiFlavor || ''} ${testResult.productVersion}` : ''}` : testResult.error}
            </span>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Registered {TABS.find(t => t.key === tab)?.label} Sources</p>
        {sources == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : (
          <SourceTable sources={tabSources} onEdit={startEditSource} onDelete={deleteSource} onPoll={pollSource}
            pollingId={pollingId} />
        )}
      </div>
      </>)}

      {/* ── Move ── */}
      {section === 'move' && (
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ArrowRightLeft size={15} className="text-brand" /> Move Appliances</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">Migration appliances polled independently of Prism sources.</p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={moveForm.name} onChange={setMoveF('name')} placeholder="Move Appliance" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Host / IP</label>
            <input value={moveForm.host} onChange={setMoveF('host')} className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Username</label>
            <input value={moveForm.username} onChange={setMoveF('username')} placeholder="admin" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Password{moveEditingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
            <input type="password" value={moveForm.password} onChange={setMoveF('password')} placeholder={moveEditingId ? '•••••• (stored)' : ''} className={inp} />
          </div>
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={moveForm.sslVerify} onChange={setMoveF('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate</span>
          </label>
        </div>
        <div className="flex items-center gap-2 mb-4">
          <button onClick={saveMove} disabled={moveSaving || !canSubmitMove} className={btnPrimary}>
            {moveSaving ? 'Saving…' : moveEditingId ? 'Save changes' : 'Add Move appliance'}
          </button>
          {moveEditingId && <button onClick={cancelEditMove} className={btnGhost}>Cancel</button>}
        </div>
        {moveConns == null ? (
          <LoadingPanel label="Loading…" height={80} />
        ) : moveConns.length === 0 ? (
          <div className="text-sm text-ink-muted py-4 text-center">None registered.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Host</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3 text-right">Plans</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {moveConns.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.name}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{c.host}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={c.lastPollStatus === 'error' ? 'crit' : c.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {c.lastPollStatus === 'error' ? 'Unreachable' : c.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.planCount ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => startEditMove(c)} className={iconBtn}><Pencil size={13} /></button>
                        <button onClick={() => pollMove(c)} disabled={movePollingId === c.id} className={iconBtn}>
                          <RefreshCw size={13} className={movePollingId === c.id ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => deleteMove(c)}
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
      </div>
      )}

      {/* ── Alert thresholds ── */}
      {section === 'thresholds' && (
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">Container/cluster storage warning and critical levels, RPO grace percentage, and capacity-runway warning window.</p>
        {config == null ? (
          <LoadingPanel label="Loading…" height={80} />
        ) : (
          <>
            <div className="grid md:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Container warn %</label>
                <input type="number" min={1} max={100} value={config.containerWarnPct}
                  onChange={(e) => setConfig(c => ({ ...c, containerWarnPct: e.target.value }))} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Container critical %</label>
                <input type="number" min={1} max={100} value={config.containerCritPct}
                  onChange={(e) => setConfig(c => ({ ...c, containerCritPct: e.target.value }))} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Runway warning (days)</label>
                <input type="number" min={1} max={365} value={config.runwayWarnDays}
                  onChange={(e) => setConfig(c => ({ ...c, runwayWarnDays: e.target.value }))} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Cluster warn %</label>
                <input type="number" min={1} max={100} value={config.clusterWarnPct}
                  onChange={(e) => setConfig(c => ({ ...c, clusterWarnPct: e.target.value }))} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Cluster critical %</label>
                <input type="number" min={1} max={100} value={config.clusterCritPct}
                  onChange={(e) => setConfig(c => ({ ...c, clusterCritPct: e.target.value }))} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">RPO grace %</label>
                <input type="number" min={0} max={200} value={config.rpoGracePct}
                  onChange={(e) => setConfig(c => ({ ...c, rpoGracePct: e.target.value }))} className={inp} />
              </div>
            </div>
            <button onClick={saveConfig} disabled={savingConfig} className={btnPrimary}>
              {savingConfig ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
      )}

      <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
        The Nutanix platform tab itself is enabled from Global Settings (gear icon → Platforms).
      </p>
        </div>
      </div>
    </div>
  );
}
