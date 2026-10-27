import { useEffect, useMemo, useState, useCallback } from 'react';
import { Coins, Copy, RefreshCw, Mail, X } from 'lucide-react';
import { useToast } from '../../../components/ui/Toaster';
import { Panel, Badge, LoadingPanel } from '../../../components/ui/primitives';
import { SettingRow, SettingGroup, Toggle, TabSaveBar, InfoTip, inputCls, numberCls, selectCls } from '../../../components/settings/SettingRow';
import { fmtWhen } from '../helpers';
import { getConfig, putConfig, getCapabilities, refreshFinops, sendDigest, errMsg } from './finopsApi';
import { CAP_LABELS } from './shared';

// One entry per numeric FinOps setting: key in /config, label, range and unit for the row.
const NUMBERS = {
  anomalyPct: { label: 'Anomaly threshold (%)', min: 5, max: 500, int: true, tip: 'A service is flagged when its spend is this far above its baseline.' },
  anomalyFloorUsd: { label: 'Anomaly floor (USD per day)', min: 0, max: 100000, tip: 'The increase must also exceed this amount, so cheap services do not raise alerts.' },
  anomalyBaselineDays: { label: 'Baseline window (days)', min: 3, max: 30, int: true, tip: 'The baseline is the median of this many days before the day being checked.' },
  anomalyClearDays: { label: 'Days to clear', min: 1, max: 14, int: true, tip: 'An anomaly closes after this many consecutive normal days.' },
  spUtilWarnPct: { label: 'Savings Plan utilization warning (%)', min: 1, max: 100, int: true, tip: 'Raises the commitment-underutilized issue when the 7 day mean utilization is below this.' },
  spExpiryWarnDays: { label: 'Savings Plan expiry warning (days)', min: 1, max: 365, int: true, tip: 'Raises the commitment-expiring issue when a plan ends within this many days.' },
  priceGp2ToGp3PerGb: { label: 'gp2 to gp3 saving (USD per GB-month)', min: 0, max: 10, tip: 'Used by the Optimizer heuristics.' },
  priceEbsGp2PerGb: { label: 'EBS gp2 (USD per GB-month)', min: 0, max: 10, tip: 'Used by the Optimizer heuristics.' },
  priceEbsGp3PerGb: { label: 'EBS gp3 (USD per GB-month)', min: 0, max: 10, tip: 'Used by the Optimizer heuristics.' },
  priceNatGatewayMonth: { label: 'NAT gateway (USD per month)', min: 0, max: 1000, tip: 'Used by the Optimizer heuristics.' },
};
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const STATUS_TONE = { ok: 'ok', denied: 'crit', not_enabled: 'warn', error: 'crit', unknown: 'neutral' };

function toDraft(c) {
  const d = {
    finopsMetric: c.finopsMetric || 'amortized',
    finopsTagKeys: Array.isArray(c.finopsTagKeys) ? [...c.finopsTagKeys] : [],
    finopsLinkedAccounts: c.finopsLinkedAccounts || 'auto',
    finopsDigestEnabled: !!c.finopsDigestEnabled,
    finopsDigestRecipients: c.finopsDigestRecipients || '',
    finopsDigestWeekday: String(c.finopsDigestWeekday ?? 1),
  };
  Object.keys(NUMBERS).forEach((k) => { d[k] = c[k] == null ? '' : String(c[k]); });
  return d;
}

function numberError(k, v) {
  const def = NUMBERS[k];
  if (v === '' || !Number.isFinite(Number(v))) return 'Enter a number.';
  const n = Number(v);
  if (def.int && !Number.isInteger(n)) return 'Whole number only.';
  if (n < def.min || n > def.max) return `Between ${def.min} and ${def.max}.`;
  return null;
}

export default function FinopsSettings() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [caps, setCaps] = useState(null);
  const [recapturing, setRecapturing] = useState(false);
  const [sendingDigest, setSendingDigest] = useState(false);

  const loadCaps = useCallback(() => getCapabilities().then(setCaps).catch(() => setCaps({ capabilities: [], missingActions: [], policy: null })), []);

  useEffect(() => {
    getConfig().then((c) => { setCfg(c); setDraft(toDraft(c)); })
      .catch(() => { toast({ type: 'error', title: 'Failed to load FinOps settings' }); setCfg({}); setDraft(toDraft({})); });
    loadCaps();
  }, [toast, loadCaps]);

  const base = useMemo(() => (cfg ? toDraft(cfg) : null), [cfg]);
  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);
  const errors = useMemo(() => {
    if (!draft) return {};
    const e = {};
    Object.keys(NUMBERS).forEach((k) => { const m = numberError(k, draft[k]); if (m) e[k] = m; });
    if (draft.finopsTagKeys.length > 10) e.finopsTagKeys = 'At most 10 tag keys.';
    if (draft.finopsDigestRecipients.length > 1000) e.finopsDigestRecipients = 'At most 1000 characters.';
    return e;
  }, [draft]);
  const valid = Object.keys(errors).length === 0;

  if (!draft) return <Panel><LoadingPanel height={160} /></Panel>;

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const seen = (cfg?.tagKeysSeen || []).filter((k) => !draft.finopsTagKeys.includes(k));
  const addTag = (raw) => {
    const t = String(raw || '').trim();
    if (!t || t.length > 128 || draft.finopsTagKeys.includes(t) || draft.finopsTagKeys.length >= 10) return;
    set('finopsTagKeys', [...draft.finopsTagKeys, t]);
    setTagInput('');
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        costSpikePct: cfg?.costSpikePct ?? 30,
        finopsMetric: draft.finopsMetric,
        finopsTagKeys: draft.finopsTagKeys,
        finopsLinkedAccounts: draft.finopsLinkedAccounts,
        finopsDigestEnabled: draft.finopsDigestEnabled,
        finopsDigestRecipients: draft.finopsDigestRecipients.trim(),
        finopsDigestWeekday: Number(draft.finopsDigestWeekday),
      };
      Object.keys(NUMBERS).forEach((k) => { body[k] = Number(draft[k]); });
      const data = await putConfig(body);
      setCfg(data);
      setDraft(toDraft(data));
      toast({ type: 'success', title: 'FinOps settings saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: errMsg(err, 'Check the values and try again.') });
    } finally {
      setSaving(false);
    }
  };

  const recapture = async () => {
    setRecapturing(true);
    try {
      await refreshFinops();
      toast({ type: 'success', title: 'Re-capture queued', message: 'The FinOps capture runs on the next poll of the elected account.' });
      setTimeout(loadCaps, 4000);
    } catch (err) {
      toast({ type: 'error', title: 'Could not queue the re-capture', message: errMsg(err, '') });
    } finally {
      setRecapturing(false);
    }
  };

  const sendNow = async () => {
    setSendingDigest(true);
    try {
      const res = await sendDigest();
      toast({ type: 'success', title: 'Digest sent', message: Array.isArray(res?.recipients) ? res.recipients.join(', ') : undefined });
    } catch (err) {
      toast({ type: 'error', title: 'Digest not sent', message: errMsg(err, 'SMTP may not be configured.') });
    } finally {
      setSendingDigest(false);
    }
  };

  const copyPolicy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(caps.policy, null, 2));
      toast({ type: 'success', title: 'Policy copied' });
    } catch {
      toast({ type: 'error', title: 'Copy failed', message: 'Select the text and copy it by hand.' });
    }
  };

  const num = (k) => (
    <SettingRow key={k} label={NUMBERS[k].label} htmlFor={`fo-${k}`} tip={NUMBERS[k].tip} dirty={draft[k] !== base[k]}>
      <input id={`fo-${k}`} type="number" min={NUMBERS[k].min} max={NUMBERS[k].max} step={NUMBERS[k].int ? 1 : 'any'}
        value={draft[k]} onChange={(e) => set(k, e.target.value)} className={numberCls} />
      {errors[k] && <p role="alert" className="text-[11px] text-status-crit mt-1">{errors[k]}</p>}
      <p className="text-[10px] text-ink-faint mt-1">Range {NUMBERS[k].min} to {NUMBERS[k].max}.</p>
    </SettingRow>
  );

  const capRows = caps?.capabilities || [];
  const missing = caps?.missingActions || [];

  return (
    <>
      <Panel title="FinOps" icon={Coins}>
        <SettingGroup title="Cost metric">
          <SettingRow label="Default metric" htmlFor="fo-metric" dirty={draft.finopsMetric !== base.finopsMetric}
            tip="Amortized spreads Savings Plan and reservation fees over the days they cover, so instance types read their real cost. Unblended is the cash charge. The FinOps pages default to this; the Cost Explorer page keeps its own toggle.">
            <select id="fo-metric" value={draft.finopsMetric} onChange={(e) => set('finopsMetric', e.target.value)} className={`${selectCls} max-w-[12rem]`}>
              <option value="amortized">Amortized</option>
              <option value="unblended">Unblended</option>
            </select>
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Allocation">
          <SettingRow label="Tag keys" tip="Cost allocation tag keys to report spend by. Each must be activated as a cost allocation tag in the AWS Billing console first. Up to 10." dirty={JSON.stringify(draft.finopsTagKeys) !== JSON.stringify(base.finopsTagKeys)}>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {draft.finopsTagKeys.length === 0 && <span className="text-[11px] text-ink-faint">No tag keys yet.</span>}
              {draft.finopsTagKeys.map((k) => (
                <span key={k} className="chip bg-surface-overlay text-ink border-cohesity-border inline-flex items-center gap-1">
                  {k}
                  <button type="button" aria-label={`Remove ${k}`} onClick={() => set('finopsTagKeys', draft.finopsTagKeys.filter((x) => x !== k))}
                    className="text-ink-faint hover:text-status-crit cursor-pointer"><X size={11} /></button>
                </span>
              ))}
            </div>
            <div className="flex gap-2 max-w-md">
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} maxLength={128} placeholder="Environment" aria-label="Add tag key"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); } }} className={inputCls} spellCheck={false} />
              <button type="button" onClick={() => addTag(tagInput)} disabled={!tagInput.trim() || draft.finopsTagKeys.length >= 10}
                className="px-3 py-2 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">Add</button>
            </div>
            {seen.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <span className="text-[11px] text-ink-faint">Active in AWS:</span>
                {seen.map((k) => (
                  <button key={k} type="button" onClick={() => addTag(k)}
                    className="chip bg-brand/10 text-brand border-brand/25 cursor-pointer hover:bg-brand/20">{k}</button>
                ))}
              </div>
            )}
            {errors.finopsTagKeys && <p role="alert" className="text-[11px] text-status-crit mt-1">{errors.finopsTagKeys}</p>}
          </SettingRow>
          <SettingRow label="Linked accounts" htmlFor="fo-linked" dirty={draft.finopsLinkedAccounts !== base.finopsLinkedAccounts}
            tip="Auto probes once and turns the linked-account breakdown on only when the account belongs to an AWS Organization.">
            <select id="fo-linked" value={draft.finopsLinkedAccounts} onChange={(e) => set('finopsLinkedAccounts', e.target.value)} className={`${selectCls} max-w-[12rem]`}>
              <option value="auto">Auto</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </SettingRow>
        </SettingGroup>

        <SettingGroup title="Anomaly rule">
          {['anomalyPct', 'anomalyFloorUsd', 'anomalyBaselineDays', 'anomalyClearDays'].map(num)}
        </SettingGroup>
        <SettingGroup title="Commitments">
          {['spUtilWarnPct', 'spExpiryWarnDays'].map(num)}
        </SettingGroup>
        <SettingGroup title="Heuristic prices">
          {['priceGp2ToGp3PerGb', 'priceEbsGp2PerGb', 'priceEbsGp3PerGb', 'priceNatGatewayMonth'].map(num)}
        </SettingGroup>

        <SettingGroup title="Weekly digest">
          <SettingRow label="Send a weekly digest" htmlFor="fo-digest" dirty={draft.finopsDigestEnabled !== base.finopsDigestEnabled}
            tip="Emails the FinOps overview once a week through the SMTP server in Global Settings.">
            <Toggle id="fo-digest" checked={draft.finopsDigestEnabled} onChange={(v) => set('finopsDigestEnabled', v)} />
          </SettingRow>
          <SettingRow label="Recipients" htmlFor="fo-recips" dirty={draft.finopsDigestRecipients !== base.finopsDigestRecipients}
            tip="Comma separated addresses. Blank uses the default alert recipients.">
            <input id="fo-recips" value={draft.finopsDigestRecipients} onChange={(e) => set('finopsDigestRecipients', e.target.value)} maxLength={1000}
              placeholder="finance@example.com, platform@example.com" className={inputCls} spellCheck={false} />
            {errors.finopsDigestRecipients && <p role="alert" className="text-[11px] text-status-crit mt-1">{errors.finopsDigestRecipients}</p>}
          </SettingRow>
          <SettingRow label="Day of week" htmlFor="fo-weekday" dirty={draft.finopsDigestWeekday !== base.finopsDigestWeekday}>
            <select id="fo-weekday" value={draft.finopsDigestWeekday} onChange={(e) => set('finopsDigestWeekday', e.target.value)} className={`${selectCls} max-w-[12rem]`}>
              {WEEKDAYS.map((d, i) => <option key={d} value={String(i + 1)}>{d}</option>)}
            </select>
          </SettingRow>
        </SettingGroup>

        <TabSaveBar onSave={save} saving={saving} dirty={dirty && valid}>
          <button type="button" onClick={sendNow} disabled={sendingDigest}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
            <Mail size={13} /> {sendingDigest ? 'Sending...' : 'Send digest now'}
          </button>
          {dirty && !valid && <span className="text-[10px] text-status-crit">Fix the highlighted values to save.</span>}
        </TabSaveBar>
      </Panel>

      <Panel title="Data sources" actions={(
        <button onClick={recapture} disabled={recapturing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
          <RefreshCw size={12} className={recapturing ? 'animate-spin' : ''} /> {recapturing ? 'Queueing...' : 'Re-capture now'}
        </button>
      )}>
        {caps == null ? <LoadingPanel height={100} /> : (
          <>
            <p className="text-[11px] text-ink-muted mb-3">
              Last capture: {caps.lastCaptureAt ? fmtWhen(caps.lastCaptureAt) : 'never'}
              {caps.lastCaptureRequests != null ? `, ${caps.lastCaptureRequests} request(s)` : ''}
              {caps.estimatedDailyUsd != null ? `, about $${Number(caps.estimatedDailyUsd).toFixed(2)} of Cost Explorer charges per day` : ''}.
              <InfoTip label="Cost Explorer charges">Each Cost Explorer API request costs USD 0.01. The FinOps capture runs once a day on one account.</InfoTip>
            </p>
            {capRows.length === 0 ? (
              <div className="text-sm text-ink-muted py-4 text-center">No capture has run yet. Use Re-capture now to run the first one.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">Source</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">IAM actions</th>
                    <th className="py-2 pr-3 text-right">Requests</th><th className="py-2 pr-3">Last ok</th>
                  </tr></thead>
                  <tbody>
                    {capRows.map((c) => (
                      <tr key={c.capability} className="border-b border-cohesity-border/50 align-top">
                        <td className="py-2 pr-3 text-ink">{CAP_LABELS[c.capability] || c.capability}</td>
                        <td className="py-2 pr-3">
                          <Badge tone={STATUS_TONE[c.status] || 'neutral'}>{String(c.status || 'unknown').replace('_', ' ')}</Badge>
                          {c.error && c.status !== 'ok' && <p className="text-[10px] text-ink-faint mt-0.5 max-w-[320px] break-words">{String(c.error).slice(0, 300)}</p>}
                        </td>
                        <td className="py-2 pr-3 text-[11px] text-ink-muted">{(c.iamActions || []).join(', ') || '-'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.requests ?? '-'}</td>
                        <td className="py-2 pr-3 text-[11px] text-ink-faint whitespace-nowrap">{c.lastOkAt ? fmtWhen(c.lastOkAt) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <p className="text-xs font-semibold text-ink">IAM policy for the missing actions</p>
                {missing.length > 0 && caps.policy && (
                  <button onClick={copyPolicy}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                    <Copy size={12} /> Copy
                  </button>
                )}
              </div>
              {missing.length === 0 || !caps.policy ? (
                <p className="text-[11px] text-ink-faint">No missing actions. Every capability that has run reached its Cost Explorer operation.</p>
              ) : (
                <pre className="text-[11px] leading-relaxed text-ink-muted bg-surface-overlay border border-cohesity-border rounded-lg p-3 overflow-x-auto">{JSON.stringify(caps.policy, null, 2)}</pre>
              )}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
