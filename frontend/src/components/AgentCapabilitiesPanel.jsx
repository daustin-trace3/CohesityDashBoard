import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wrench, Save, RefreshCw } from 'lucide-react';
import client from '../api/client';
import { Badge, timeAgo } from './ui/primitives';
import { useToast } from './ui/Toaster';
import { useTableControls, TableControls, SortTh, TablePager } from './ui/tableTools';
import { SettingGroup, SettingRow, Toggle, selectCls, numberCls } from './settings/SettingRow';

const MODE_DEFAULT = 'playbook';
const MAX_CALLS_DEFAULT = 6;

// Global Settings > Agent Capabilities: what the Operations Agent may do
// beyond reading ICC's own tables. Each row is one capability the backend
// registered (built-in or from a pack); the toggle is per tenant and the
// table below is the audit trail of what it actually ran.
const RISK = {
  'read-only': { tone: 'neutral', label: 'read-only', hint: 'Reads data ICC already holds.' },
  'network-probe': { tone: 'warn', label: 'network probe', hint: 'Opens a connection from the ICC server to a host or source in the incident.' },
  'platform-api': { tone: 'info', label: 'platform API', hint: 'Makes an extra read call to the platform using its saved connection.' },
  action: { tone: 'crit', label: 'action', hint: 'Changes state: asks a poller or platform to do something.' },
};

export default function AgentCapabilitiesPanel() {
  const [caps, setCaps] = useState(null);
  const [pending, setPending] = useState({});
  const [runs, setRuns] = useState([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(null);
  const [mode, setMode] = useState(MODE_DEFAULT);
  const [maxCalls, setMaxCalls] = useState(MAX_CALLS_DEFAULT);
  const [deepPass, setDeepPass] = useState(true);
  const [savedMode, setSavedMode] = useState({ mode: MODE_DEFAULT, maxCalls: MAX_CALLS_DEFAULT, deepPass: true });
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const [{ data: c }, { data: r }, { data: s }] = await Promise.all([
        client.get('/ops-agent/capabilities'),
        client.get('/ops-agent/capability-runs', { params: { limit: 50 } }),
        client.get('/settings'),
      ]);
      const oa = s?.opsAgent || {};
      const m = oa.capabilityMode === 'tools' ? 'tools' : MODE_DEFAULT;
      const n = Number(oa.maxToolCalls);
      const mc = Number.isFinite(n) && n >= 1 ? Math.min(12, Math.round(n)) : MAX_CALLS_DEFAULT;
      setMode(m);
      setMaxCalls(mc);
      const dp = oa.deepPass !== false;
      setDeepPass(dp);
      setSavedMode({ mode: m, maxCalls: mc, deepPass: dp });
      setCaps(c.capabilities || []);
      setRuns(Array.isArray(r) ? r : []);
      setPending({});
      setFailed(null);
    } catch (e) {
      setFailed(e?.response?.data?.error || 'Could not load the capability list.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const runList = useMemo(() => runs.map((r) => ({ ...r, incidentLabel: r.incidentId ? '#' + r.incidentId : '', resultLabel: r.ok ? 'OK' : 'FAILED', requestedByLabel: r.requestedBy === 'model' ? 'Agent' : 'Playbook' })), [runs]);
  const ctl = useTableControls(runList, { searchKeys: ['capability', 'targetName', 'targetAddress', 'platform', 'summary', 'reason', 'incidentLabel'], defaultSortKey: 'ranAt', defaultSortDir: 'desc', paginate: true, defaultPageSize: 10 });

  const effective = (c) => (Object.prototype.hasOwnProperty.call(pending, c.id) ? pending[c.id] : c.enabled);
  const capsDirty = Object.keys(pending).some((id) => { const c = caps?.find((x) => x.id === id); return c && pending[id] !== c.enabled; });
  const modeDirty = mode !== savedMode.mode || (mode === 'tools' && maxCalls !== savedMode.maxCalls);
  const deepDirty = deepPass !== savedMode.deepPass;
  const dirty = capsDirty || modeDirty || deepDirty;
  const setAll = (v) => { const next = {}; for (const c of caps || []) next[c.id] = v; setPending(next); };

  const save = async () => {
    setSaving(true);
    try {
      const opsAgent = {};
      if (capsDirty) opsAgent.capabilities = pending;
      if (modeDirty) {
        opsAgent.capabilityMode = mode;
        if (mode === 'tools') opsAgent.maxToolCalls = maxCalls;
      }
      if (deepDirty) opsAgent.deepPass = deepPass;
      await client.put('/settings', { opsAgent });
      toast({ type: 'success', title: 'Capabilities saved', message: 'The agent uses the new set at its next triage.' });
      await load();
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const byRisk = (list) => [...list].sort((a, b) => Object.keys(RISK).indexOf(a.risk) - Object.keys(RISK).indexOf(b.risk) || a.label.localeCompare(b.label));

  return (
    <>
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Wrench size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Agent Capabilities</p>
            <p className="text-[11px] text-ink-muted">
              What the Operations Agent may do beyond reading ICC's own data. Every capability is off until it is switched on
              here, except the re-poll the agent has always done. Checks run from the ICC server, once per incident, right
              before triage, only against the hosts and sources already in that incident (the model picks from that list and
              never names a target of its own), and every run is listed below. A failed check means ICC could not reach the
              target from where it runs, which is not the same as the target being down.
            </p>
          </div>
        </div>
        {failed && <p className="mt-3 text-[11px] text-red-400 bg-red-400/10 border border-red-400/30 rounded-md px-2.5 py-1.5">{failed}</p>}
        {caps && (
          <div className="mt-4">
            <SettingGroup title="How the agent uses these checks">
              <SettingRow label="Mode" htmlFor="agent-cap-mode" dirty={mode !== savedMode.mode}
                tip="Playbook runs every enabled check against every target before triage. Agent decides offers the enabled checks to the model as tools; it calls the ones it needs and gives a reason for each.">
                <select id="agent-cap-mode" value={mode} onChange={(e) => setMode(e.target.value)} className={selectCls}>
                  <option value="playbook">Playbook: every enabled check runs against every target before triage</option>
                  <option value="tools">Agent decides: the model calls the checks it needs and gives a reason</option>
                </select>
              </SettingRow>
              {mode === 'tools' && (
                <SettingRow label="Most tool calls per triage" htmlFor="agent-cap-max" dirty={maxCalls !== savedMode.maxCalls}
                  tip="Upper limit on checks the model may request in one triage, 1 to 12. Each call adds a model round trip, so a higher limit means a slower triage. Default 6.">
                  <input id="agent-cap-max" type="number" min={1} max={12} value={maxCalls}
                    onChange={(e) => { const n = parseInt(e.target.value, 10); setMaxCalls(Number.isFinite(n) ? Math.max(1, Math.min(12, n)) : MAX_CALLS_DEFAULT); }}
                    className={numberCls} />
                </SettingRow>
              )}
              <SettingRow label="Second pass on critical or low-confidence incidents" htmlFor="agent-deep-pass" dirty={deepDirty}
                tip="Runs one more investigation with the deep-only checks and the first answer as context. Counts against the hourly triage budget. Never on a manual re-triage.">
                <Toggle id="agent-deep-pass" checked={deepPass} onChange={setDeepPass} />
              </SettingRow>
            </SettingGroup>
          </div>
        )}
        {!caps ? (
          <p className="text-gray-400 text-sm mt-4">Loading...</p>
        ) : (
          <div className="flex flex-col gap-3 mt-4">
            {byRisk(caps).map((c) => {
              const r = RISK[c.risk] || RISK['read-only'];
              const on = effective(c);
              return (
                <label key={c.id} className="flex items-start gap-2.5 cursor-pointer select-none rounded-lg border border-cohesity-border bg-surface-overlay/40 px-3 py-2.5">
                  <input type="checkbox" checked={on} onChange={(e) => setPending((p) => ({ ...p, [c.id]: e.target.checked }))} className="accent-brand cursor-pointer mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-ink font-medium">{c.label}</span>
                      <Badge tone={r.tone}>{r.label}</Badge>
                      {c.source !== 'built-in' && <Badge tone="neutral">from {c.source} pack</Badge>}
                      {c.deepOnly && <Badge tone="neutral">deep pass only</Badge>}
                      {!c.playbook && !c.deepOnly && <Badge tone="neutral">runs on its own trigger</Badge>}
                      {c.enabled !== on && <span className="text-[10px] text-amber-400">unsaved</span>}
                    </span>
                    <span className="block text-[11px] text-ink-muted mt-0.5">{c.description}</span>
                    <span className="block text-[10px] text-ink-faint mt-0.5">{r.hint}</span>
                  </span>
                </label>
              );
            })}
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <button onClick={save} disabled={saving || !dirty}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
                <Save size={13} /> {saving ? 'Saving...' : 'Save capabilities'}
              </button>
              <button onClick={() => setAll(true)} className="text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">Turn all on</button>
              <button onClick={() => setAll(false)} className="text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">Turn all off</button>
              <span className="text-[11px] text-ink-faint">Packs add their own capabilities here when installed. The public demo lists them but never runs a probe.</span>
            </div>
          </div>
        )}
      </div>

      <div className="panel p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div>
            <p className="text-sm font-bold text-ink">What the agent ran</p>
            <p className="text-[11px] text-ink-muted">The newest 50 runs, kept 30 days. Open the incident under Ops &gt; Ops Agent for the triage that used them.</p>
          </div>
          <button onClick={load} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors cursor-pointer"><RefreshCw size={12} /> Refresh</button>
        </div>
        {runs.length === 0 ? (
          <p className="text-[12px] text-ink-faint">Nothing yet. Runs appear once a capability is on and the agent triages an incident.</p>
        ) : (
          <>
          <TableControls ctl={ctl} rows={runList} searchPlaceholder="Filter by check, target, incident..." filters={[{ k: 'resultLabel', label: 'Result' }, { k: 'capability', label: 'Check' }, { k: 'requestedByLabel', label: 'Requested by' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[11px] text-ink-faint border-b border-cohesity-border">
                  <SortTh k="ranAt" label="When" ctl={ctl} />
                  <SortTh k="capability" label="Check" ctl={ctl} />
                  <SortTh k="targetName" label="Target" ctl={ctl} />
                  <SortTh k="resultLabel" label="Result" ctl={ctl} />
                  <SortTh k="requestedByLabel" label="Requested by" ctl={ctl} />
                  <SortTh k="incidentId" label="Incident" ctl={ctl} />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((r) => (
                  <tr key={r.id} className="border-b border-cohesity-border/40 last:border-0">
                    <td className="py-1 pr-3 text-ink-muted whitespace-nowrap" title={r.ranAt}>{timeAgo(r.ranAt)}</td>
                    <td className="py-1 pr-3 text-ink whitespace-nowrap">{r.capability} <span className="text-ink-faint">({r.durationMs} ms)</span></td>
                    <td className="py-1 pr-3 text-ink-muted">{r.targetName}{r.targetAddress && r.targetAddress !== r.targetName ? <span className="text-ink-faint"> {r.targetAddress}</span> : null} <span className="text-ink-faint">{r.platform}</span></td>
                    <td className="py-1 pr-3 text-ink-muted"><span className={r.ok ? 'text-status-ok font-semibold' : 'text-status-crit font-semibold'}>{r.ok ? 'OK' : 'FAILED'}</span> {r.summary}{r.reason ? <span className="block text-ink-faint">Reason: {r.reason}</span> : null}</td>
                    <td className="py-1 pr-3 text-ink-muted whitespace-nowrap">{r.requestedByLabel}</td>
                    <td className="py-1 text-ink-muted">{r.incidentId ? <Link to={`/ops/agent?incident=${r.incidentId}`} className="text-brand hover:underline">#{r.incidentId}</Link> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
          </>
        )}
      </div>
    </>
  );
}
