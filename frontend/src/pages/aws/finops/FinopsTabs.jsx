import { NavLink } from 'react-router-dom';

const TABS = [
  { label: 'Spend', to: '/aws/finops', end: true },
  { label: 'Cost Explorer', to: '/aws/cost' },
  { label: 'Allocation', to: '/aws/finops/allocation' },
  { label: 'Resources', to: '/aws/finops/resources' },
  { label: 'Commitments', to: '/aws/finops/commitments' },
  { label: 'Anomalies', to: '/aws/finops/anomalies' },
  { label: 'Budgets', to: '/aws/finops/budgets' },
  { label: 'Optimizer', to: '/aws/optimizer' },
  { label: 'Unit Economics', to: '/aws/finops/unit-economics' },
];

export default function FinopsTabs() {
  return (
    <nav role="tablist" aria-label="FinOps" className="flex items-end gap-1 overflow-x-auto border-b border-cohesity-border mb-4">
      {TABS.map(t => (
        <NavLink key={t.to} to={t.to} end={t.end} role="tab"
          className={({ isActive }) => `whitespace-nowrap px-3 py-2 -mb-px text-xs font-medium border-b-2 transition-colors ${
            isActive ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}>
          {({ isActive }) => <span aria-selected={isActive}>{t.label}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
