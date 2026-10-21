import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Eye, X, Plus, Trash2, RotateCcw } from 'lucide-react';
import client from '../api/client';
import { useToast } from './ui/Toaster';
import { SettingRow, SettingGroup, InfoTip, TabSaveBar, inputCls, numberCls } from './settings/SettingRow';

// Global Settings > Intelligence > Platform profiles: the short focus text the
// Operations Agent adds to its prompt for each platform in an incident, and
// the port map it probes for that platform. Defaults ship with ICC; anything
// edited here is stored per tenant and wins over the default.

const MAX_LIST = 12;
const SOURCE_TABLES = [
  { group: 'ports', key: 'source', title: 'Polled source' },
  { group: 'ports', key: 'host', title: 'Hosts and devices' },
];
const GUEST_TABLES = [
  { group: 'guestPorts', key: 'windows', title: 'Windows guests' },
  { group: 'guestPorts', key: 'linux', title: 'Linux guests' },
  { group: 'guestPorts', key: 'other', title: 'Other guests' },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

function portError(rows) {
  if (rows.length > MAX_LIST) return `At most ${MAX_LIST} ports per table.`;
  const seen = new Set();
  for (const r of rows) {
    const n = Number(r.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Ports must be whole numbers from 1 to 65535.';
    if (String(r.label || '').length > 40) return 'Labels are 40 characters at most.';
    if (seen.has(n)) return `Port ${n} is listed twice.`;
    seen.add(n);
  }
  return null;
}

function PortTable({ title, rows, onChange, onReset, isDefault, error }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="py-3 border-b border-cohesity-border/50 last:border-b-0">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-xs font-semibold text-ink">{title}</span>
        {!isDefault && <span className="text-[10px] text-amber-400">custom</span>}
        <button type="button" onClick={onReset} disabled={isDefault}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 border border-cohesity-border text-ink-muted rounded-md hover:text-ink hover:border-brand/40 disabled:opacity-40 cursor-pointer">
          <RotateCcw size={11} /> Reset to default
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-ink-faint mb-2">No ports. The agent runs no port check for this kind of target.</p>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-ink-faint border-b border-cohesity-border">
              <th className="py-1 pr-2 w-24">Port</th>
              <th className="py-1 pr-2">Label</th>
              <th className="py-1 pr-2 w-44">Must be reachable from ICC</th>
              <th className="py-1 w-16">Remove</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-cohesity-border/40 last:border-0">
                <td className="py-1 pr-2">
                  <input type="number" min={1} max={65535} value={r.port} aria-label="Port"
                    onChange={(e) => set(i, { port: e.target.value === '' ? '' : Number(e.target.value) })} className={numberCls} />
                </td>
                <td className="py-1 pr-2">
                  <input type="text" value={r.label || ''} maxLength={60} aria-label="Label"
                    onChange={(e) => set(i, { label: e.target.value })} className={inputCls} />
                </td>
                <td className="py-1 pr-2">
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={!!r.expect} onChange={(e) => set(i, { expect: e.target.checked })} className="accent-brand cursor-pointer" />
                    <span className="text-ink-muted">{r.expect ? 'Yes, closed is evidence' : 'No, informational'}</span>
                  </label>
                </td>
                <td className="py-1">
                  <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove port ${r.port}`}
                    className="p-1.5 text-ink-muted hover:text-status-crit cursor-pointer"><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <button type="button" disabled={rows.length >= MAX_LIST} onClick={() => onChange([...rows, { port: '', label: '', expect: true }])}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 border border-cohesity-border text-ink-muted rounded-md hover:text-ink hover:border-brand/40 disabled:opacity-40 cursor-pointer">
          <Plus size={12} /> Add port
        </button>
        {error && <span className="text-[11px] text-status-crit">{error}</span>}
      </div>
    </div>
  );
}

function PreviewModal({ onClose }) {
  const [incidentId, setIncidentId] = useState('');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    client.get('/ops-agent/incidents', { params: { state: 'all', limit: 50 } })
      .then(({ data }) => {
        const ids = (Array.isArray(data) ? data : []).map((i) => Number(i.id)).filter(Number.isFinite);
        if (alive && ids.length) setIncidentId(String(Math.max(...ids)));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const { data } = await client.get('/ops-agent/prompt-preview', { params: { incidentId } });
      setResult(data);
    } catch (e) {
      setErr(e?.response?.status === 404 ? 'No incident with that id.' : (e?.response?.data?.error || 'Could not build the preview.'));
    } finally { setBusy(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel flex flex-col border-t-2 border-brand w-full max-w-3xl max-h-[88vh]">
        <div className="p-4 pb-3 border-b border-cohesity-border flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Eye size={17} className="text-brand" />
            <div>
              <p className="text-[15px] font-semibold text-ink">Prompt preview</p>
              <p className="text-[11px] text-ink-faint">Builds the system prompt for a stored incident. No model call, no probes.</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay cursor-pointer"><X size={15} /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="prof-prev-id" className="text-xs font-semibold text-ink">Incident id</label>
            <input id="prof-prev-id" type="number" min={1} value={incidentId} onChange={(e) => setIncidentId(e.target.value)} className={numberCls} />
            <button onClick={run} disabled={busy || !incidentId}
              className="text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 disabled:opacity-50 cursor-pointer">
              {busy ? 'Building...' : 'Preview'}
            </button>
          </div>
          {err && <p className="mt-3 text-[11px] text-red-400 bg-red-400/10 border border-red-400/30 rounded-md px-2.5 py-1.5">{err}</p>}
          {result && (
            <div className="mt-4">
              <div className="flex gap-4 flex-wrap text-[11px] text-ink-muted mb-3">
                <span><span className="text-ink font-semibold tnum">{result.chars}</span> characters</span>
                <span>about <span className="text-ink font-semibold tnum">{result.approxTokens}</span> tokens</span>
                {result.evidenceChars != null && <span><span className="text-ink font-semibold tnum">{result.evidenceChars}</span> characters of evidence</span>}
                <span>Platform notes from: <span className="text-ink font-semibold">{(result.focusUsed || []).join(', ') || 'none'}</span></span>
              </div>
              {(result.relations || []).length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint pb-1 border-b border-cohesity-border/60">How these systems connect</p>
                  <ul className="mt-1.5 space-y-1 text-[11px] text-ink-muted list-disc pl-4">
                    {result.relations.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint pb-1 border-b border-cohesity-border/60">System text</p>
              <pre className="mt-1.5 text-[11px] text-ink-muted font-mono whitespace-pre-wrap break-words max-h-[45vh] overflow-y-auto rounded-lg border border-cohesity-border bg-surface-overlay/40 p-3">{result.system}</pre>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function AgentProfilesPanel() {
  const [data, setData] = useState(null);
  const [maxFocus, setMaxFocus] = useState(600);
  const [sel, setSel] = useState(null);
  // pending[id][field] = value, or null meaning "reset this field to default"
  const [pending, setPending] = useState({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(null);
  const [saveErr, setSaveErr] = useState(null);
  const [preview, setPreview] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const { data: d } = await client.get('/ops-agent/profiles');
      setData(d.profiles || []);
      if (d.maxFocus) setMaxFocus(d.maxFocus);
      setPending({});
      setFailed(null);
      setSaveErr(null);
      setSel((cur) => cur || d.profiles?.[0]?.id || null);
    } catch (e) {
      setFailed(e?.response?.data?.error || 'Could not load the platform profiles.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const profile = useMemo(() => (data || []).find((p) => p.id === sel) || null, [data, sel]);

  const val = (p, field) => {
    const pv = pending[p.id]?.[field];
    if (pv === undefined) return p[field];
    if (pv === null) return p[field + 'Default'];
    return pv;
  };
  const isCustom = (p, field) => {
    const pv = pending[p.id]?.[field];
    if (pv === undefined) return p[field + 'Source'] === 'custom';
    if (pv === null) return false;
    return !same(pv, p[field + 'Default']);
  };
  const setField = (p, field, v) => {
    // A value equal to the default is sent as a reset, so the override is removed.
    const next = same(v, p[field + 'Default']) ? null : v;
    setPending((cur) => {
      const mine = { ...(cur[p.id] || {}) };
      if (next === null && p[field + 'Source'] !== 'custom') delete mine[field];
      else mine[field] = next;
      const out = { ...cur };
      if (Object.keys(mine).length) out[p.id] = mine; else delete out[p.id];
      return out;
    });
  };

  const tableRows = (p, t) => (val(p, t.group) || {})[t.key] || [];
  const setTable = (p, t, rows) => {
    const base = clone(val(p, t.group)) || {};
    base[t.key] = rows;
    setField(p, t.group, base);
  };

  const errors = useMemo(() => {
    const out = {};
    for (const p of data || []) {
      for (const t of [...SOURCE_TABLES, ...(p.guestPorts ? GUEST_TABLES : [])]) {
        if (pending[p.id]?.[t.group] === undefined) continue;
        const e = portError(tableRows(p, t));
        if (e) out[`${p.id}.${t.group}.${t.key}`] = e;
      }
      if (pending[p.id]?.focus != null && pending[p.id].focus.length > maxFocus) out[`${p.id}.focus`] = `Focus text is ${maxFocus} characters at most.`;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, data, maxFocus]);

  const dirty = Object.keys(pending).length > 0;
  const blocked = Object.keys(errors).length > 0;

  const save = async () => {
    setSaving(true); setSaveErr(null);
    try {
      const body = {};
      for (const [id, fields] of Object.entries(pending)) {
        body[id] = {};
        for (const [f, v] of Object.entries(fields)) {
          body[id][f] = v === null ? null : (f === 'focus' ? v : cleanPorts(v));
        }
      }
      await client.put('/settings', { opsAgent: { platformProfiles: body } });
      toast({ type: 'success', title: 'Platform profiles saved', message: 'The agent uses them at its next triage.' });
      await load();
    } catch (e) {
      const d = e?.response?.data;
      const msg = d?.error || 'Could not save. Try again.';
      setSaveErr(d?.field ? `${msg} (${d.field})` : msg);
      toast({ type: 'error', title: 'Save failed', message: d?.field ? `${msg} (${d.field})` : msg });
    } finally { setSaving(false); }
  };

  const cleanPorts = (obj) => {
    const out = {};
    for (const [k, rows] of Object.entries(obj || {})) {
      out[k] = (rows || []).map((r) => ({ port: Number(r.port), label: String(r.label || '').trim(), expect: !!r.expect }));
    }
    return out;
  };

  return (
    <>
      <div className="panel p-4">
        <div className="flex items-start gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20 shrink-0">
            <Layers size={14} className="text-brand" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-ink">Platform profiles</p>
            <p className="text-[11px] text-ink-muted">
              A short focus text and a port map for each platform. The agent adds a platform's focus text to its prompt only
              when that platform is in the incident (three platforms at most), and checks the listed ports on the hosts and
              sources already in the incident. The profile never adds a target.
            </p>
          </div>
          <button onClick={() => setPreview(true)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors cursor-pointer shrink-0">
            <Eye size={12} /> Prompt preview
          </button>
        </div>
        {failed && <p className="mt-3 text-[11px] text-red-400 bg-red-400/10 border border-red-400/30 rounded-md px-2.5 py-1.5">{failed}</p>}
        {!data ? (
          !failed && <p className="text-gray-400 text-sm mt-4">Loading...</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-[14rem_minmax(0,1fr)] gap-6 mt-4">
            <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible" aria-label="Platforms">
              {data.map((p) => {
                const custom = ['focus', 'ports', 'guestPorts'].some((f) => p[f] !== undefined && isCustom(p, f));
                const edited = !!pending[p.id];
                return (
                  <button key={p.id} type="button" onClick={() => setSel(p.id)}
                    className={`flex items-center gap-2 text-left text-xs px-2.5 py-2 rounded-lg border cursor-pointer whitespace-nowrap ${sel === p.id ? 'border-brand/40 bg-brand/10 text-ink' : 'border-transparent text-ink-muted hover:text-ink hover:bg-surface-overlay'}`}>
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: p.color || '#64748b' }} />
                    <span className="flex-1 truncate">{p.name || p.id}</span>
                    {custom && <span className="text-[10px] text-brand border border-brand/30 rounded px-1">custom</span>}
                    {edited && <span className="text-[10px] text-amber-400">unsaved</span>}
                  </button>
                );
              })}
            </nav>

            {profile && (
              <div className="min-w-0">
                <SettingGroup title="Focus text">
                  <SettingRow label="Focus" htmlFor="prof-focus" dirty={pending[profile.id]?.focus !== undefined}
                    tip="Sent to the model as 'Platform notes, <name>' only when this platform has alerts in the incident. Keep it short: it is added to every triage that involves the platform.">
                    <textarea id="prof-focus" rows={7} value={val(profile, 'focus') || ''}
                      onChange={(e) => setField(profile, 'focus', e.target.value)} className={`${inputCls} font-mono leading-relaxed`} />
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className={`text-[11px] tnum ${(val(profile, 'focus') || '').length > maxFocus ? 'text-status-crit' : 'text-ink-faint'}`}>
                        {(val(profile, 'focus') || '').length} / {maxFocus}
                      </span>
                      {isCustom(profile, 'focus') && (
                        <>
                          <span className="text-[11px] text-ink-faint">Default text exists.</span>
                          <button type="button" onClick={() => setPending((c) => ({ ...c, [profile.id]: { ...(c[profile.id] || {}), focus: null } }))}
                            className="flex items-center gap-1 text-[11px] px-2 py-1 border border-cohesity-border text-ink-muted rounded-md hover:text-ink hover:border-brand/40 cursor-pointer">
                            <RotateCcw size={11} /> Reset to default
                          </button>
                        </>
                      )}
                      {errors[`${profile.id}.focus`] && <span className="text-[11px] text-status-crit">{errors[`${profile.id}.focus`]}</span>}
                    </div>
                  </SettingRow>
                </SettingGroup>

                <SettingGroup title="Ports">
                  <div>
                    <p className="text-[11px] text-ink-faint pt-2">
                      Tried from the ICC server with a plain TCP connect. A port marked as must be reachable counts against the
                      target when it is closed; the others are reported for information.
                    </p>
                    {SOURCE_TABLES.map((t) => {
                      const dflt = (profile.portsDefault || {})[t.key] || [];
                      const rows = tableRows(profile, t);
                      return (
                        <PortTable key={t.key} title={t.title} rows={rows} isDefault={same(rows, dflt)} error={errors[`${profile.id}.${t.group}.${t.key}`]}
                          onChange={(r) => setTable(profile, t, r)} onReset={() => setTable(profile, t, clone(dflt))} />
                      );
                    })}
                  </div>
                </SettingGroup>

                {profile.guestPorts && (
                  <SettingGroup title="Guest ports (virtual machines)">
                    <div>
                      <p className="text-[11px] text-ink-faint pt-2">Chosen by the guest operating system vCenter reports for the machine.</p>
                      {GUEST_TABLES.map((t) => {
                        const dflt = (profile.guestPortsDefault || {})[t.key] || [];
                        const rows = tableRows(profile, t);
                        return (
                          <PortTable key={t.key} title={t.title} rows={rows} isDefault={same(rows, dflt)} error={errors[`${profile.id}.${t.group}.${t.key}`]}
                            onChange={(r) => setTable(profile, t, r)} onReset={() => setTable(profile, t, clone(dflt))} />
                        );
                      })}
                    </div>
                  </SettingGroup>
                )}

                <SettingGroup title="Evidence budget">
                  <SettingRow label="Rows the model sees"
                    tip="Set by the platform, not editable here. The model sees at most this many rows of each kind for this platform, so one noisy platform cannot crowd out the rest.">
                    <div className="flex gap-2 flex-wrap md:pt-1.5">
                      {[['alerts', 'alerts'], ['failedBackupJobs', 'backup jobs'], ['networkBlocks', 'network blocks']].map(([k, l]) => (
                        profile.evidenceBudget?.[k] != null && (
                          <span key={k} className="text-[11px] px-2 py-1 rounded-md border border-cohesity-border bg-surface-overlay/40 text-ink-muted">
                            {l} <span className="text-ink font-semibold tnum">{profile.evidenceBudget[k]}</span>
                          </span>
                        )
                      ))}
                    </div>
                  </SettingRow>
                </SettingGroup>

                <SettingGroup title="Cross-platform links">
                  <SettingRow label="Links the agent can state"
                    tip="Sentences the agent can add to an incident when ICC holds the rows that connect this platform to another one. Read-only.">
                    {(profile.relations || []).length === 0 ? (
                      <p className="text-[11px] text-ink-faint md:pt-2">None for this platform.</p>
                    ) : (
                      <ul className="space-y-1 text-[11px] text-ink-muted list-disc pl-4 md:pt-2">
                        {profile.relations.map((r, i) => <li key={r.id || i}>{typeof r === 'string' ? r : (r.text || r.sentence || r.id)}</li>)}
                      </ul>
                    )}
                  </SettingRow>
                </SettingGroup>
              </div>
            )}
          </div>
        )}
        {data && (
          <TabSaveBar onSave={save} saving={saving} dirty={dirty && !blocked} label="Save profiles">
            {blocked && <span className="text-[11px] text-status-crit">Fix the marked fields to save.</span>}
            {saveErr && <span className="text-[11px] text-status-crit">{saveErr}</span>}
            {dirty && (
              <button type="button" onClick={() => { setPending({}); setSaveErr(null); }}
                className="text-[11px] px-2.5 py-1.5 border border-cohesity-border text-ink-muted rounded-md hover:text-ink hover:border-brand/40 cursor-pointer">Discard changes</button>
            )}
            <InfoTip label="profiles">Only the platforms you changed are sent. A value that matches the default removes your override.</InfoTip>
          </TabSaveBar>
        )}
      </div>
      {preview && <PreviewModal onClose={() => setPreview(false)} />}
    </>
  );
}
