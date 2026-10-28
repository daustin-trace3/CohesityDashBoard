import { useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import { ModalShell } from '../../../components/hyperv/HvUi';
import { useToast } from '../../../components/ui/Toaster';
import { createBudget, updateBudget, errMsg } from './finopsApi';

const field = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
const label = 'block text-xs font-semibold text-ink mb-1';

/**
 * Add or edit a budget. budget = null adds. scopes = { services, tagKeys, tagValues, accounts }.
 * onSaved(budget) is called after a successful save; onClose closes without saving.
 */
export default function BudgetModal({ budget, scopes, onClose, onSaved }) {
  const { toast } = useToast();
  const editing = !!budget;
  const [form, setForm] = useState(() => ({
    name: budget?.name || '',
    scopeType: budget?.scopeType || 'total',
    scopeKey: budget?.scopeKey || '',
    scopeValue: budget?.scopeValue || '',
    scopeMatch: budget?.scopeMatch === 'contains' ? 'contains' : 'exact',
    amountUsd: budget?.amountUsd != null ? String(budget.amountUsd) : '',
    warnPct: String(budget?.warnPct ?? 80),
    critPct: String(budget?.critPct ?? 100),
    forecastAlert: budget?.forecastAlert ?? true,
    enabled: budget?.enabled ?? true,
    notes: budget?.notes || '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const services = scopes?.services || [];
  const tagKeys = scopes?.tagKeys || [];
  const accounts = scopes?.accounts || [];
  const tagValues = useMemo(() => (scopes?.tagValues || {})[form.scopeKey] || [], [scopes, form.scopeKey]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setType = (e) => setForm((f) => ({ ...f, scopeType: e.target.value, scopeKey: '', scopeValue: '', scopeMatch: 'exact' }));

  const amount = Number(form.amountUsd);
  const warn = Number(form.warnPct);
  const crit = Number(form.critPct);
  const scopeOk = form.scopeType === 'total'
    || (form.scopeType === 'account' && form.scopeKey)
    || (form.scopeType === 'service' && form.scopeValue)
    || (form.scopeType === 'tag' && form.scopeKey.trim() && form.scopeValue.trim());
  const valid = form.name.trim().length > 0 && form.name.trim().length <= 80 && amount > 0
    && warn >= 1 && warn <= 100 && crit >= warn && scopeOk;

  const save = async () => {
    setSaving(true);
    setError('');
    const body = {
      name: form.name.trim(), scopeType: form.scopeType, amountUsd: amount, warnPct: warn, critPct: crit,
      forecastAlert: !!form.forecastAlert, enabled: !!form.enabled, notes: form.notes.trim() || undefined,
    };
    if (form.scopeType === 'account' || form.scopeType === 'tag') body.scopeKey = form.scopeKey.trim();
    if (form.scopeType === 'service' || form.scopeType === 'tag') body.scopeValue = form.scopeValue.trim();
    if (form.scopeType === 'service') body.scopeMatch = form.scopeMatch === 'contains' ? 'contains' : 'exact';
    try {
      const res = editing ? await updateBudget(budget.id, body) : await createBudget(body);
      toast({ type: 'success', title: editing ? 'Budget updated' : 'Budget added' });
      onSaved?.(res?.budget);
    } catch (err) {
      const msg = err?.response?.status === 409 ? 'A budget with that name already exists.' : errMsg(err, 'Save failed');
      setError(msg);
      toast({ type: 'error', title: 'Budget not saved', message: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={editing ? `Edit budget: ${budget.name}` : 'Add budget'} icon={Target} size="md" onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="bm-name">Name</label>
          <input id="bm-name" value={form.name} onChange={set('name')} maxLength={80} placeholder="Bedrock models" className={field} spellCheck={false} />
        </div>
        <div>
          <label className={label} htmlFor="bm-type">Scope</label>
          <select id="bm-type" value={form.scopeType} onChange={setType} className={`${field} cursor-pointer`}>
            <option value="total">Total spend</option>
            <option value="account">Account</option>
            <option value="service">Service</option>
            <option value="tag">Tag value</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="bm-amount">Monthly amount (USD)</label>
          <input id="bm-amount" type="number" min="0" step="any" value={form.amountUsd} onChange={set('amountUsd')} className={`${field} tnum`} />
        </div>
        {form.scopeType === 'account' && (
          <div className="sm:col-span-2">
            <label className={label} htmlFor="bm-acct">Account</label>
            <select id="bm-acct" value={form.scopeKey} onChange={set('scopeKey')} className={`${field} cursor-pointer`}>
              <option value="">Select an account</option>
              {accounts.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
            </select>
          </div>
        )}
        {form.scopeType === 'service' && (
          <div className="sm:col-span-2">
            <label className={label} htmlFor="bm-svc">Service</label>
            {form.scopeMatch === 'contains' ? (
              <input id="bm-svc" list="bm-svcs" value={form.scopeValue} onChange={set('scopeValue')} placeholder="Bedrock" className={field} spellCheck={false} />
            ) : (
              <select id="bm-svc" value={form.scopeValue} onChange={set('scopeValue')} className={`${field} cursor-pointer`}>
                <option value="">Select a service</option>
                {form.scopeValue && !services.includes(form.scopeValue) && <option value={form.scopeValue}>{form.scopeValue}</option>}
                {services.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <datalist id="bm-svcs">{services.map((x) => <option key={x} value={x} />)}</datalist>
            <label className="flex items-center gap-2 text-xs text-ink cursor-pointer mt-2">
              <input type="checkbox" checked={form.scopeMatch === 'contains'}
                onChange={(e) => setForm((f) => ({ ...f, scopeMatch: e.target.checked ? 'contains' : 'exact' }))} className="accent-brand" />
              Match every service whose name contains this text
            </label>
            {form.scopeMatch === 'contains' && form.scopeValue && (
              <p className="text-[11px] text-ink-faint mt-1">Services containing: {form.scopeValue}</p>
            )}
          </div>
        )}
        {form.scopeType === 'tag' && (
          <>
            <div>
              <label className={label} htmlFor="bm-tkey">Tag key</label>
              <input id="bm-tkey" list="bm-tkeys" value={form.scopeKey} onChange={set('scopeKey')} placeholder="Environment" className={field} spellCheck={false} />
              <datalist id="bm-tkeys">{tagKeys.map((k) => <option key={k} value={k} />)}</datalist>
            </div>
            <div>
              <label className={label} htmlFor="bm-tval">Tag value</label>
              <input id="bm-tval" list="bm-tvals" value={form.scopeValue} onChange={set('scopeValue')} placeholder="prod" className={field} spellCheck={false} />
              <datalist id="bm-tvals">{tagValues.map((v) => <option key={v} value={v} />)}</datalist>
            </div>
          </>
        )}
        <div>
          <label className={label} htmlFor="bm-warn">Warn at (% of budget)</label>
          <input id="bm-warn" type="number" min="1" max="100" value={form.warnPct} onChange={set('warnPct')} className={`${field} tnum`} />
        </div>
        <div>
          <label className={label} htmlFor="bm-crit">Exceeded at (% of budget)</label>
          <input id="bm-crit" type="number" min="1" value={form.critPct} onChange={set('critPct')} className={`${field} tnum`} />
        </div>
        <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
          <input type="checkbox" checked={!!form.forecastAlert} onChange={set('forecastAlert')} className="accent-brand" />
          Alert when the forecast passes the budget
        </label>
        <label className="flex items-center gap-2 text-xs text-ink cursor-pointer">
          <input type="checkbox" checked={!!form.enabled} onChange={set('enabled')} className="accent-brand" />
          Enabled
        </label>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="bm-notes">Notes</label>
          <textarea id="bm-notes" rows={2} value={form.notes} onChange={set('notes')} className={field} />
        </div>
      </div>
      {form.critPct !== '' && crit < warn && <p className="text-[11px] text-status-warn mt-2">The exceeded percentage must be at least the warning percentage.</p>}
      {error && <p role="alert" className="text-[11px] text-status-crit mt-2">{error}</p>}
      <div className="flex items-center gap-2 mt-4">
        <button onClick={save} disabled={saving || !valid}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
          {saving ? 'Saving...' : editing ? 'Save changes' : 'Add budget'}
        </button>
        <button onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer">
          Cancel
        </button>
      </div>
    </ModalShell>
  );
}
