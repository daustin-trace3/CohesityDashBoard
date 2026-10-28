import { useEffect, useState, useCallback, useMemo } from 'react';
import { Target, Pencil, Trash2, Plus, RefreshCw } from 'lucide-react';
import { useToast } from '../../../components/ui/Toaster';
import { PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../../components/ui/primitives';
import { fmtUsd } from '../helpers';
import { getBudgets, updateBudget, deleteBudget, evaluateBudgets, errMsg } from './finopsApi';
import BudgetBar from './BudgetBar';
import BudgetModal from './BudgetModal';
import { BUDGET_TONE, BUDGET_LABEL, thCls } from './shared';

const iconBtn = 'flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

function scopeText(b, accounts) {
  if (b.scopeType === 'total') return 'Total spend';
  if (b.scopeType === 'account') return `Account: ${accounts.find((a) => String(a.id) === String(b.scopeKey))?.name || b.scopeKey}`;
  if (b.scopeType === 'external') return `AWS budget: ${b.externalName || b.name}`;
  if (b.scopeType === 'service') return b.scopeMatch === 'contains' ? `Services containing: ${b.scopeValue}` : `Service: ${b.scopeValue}`;
  return `Tag: ${b.scopeKey} = ${b.scopeValue}`;
}

export default function FinopsBudgetsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [modal, setModal] = useState(null); // null | { budget: obj|null }
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => getBudgets()
    .then((d) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch((err) => { setData({}); toast({ type: 'error', title: 'Failed to load budgets', message: errMsg(err, '') }); }),
  [toast]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const budgets = useMemo(() => data?.budgets || [], [data]);
  const scopes = data?.scopes || {};
  const accounts = scopes.accounts || [];

  const evaluate = async () => {
    setEvaluating(true);
    try {
      const res = await evaluateBudgets();
      toast({ type: 'success', title: 'Budgets evaluated', message: res?.evaluated != null ? `${res.evaluated} budget(s)` : undefined });
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Evaluation failed', message: errMsg(err, '') });
    } finally {
      setEvaluating(false);
    }
  };

  const toggleEnabled = async (b) => {
    setBusyId(b.id);
    try {
      await updateBudget(b.id, { enabled: !b.enabled });
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Update failed', message: errMsg(err, '') });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (b) => {
    if (!window.confirm(`Delete budget "${b.name}"?`)) return;
    setBusyId(b.id);
    try {
      await deleteBudget(b.id);
      toast({ type: 'success', title: `Deleted ${b.name}` });
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Delete failed', message: errMsg(err, '') });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Target} title="Budgets" description="Monthly spend limits by total, account, service or tag, evaluated nightly and when saved">
        <button onClick={() => setModal({ budget: null })}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity cursor-pointer">
          <Plus size={15} /> Add budget
        </button>
        <button onClick={evaluate} disabled={evaluating}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
          <RefreshCw size={15} className={evaluating ? 'animate-spin' : ''} /> {evaluating ? 'Evaluating...' : 'Evaluate now'}
        </button>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      <Panel title="Budgets">
        {data == null ? <LoadingPanel height={160} /> : budgets.length === 0
          ? <div className="text-sm text-ink-muted py-8 text-center">No budgets yet. Add one to track spend against a monthly limit.</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={thCls}>
                  <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Scope</th>
                  <th className="py-2 pr-3 text-right">Budget</th><th className="py-2 pr-3 text-right">Actual</th>
                  <th className="py-2 pr-3 text-right">Forecast</th><th className="py-2 pr-3 w-44">Progress</th>
                  <th className="py-2 pr-3">State</th><th className="py-2 pr-3">Enabled</th><th className="py-2 pr-3 text-right">Actions</th>
                </tr></thead>
                <tbody>
                  {budgets.map((b) => {
                    const st = b.status;
                    return (
                      <tr key={b.id} className={`border-b border-cohesity-border/50 ${b.enabled ? '' : 'opacity-60'}`}>
                        <td className="py-2 pr-3 text-ink">
                          {b.name}
                          {b.source === 'aws' && <span title="Imported from AWS Budgets"><Badge tone="brand" className="ml-2">AWS</Badge></span>}
                          {b.source === 'aws' && b.timeUnit && <span className="block text-[11px] text-ink-faint">{String(b.timeUnit).toLowerCase()}{b.lastSyncedAt ? `, synced ${String(b.lastSyncedAt).slice(0, 10)}` : ''}</span>}
                          {b.notes && <span className="block text-[11px] text-ink-faint max-w-[220px] truncate" title={b.notes}>{b.notes}</span>}
                        </td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px]">{scopeText(b, accounts)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink">{fmtUsd(b.amountUsd)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{st ? fmtUsd(st.actualUsd) : (b.awsActualUsd != null ? fmtUsd(b.awsActualUsd) : '-')}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted" title={st?.forecastSource ? `Source: ${st.forecastSource}` : undefined}>{st?.forecastUsd != null ? fmtUsd(st.forecastUsd) : (b.awsForecastUsd != null ? fmtUsd(b.awsForecastUsd) : '-')}</td>
                        <td className="py-2 pr-3">
                          {st ? <BudgetBar showName={false} budget={{ ...b, actualUsd: st.actualUsd, forecastUsd: st.forecastUsd, pctActual: st.pctActual, state: st.state }} />
                            : <span className="text-[11px] text-ink-faint">not evaluated yet</span>}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {st ? <Badge tone={BUDGET_TONE[st.state] || 'neutral'}>{BUDGET_LABEL[st.state] || st.state}</Badge> : <Badge>pending</Badge>}
                        </td>
                        <td className="py-2 pr-3">
                          <input type="checkbox" checked={!!b.enabled} disabled={busyId === b.id || b.source === 'aws'} onChange={() => toggleEnabled(b)}
                            title={b.source === 'aws' ? 'Managed in AWS Budgets' : undefined}
                            aria-label={`Enable ${b.name}`} className="accent-brand cursor-pointer" />
                        </td>
                        <td className="py-2 pr-3">
                          {b.source === 'aws' ? (
                            <div className="flex items-center justify-end text-[11px] text-ink-faint" title="Managed in AWS Budgets">Managed in AWS Budgets</div>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              <button onClick={() => setModal({ budget: b })} title="Edit" aria-label={`Edit ${b.name}`} className={iconBtn}><Pencil size={13} /></button>
                              <button onClick={() => remove(b)} disabled={busyId === b.id} title="Delete" aria-label={`Delete ${b.name}`}
                                className={`${iconBtn} hover:!text-status-crit hover:!border-status-crit/50`}><Trash2 size={13} /></button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Panel>

      {modal && (
        <BudgetModal budget={modal.budget} scopes={scopes}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}
