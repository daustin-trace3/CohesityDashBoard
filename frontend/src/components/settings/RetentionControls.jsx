import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../ui/Toaster';
import { SettingRow, SettingGroup, numberCls, TabSaveBar } from './SettingRow';

// Data retention controls shared by Global Settings and every platform
// Settings page. Values: blank = inherit, 0 = keep forever, N = N days.
// Backend: GET /api/retention, PUT /api/retention/global, PUT /api/retention/platforms/:id.

const BUCKET_ORDER = ['trending', 'events'];
const toNum = (v) => (v === '' || v == null ? null : Number(v));
const errMsg = (e, fallback) => e?.response?.data?.error || fallback;

/** Validation text for a typed value, or '' when fine. */
function problem(raw, b, allowBlank) {
  if (raw === '' || raw == null) return allowBlank ? '' : 'Enter a number of days.';
  const n = Number(raw);
  if (!Number.isInteger(n)) return 'Enter a whole number of days.';
  if (n === 0) return '';
  if (n < b.min || n > b.max) return `Use 0, or ${b.min} to ${b.max} days.`;
  return '';
}

/** Effective days from a typed value: blank means the global value. */
function effectiveOf(raw, globalDays) {
  const n = toNum(raw);
  return n == null ? globalDays : n;
}

/** True when moving from `before` to `after` effective days deletes more rows. */
function isReduction(before, after) {
  if (before === 0) return after !== 0;
  if (after === 0) return false;
  return after < before;
}

function confirmReduction(days) {
  return window.confirm(`Rows older than ${days} days will be deleted at the next poll and cannot be recovered. Continue?`);
}

export function RetentionField({ bucket, value, effective, globalDays, onChange, id, allowInherit = true, compact = false }) {
  const err = problem(value, bucket, allowInherit);
  const blank = value === '' || value == null;
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <input id={id} type="number" min="0" max={bucket.max} step="1" value={value ?? ''}
          placeholder={allowInherit ? `Inherits global (${globalDays})` : String(bucket.default)}
          onChange={(e) => onChange(e.target.value)}
          className={`${numberCls} ${err ? '!border-red-500/60' : ''}`} style={{ maxWidth: '12rem' }} />
        {allowInherit && !blank && (
          <button type="button" onClick={() => onChange('')}
            className="text-[11px] text-brand hover:underline cursor-pointer"
            style={{ background: 'none', border: 'none', padding: 0 }}>Reset to inherit</button>
        )}
      </div>
      {!compact && (
        <p className="text-[11px] text-ink-faint mt-1">
          0 = keep forever, {bucket.min} to {bucket.max} days
          {allowInherit && blank ? `. Using ${effective} days from the global setting` : ''}
        </p>
      )}
      {err && <p className="text-[11px] text-red-400 mt-0.5">{err}</p>}
    </div>
  );
}

function useRetention() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const { data: d } = await client.get('/retention');
      setData(d); setError('');
      return d;
    } catch (e) {
      setError(errMsg(e, 'Could not load retention settings.'));
      return null;
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { data, error, load, setData };
}

const rowValue = (row, k) => (row?.[k]?.override == null ? '' : String(row[k].override));

export function RetentionPanel({ platform }) {
  const { toast } = useToast();
  const { data, error, setData } = useRetention();
  const [vals, setVals] = useState({ trending: '', events: '' });
  const [saving, setSaving] = useState(false);

  const row = data?.platforms?.find((p) => p.id === platform);
  useEffect(() => {
    if (row) setVals({ trending: rowValue(row, 'trending'), events: rowValue(row, 'events') });
  }, [row]);

  if (error) return <div className="panel p-4"><p className="text-xs text-red-400">{error}</p></div>;
  if (!data) return <div className="panel p-4"><p className="text-xs text-ink-muted">Loading...</p></div>;
  if (!row) return <div className="panel p-4"><p className="text-xs text-ink-muted">No retention settings for this platform.</p></div>;

  const dirty = BUCKET_ORDER.some((k) => vals[k] !== rowValue(row, k));
  const invalid = BUCKET_ORDER.some((k) => problem(vals[k], data.buckets[k], true));

  const save = async () => {
    const lowered = BUCKET_ORDER
      .map((k) => ({ before: row[k].days, after: effectiveOf(vals[k], data.global[k].days) }))
      .filter((x) => isReduction(x.before, x.after));
    for (const x of lowered) if (!confirmReduction(x.after)) return;
    setSaving(true);
    try {
      const body = {};
      BUCKET_ORDER.forEach((k) => { body[k] = toNum(vals[k]); });
      const { data: d } = await client.put(`/retention/platforms/${platform}`, body);
      setData(d);
      toast({ type: 'success', title: 'Data retention saved', message: 'Older rows are removed at the next poll.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: errMsg(e, 'Could not save data retention.') });
    } finally { setSaving(false); }
  };

  return (
    <div className="panel p-4">
      <p className="text-sm font-bold text-ink">Data retention</p>
      <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed max-w-xl">
        How long ICC keeps the stored history of this platform. Leave a field blank to follow the global
        value under Global Settings. Lowering a value deletes older rows at the next poll.
      </p>
      <div className="mt-3">
        {BUCKET_ORDER.map((k) => {
          const b = data.buckets[k];
          const cov = row.coverage?.[k] || [];
          return (
            <SettingRow key={k} label={b.label} htmlFor={`ret-${platform}-${k}`}
              dirty={vals[k] !== rowValue(row, k)}
              tip={<>{b.description}{cov.length > 0 && <><br />Covers: {cov.join(', ')}</>}</>}>
              <RetentionField id={`ret-${platform}-${k}`} bucket={b} value={vals[k]}
                effective={effectiveOf(vals[k], data.global[k].days)} globalDays={data.global[k].days}
                onChange={(v) => setVals((s) => ({ ...s, [k]: v }))} />
            </SettingRow>
          );
        })}
      </div>
      <TabSaveBar onSave={save} saving={saving} dirty={dirty && !invalid} />
      {(row.raw || []).length > 0 && (
        <div className="mt-3 pt-3 border-t border-cohesity-border/60">
          <p className="text-[11px] text-ink-muted">
            Raw samples (platform only) are set in the {row.raw[0].panel || 'raw samples'} panel on this page:{' '}
            {row.raw.map((r) => `${r.label} ${r.days} days`).join(', ')}.
          </p>
        </div>
      )}
    </div>
  );
}

function PlatformRow({ p, buckets, global, onSaved }) {
  const { toast } = useToast();
  const [vals, setVals] = useState({ trending: rowValue(p, 'trending'), events: rowValue(p, 'events') });
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVals({ trending: rowValue(p, 'trending'), events: rowValue(p, 'events') }); }, [p]);
  const dirty = BUCKET_ORDER.some((k) => vals[k] !== rowValue(p, k));
  const invalid = BUCKET_ORDER.some((k) => problem(vals[k], buckets[k], true));

  const save = async () => {
    const lowered = BUCKET_ORDER
      .map((k) => ({ before: p[k].days, after: effectiveOf(vals[k], global[k].days) }))
      .filter((x) => isReduction(x.before, x.after));
    for (const x of lowered) if (!confirmReduction(x.after)) return;
    setSaving(true);
    try {
      const body = {};
      BUCKET_ORDER.forEach((k) => { body[k] = toNum(vals[k]); });
      const { data: d } = await client.put(`/retention/platforms/${p.id}`, body);
      onSaved(d);
      toast({ type: 'success', title: `${p.label} retention saved`, message: 'Older rows are removed at the next poll.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: errMsg(e, 'Could not save data retention.') });
    } finally { setSaving(false); }
  };

  return (
    <tr className={`border-b border-cohesity-border/50 align-top ${p.enabled ? '' : 'opacity-50'}`}>
      <td className="py-2 pr-3 text-xs text-ink whitespace-nowrap">
        {p.label}{!p.enabled && <span className="ml-1.5 text-[10px] text-ink-faint">disabled</span>}
      </td>
      {BUCKET_ORDER.map((k) => (
        <td key={k} className="py-2 pr-3">
          <RetentionField id={`ret-row-${p.id}-${k}`} bucket={buckets[k]} value={vals[k]} compact
            effective={effectiveOf(vals[k], global[k].days)} globalDays={global[k].days}
            onChange={(v) => setVals((s) => ({ ...s, [k]: v }))} />
          <p className="text-[10px] text-ink-faint mt-0.5">
            Effective: {p[k].days === 0 ? 'forever' : `${p[k].days} days`} ({p[k].source === 'platform' ? 'platform' : 'global'})
          </p>
        </td>
      ))}
      <td className="py-2 whitespace-nowrap">
        <button onClick={save} disabled={saving || !dirty || invalid}
          className="text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 disabled:opacity-50 cursor-pointer">
          {saving ? 'Saving...' : 'Save'}
        </button>
        {p.settingsRoute && <Link to={p.settingsRoute} className="ml-2 text-xs text-brand hover:underline">Settings</Link>}
      </td>
    </tr>
  );
}

export function RetentionGlobalGroup() {
  const { toast } = useToast();
  const { data, error, setData } = useRetention();
  const [vals, setVals] = useState({ trending: '365', events: '30', ledger: '365' });
  const [saving, setSaving] = useState(false);

  const saved = data ? {
    trending: String(data.global.trending.days),
    events: String(data.global.events.days),
    ledger: String(data.ledgers.configLedgerDays),
  } : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (saved) setVals(saved); }, [data]);

  if (error) return <SettingGroup title="Data retention"><p className="text-xs text-red-400 py-2">{error}</p></SettingGroup>;
  if (!data) return <SettingGroup title="Data retention"><p className="text-xs text-ink-muted py-2">Loading...</p></SettingGroup>;

  const ledgerBucket = { min: 30, max: 1825, default: 365 };
  const dirty = ['trending', 'events', 'ledger'].some((k) => vals[k] !== saved[k]);
  const invalid = problem(vals.trending, data.buckets.trending, false)
    || problem(vals.events, data.buckets.events, false)
    || problem(vals.ledger, ledgerBucket, false) || (Number(vals.ledger) === 0 ? 'Use 30 to 1825 days.' : '');

  const save = async () => {
    for (const k of BUCKET_ORDER) {
      if (isReduction(Number(saved[k]), Number(vals[k])) && !confirmReduction(Number(vals[k]))) return;
    }
    if (Number(vals.ledger) < Number(saved.ledger) && !confirmReduction(Number(vals.ledger))) return;
    setSaving(true);
    try {
      const { data: d } = await client.put('/retention/global', {
        trending: Number(vals.trending), events: Number(vals.events), configLedgerDays: Number(vals.ledger),
      });
      setData(d);
      toast({ type: 'success', title: 'Data retention saved', message: 'Older rows are removed at the next poll.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: errMsg(e, 'Could not save data retention.') });
    } finally { setSaving(false); }
  };

  const gRow = (k, label, tip) => (
    <SettingRow label={label} htmlFor={`ret-global-${k}`} dirty={vals[k] !== saved[k]} tip={tip}>
      <RetentionField id={`ret-global-${k}`} bucket={data.buckets[k]} allowInherit={false}
        value={vals[k]} effective={Number(vals[k])} globalDays={data.global[k].days}
        onChange={(v) => setVals((s) => ({ ...s, [k]: v }))} />
    </SettingRow>
  );

  return (
    <>
      <SettingGroup title="Data retention">
        {gRow('trending', data.buckets.trending.label, data.buckets.trending.description)}
        {gRow('events', data.buckets.events.label, data.buckets.events.description)}
        <SettingRow label="Configuration change ledger" htmlFor="ret-global-ledger" dirty={vals.ledger !== saved.ledger}
          tip="How long the configuration change ledger keeps recorded changes.">
          <input id="ret-global-ledger" type="number" min="30" max="1825" step="1" value={vals.ledger}
            onChange={(e) => setVals((s) => ({ ...s, ledger: e.target.value }))} className={numberCls} />
          <p className="text-[11px] text-ink-faint mt-1">30 to 1825 days</p>
        </SettingRow>
      </SettingGroup>
      <TabSaveBar onSave={save} saving={saving} dirty={dirty && !invalid} />
      <div className="mt-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint pb-1 border-b border-cohesity-border/60">Effective retention per platform</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left mt-1">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-ink-faint">
                <th className="py-1.5 pr-3 font-semibold">Platform</th>
                <th className="py-1.5 pr-3 font-semibold">{data.buckets.trending.label}</th>
                <th className="py-1.5 pr-3 font-semibold">{data.buckets.events.label}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.platforms.map((p) => (
                <PlatformRow key={p.id} p={p} buckets={data.buckets} global={data.global} onSaved={setData} />
              ))}
            </tbody>
          </table>
        </div>
        {data.note && <p className="text-[11px] text-ink-muted mt-2">{data.note}</p>}
      </div>
    </>
  );
}
