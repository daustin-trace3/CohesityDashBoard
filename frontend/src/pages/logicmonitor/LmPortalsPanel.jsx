import { useState } from 'react';
import {
  Network, CheckCircle2, XCircle, Trash2, RefreshCw, Pencil, Stethoscope, Cable, Eye, EyeOff,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { fmtWhen, pollStatusMeta } from './helpers';
import LmWebhookPanel from './LmWebhookPanel';
import { SectionPanel, Modal, inp, btnPrimary, btnGhost, iconBtn, headRow } from './ui';

const blankForm = () => ({
  name: '', company: '', authMode: 'lmv1', accessId: '', accessKey: '', token: '', verifySsl: true,
  pollingIntervalMinutes: 5, interfacePollMinutes: 15,
});

// "https://acme.logicmonitor.com/santaba" -> "acme" (the route normalises too).
const normCompany = (v) => String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\.logicmonitor\.com.*$/i, '').replace(/\/.*$/, '');

function SecretInput({ value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? 'text' : 'password'} value={value} onChange={onChange} placeholder={placeholder} className={`${inp} pr-9`} autoComplete="new-password" spellCheck={false} />
      <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide' : 'Show'}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink cursor-pointer">{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
    </div>
  );
}

function Generic({ value }) {
  if (value == null || (typeof value === 'object' && Object.keys(value).length === 0)) return <span className="text-ink-faint">none</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {Object.entries(value).map(([k, v]) => (
        <span key={k} className="font-mono text-[10px] break-all"><span className="text-ink-faint">{k}:</span> {typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
      ))}
    </div>
  );
}

function ProbeModal({ probe, onClose }) {
  const [openKey, setOpenKey] = useState(null);
  const sections = probe.data?.sections || {};
  return (
    <Modal icon={Stethoscope} title={`Probe - ${probe.name}`} subtitle="Raw API shapes from the portal, for first-connect debugging" onClose={onClose} width="max-w-5xl">
      {probe.loading ? <LoadingPanel label="Probing the LogicMonitor API..." height={120} />
        : probe.error ? <p className="text-sm text-status-crit">{probe.error}</p>
        : (
          <div className="flex flex-col gap-2">
            {Object.entries(sections).map(([name, s]) => (
              <div key={name} className="rounded-lg border border-cohesity-border">
                <button type="button" onClick={() => setOpenKey(openKey === name ? null : name)} className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-surface-overlay/60">
                  {s?.ok ? <CheckCircle2 size={14} className="text-status-ok shrink-0" /> : <XCircle size={14} className="text-status-crit shrink-0" />}
                  <span className="text-xs font-semibold text-ink">{name}</span>
                  {s?.count != null && <span className="text-[11px] text-ink-faint tnum">count {s.count}</span>}
                  {s?.error && <span className="text-[11px] text-status-crit truncate">{s.error}</span>}
                  <span className="ml-auto text-[10px] text-ink-faint">{openKey === name ? 'Hide' : 'Raw sample'}</span>
                </button>
                {openKey === name && (
                  <pre className="text-[11px] text-ink-muted overflow-auto max-h-80 whitespace-pre-wrap border-t border-cohesity-border p-3">{JSON.stringify(s?.sample ?? s, null, 2)}</pre>
                )}
              </div>
            ))}
            {probe.data?.source?.features && (
              <div className="mt-2">
                <p className="text-[11px] font-semibold text-ink mb-1">Features recorded</p>
                <Generic value={probe.data.source.features} />
              </div>
            )}
          </div>
        )}
    </Modal>
  );
}

export default function LmPortalsPanel({ sources, reload }) {
  const { toast } = useToast();
  const [form, setForm] = useState(blankForm());
  const [editing, setEditing] = useState(null); // source row
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState(null); // `${id}:poll` | `${id}:ifpoll`
  const [probe, setProbe] = useState(null);

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const company = normCompany(form.company);
  const secretTyped = form.authMode === 'lmv1' ? !!form.accessKey : !!form.token;
  const companyChanged = editing && company !== editing.company;
  const modeChanged = editing && form.authMode !== editing.authMode;
  const needsSecret = !editing || companyChanged || modeChanged;

  const startEdit = (s) => {
    setEditing(s);
    setForm({
      name: s.name, company: s.company, authMode: s.authMode || 'lmv1', accessId: '', accessKey: '', token: '',
      verifySsl: s.verifySsl !== false && s.verifySsl !== 0, pollingIntervalMinutes: s.pollingIntervalMinutes || 5,
      interfacePollMinutes: s.interfacePollMinutes || 15,
    });
    setTestResult(null);
  };
  const cancelEdit = () => { setEditing(null); setForm(blankForm()); setTestResult(null); };

  const credBody = () => {
    const b = {};
    if (form.authMode === 'lmv1') {
      if (form.accessId.trim()) b.accessId = form.accessId.trim();
      if (form.accessKey) b.accessKey = form.accessKey;
    } else if (form.token) b.token = form.token;
    return b;
  };

  // Secret only when typed. A blank secret tests the SAVED row, and the
  // route ignores the body company in that case.
  const testSource = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body = { company, authMode: form.authMode, verifySsl: !!form.verifySsl, ...credBody() };
      const { data } = await client.post(`/logicmonitor/sources/${editing ? editing.id : 0}/test`, body, { timeout: 60000 });
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, message: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const saveSource = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), company, authMode: form.authMode, verifySsl: !!form.verifySsl,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 5,
        interfacePollMinutes: Number(form.interfacePollMinutes) || 15,
        ...credBody(),
      };
      if (editing) {
        await client.put(`/logicmonitor/sources/${editing.id}`, body);
        toast({ type: 'success', title: 'Portal updated', message: secretTyped ? 'New credentials saved.' : 'Saved. Stored credentials unchanged.' });
      } else {
        await client.post('/logicmonitor/sources', body);
        toast({ type: 'success', title: 'Portal connected', message: 'First poll started. Data appears shortly.' });
      }
      cancelEdit();
      await reload();
    } catch (err) {
      toast({ type: 'error', title: editing ? 'Update failed' : 'Connect failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const deleteSource = async (s) => {
    if (!window.confirm(`Remove LogicMonitor portal "${s.name}"? Its collected inventory and history are deleted.`)) return;
    try {
      await client.delete(`/logicmonitor/sources/${s.id}`);
      if (editing?.id === s.id) cancelEdit();
      await reload();
      toast({ type: 'success', title: `Removed ${s.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const trigger = async (s, kind) => {
    setBusy(`${s.id}:${kind}`);
    try {
      await client.post(`/logicmonitor/sources/${s.id}/${kind === 'ifpoll' ? 'poll-interfaces' : 'poll'}`, {}, { timeout: 30000 });
      toast({ type: 'success', title: `${s.name}: ${kind === 'ifpoll' ? 'interface poll' : 'poll'} triggered`, message: 'Runs in the background; refresh in a minute.' });
      await reload();
    } catch (err) {
      toast({ type: 'error', title: 'Trigger failed', message: err?.response?.data?.error });
    } finally {
      setBusy(null);
    }
  };

  const probeSource = async (s) => {
    setProbe({ loading: true, name: s.name });
    try {
      const { data } = await client.get(`/logicmonitor/sources/${s.id}/probe`, { timeout: 180000 });
      setProbe({ name: s.name, data });
      reload();
    } catch (err) {
      setProbe({ name: s.name, error: err?.response?.data?.error || 'Probe failed.' });
    }
  };

  const credsComplete = form.authMode === 'lmv1' ? (form.accessId.trim() && form.accessKey) : form.token;
  const canSubmit = form.name.trim() && /^[a-z0-9][a-z0-9-]{1,62}$/i.test(company) && (needsSecret ? (editing ? secretTyped : credsComplete) : true);
  const canTest = /^[a-z0-9][a-z0-9-]{1,62}$/i.test(company) && (editing || credsComplete);
  const storedHint = editing ? ' (stored, leave blank to keep)' : '';

  return (
    <>
      <SectionPanel icon={Network} title={editing ? `Edit - ${editing.name}` : 'Connect a LogicMonitor portal'}
        blurb="Create an API-only user in LogicMonitor (Settings > Users and Roles) with a read-only role, then generate an LMv1 access id and key or a bearer token for it. Credentials are encrypted at rest and only ever sent to the portal they were saved for.">
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={setF('name')} placeholder="Acme Network Ops" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Company (portal subdomain)</label>
            <div className="flex items-center gap-1">
              <input value={form.company} onChange={setF('company')} placeholder="acme" className={inp} spellCheck={false} />
              <span className="text-[11px] text-ink-faint whitespace-nowrap">.logicmonitor.com</span>
            </div>
            {companyChanged && <p className="text-[10px] text-status-warn mt-1">Changing the portal needs the secret typed again.</p>}
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Authentication</label>
            <div className="flex items-center gap-4 h-[38px]">
              {[['lmv1', 'LMv1 access id + key'], ['bearer', 'Bearer token']].map(([v, l]) => (
                <label key={v} className="flex items-center gap-1.5 text-xs text-ink cursor-pointer">
                  <input type="radio" name="lm-auth" value={v} checked={form.authMode === v} onChange={setF('authMode')} /> {l}
                </label>
              ))}
            </div>
          </div>
          {form.authMode === 'lmv1' ? (
            <>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Access id<span className="font-normal text-ink-faint">{storedHint}</span></label>
                <input value={form.accessId} onChange={setF('accessId')} placeholder={editing ? '(stored)' : ''} className={inp} spellCheck={false} autoComplete="off" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Access key<span className="font-normal text-ink-faint">{storedHint}</span></label>
                <SecretInput value={form.accessKey} onChange={setF('accessKey')} placeholder={editing ? '(stored)' : ''} />
              </div>
            </>
          ) : (
            <div className="xl:col-span-2">
              <label className="block text-xs font-semibold text-ink mb-1">Bearer token<span className="font-normal text-ink-faint">{storedHint}</span></label>
              <SecretInput value={form.token} onChange={setF('token')} placeholder={editing ? '(stored)' : ''} />
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={setF('pollingIntervalMinutes')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Interface poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.interfacePollMinutes} onChange={setF('interfacePollMinutes')} className={inp} />
          </div>
          <label className="flex items-center gap-2 text-xs text-ink cursor-pointer self-end h-[38px]">
            <input type="checkbox" checked={!!form.verifySsl} onChange={setF('verifySsl')} /> Verify TLS certificate
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={saveSource} disabled={saving || !canSubmit} className={btnPrimary}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Connect portal'}</button>
          {editing && <button onClick={cancelEdit} className={btnGhost}>Cancel</button>}
          <button onClick={testSource} disabled={testing || !canTest} className={`${btnGhost} inline-flex items-center gap-2`}>{testing && <Spinner size={13} />} Test connection</button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok
                ? `${testResult.message || 'Connected'}${testResult.details?.deviceCount != null ? ` - ${testResult.details.deviceCount} device(s)` : ''}${testResult.details?.version ? ` - API ${testResult.details.version}` : ''}`
                : (testResult.message || testResult.error || 'Connection failed')}
            </span>
          )}
        </div>
        {editing && !secretTyped && <p className="text-[11px] text-ink-faint mt-2">With the secret blank, Test connection checks the saved portal and credentials.</p>}
      </SectionPanel>

      <SectionPanel icon={Network} title="Connected portals">
        {sources == null ? <LoadingPanel label="Loading..." height={100} /> : sources.length === 0 ? (
          <p className="text-sm text-ink-muted py-6 text-center">No LogicMonitor portals connected.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Portal</th><th className="py-2 pr-3">Auth</th>
                <th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Last poll</th><th className="py-2 pr-3">Rate limit</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {sources.map((s) => {
                  const m = pollStatusMeta(s.lastPollStatus);
                  return (
                    <tr key={s.id} className="border-b border-cohesity-border/50 align-top">
                      <td className="py-2 pr-3 text-ink whitespace-nowrap">{s.name}{!s.enabled ? <Badge tone="neutral" className="ml-1">Disabled</Badge> : null}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] whitespace-nowrap">{String(s.baseUrl || '').replace(/^https?:\/\//, '')}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{s.authMode === 'bearer' ? 'Bearer' : 'LMv1'}</td>
                      <td className="py-2 pr-3 max-w-[320px]">
                        <Badge tone={m.tone}>{m.label}</Badge>
                        {s.lastPollError && <p className={`text-[10px] mt-0.5 whitespace-pre-wrap break-words ${s.lastPollStatus === 'error' ? 'text-status-crit' : 'text-status-warn'}`}>{s.lastPollError}</p>}
                        {s.sectionErrors && Object.keys(s.sectionErrors).length > 0 && <div className="mt-1 text-status-warn"><Generic value={s.sectionErrors} /></div>}
                        {s.lastInterfacePollError && <p className="text-[10px] text-status-warn mt-0.5">Interfaces: {s.lastInterfacePollError}</p>}
                      </td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">
                        {fmtWhen(s.lastPollAt)}
                        <p>Interfaces: {fmtWhen(s.lastInterfacePollAt)}</p>
                      </td>
                      <td className="py-2 pr-3 text-[11px] text-ink-muted max-w-[220px]"><Generic value={s.rateLimit} /></td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <button onClick={() => startEdit(s)} title="Edit connection" aria-label={`Edit ${s.name}`} className={iconBtn}><Pencil size={13} /></button>
                          <button onClick={() => trigger(s, 'poll')} disabled={busy === `${s.id}:poll`} title="Poll now" aria-label={`Poll ${s.name} now`} className={iconBtn}>
                            <RefreshCw size={13} className={busy === `${s.id}:poll` ? 'animate-spin' : ''} />
                          </button>
                          <button onClick={() => trigger(s, 'ifpoll')} disabled={busy === `${s.id}:ifpoll`} title="Poll interfaces now" aria-label={`Poll ${s.name} interfaces now`} className={iconBtn}>
                            <Cable size={13} className={busy === `${s.id}:ifpoll` ? 'animate-pulse' : ''} />
                          </button>
                          <button onClick={() => probeSource(s)} title="Probe raw API shapes (first-connect debug)" aria-label={`Probe ${s.name}`} className={iconBtn}><Stethoscope size={13} /></button>
                          <button onClick={() => deleteSource(s)} title="Remove" aria-label={`Remove ${s.name}`}
                            className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-status-crit hover:border-status-crit/50 transition-colors cursor-pointer">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <LmWebhookPanel sources={sources} />

      {probe && <ProbeModal probe={probe} onClose={() => setProbe(null)} />}
    </>
  );
}
