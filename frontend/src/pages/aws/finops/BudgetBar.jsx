import { fmtUsd } from '../helpers';
import { BUDGET_COLOR, pct1 } from './shared';

/**
 * Budget progress bar: actual vs amount, colour by state, forecast marker.
 * budget: { name, amountUsd, actualUsd, forecastUsd, pctActual, state }
 */
export default function BudgetBar({ budget, showName = true }) {
  const amount = Number(budget.amountUsd) || 0;
  const actual = Number(budget.actualUsd) || 0;
  const forecast = budget.forecastUsd == null ? null : Number(budget.forecastUsd);
  const pctActual = budget.pctActual != null ? Number(budget.pctActual) : (amount > 0 ? (actual / amount) * 100 : 0);
  // The scale runs to 100 percent of the budget, or wider when actual or forecast overshoots.
  const scaleMax = Math.max(100, pctActual, forecast != null && amount > 0 ? (forecast / amount) * 100 : 0);
  const fill = Math.min(100, (pctActual / scaleMax) * 100);
  const marker = forecast != null && amount > 0 ? Math.min(100, ((forecast / amount) * 100 / scaleMax) * 100) : null;
  const limitPos = (100 / scaleMax) * 100;
  const color = BUDGET_COLOR[budget.state] || BUDGET_COLOR.ok;
  return (
    <div className="min-w-0">
      {showName && (
        <div className="flex items-baseline justify-between gap-2 text-xs mb-1">
          <span className="text-ink truncate">{budget.name}</span>
          <span className="text-ink-muted tnum whitespace-nowrap">{fmtUsd(actual)} / {fmtUsd(amount)} ({pct1(pctActual)})</span>
        </div>
      )}
      <div className="relative h-2.5 rounded-full bg-surface-overlay border border-cohesity-border overflow-visible"
        title={`Actual ${fmtUsd(actual)}${forecast != null ? `, forecast ${fmtUsd(forecast)}` : ''}, budget ${fmtUsd(amount)}`}>
        <div className="absolute left-0 top-0 h-full rounded-full" style={{ width: `${fill}%`, background: color }} />
        {limitPos < 99.5 && <div className="absolute top-[-2px] h-[14px] w-px bg-ink-faint" style={{ left: `${limitPos}%` }} />}
        {marker != null && (
          <div className="absolute top-[-3px] h-4 w-0.5 rounded bg-ink" style={{ left: `calc(${marker}% - 1px)` }} />
        )}
      </div>
    </div>
  );
}
