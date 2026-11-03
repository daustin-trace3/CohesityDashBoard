import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, Link } from 'react-router-dom';
import {
  ShieldCheck, HardDrive, GitCommitVertical, Layers, X, CalendarClock, FileSignature, Unlink,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtDateUtcMs, fmtIsoDay } from './helpers';

const SECTIONS = ['arrays', 'versions', 'models', 'subscriptions', 'unmatched'];
const FILTER_KEYS = ['q', 'model', 'version', 'purity', 'hardware', 'contract', 'subscription'];
const EMPTY_FILTERS = { q: '', model: '', version: '', purity: '', hardware: '', contract: '', subscription: '' };

function readFilters(sp) {
  const f = {};
  for (const k of FILTER_KEYS) f[k] = sp.get(k) || '';
  return f;
}

const HW_BADGES = {
  past: { tone: 'crit', label: 'Past EOL' },
  approaching: { tone: 'warn', label: 'Approaching EOL' },
  ok: { tone: 'ok', label: 'ok' },
  unknown: { tone: 'neutral', label: 'No date' },
};
const PURITY_BADGES = {
  eol: { tone: 'crit', label: 'EOL' },
  approaching: { tone: 'warn', label: 'Approaching EOL' },
  supported: { tone: 'ok', label: 'Supported' },
  unknown: { tone: 'neutral', label: 'Not in table' },
};
const CONTRACT_BADGES = {
  expired: { tone: 'crit', label: 'Expired' },
  expiring: { tone: 'warn', label: 'Expiring' },
  ok: { tone: 'ok', label: 'ok' },
  unknown: { tone: 'neutral', label: 'No contract' },
};
const SUB_STATE_BADGES = CONTRACT_BADGES;
const WORST_RANK = { crit: 3, warn: 2, ok: 1, unknown: 0 };
const WORST_DOT = { crit: 'bg-status-crit', warn: 'bg-status-warn', ok: 'bg-status-ok', unknown: 'bg-ink-faint' };

function StateBadge({ map, state, className, title }) {
  const b = map[state] || map.unknown;
  return <span title={title || undefined}><Badge tone={b.tone} className={className}>{b.label}</Badge></span>;
}

// "N days left" or "N days ago" for a day count that may be null.
function daysNote(days, pastWord = 'ago') {
  if (days == null) return '';
  if (days < 0) return `${-days} days ${pastWord}`;
  return `${days} days left`;
}

function addressLine(a) {
  if (!a || typeof a !== 'object') return '';
  const street = a.street_address ?? a.streetAddress;
  const zip = a.postal_code ?? a.postalCode;
  return [street, a.city, a.state, zip, a.country].filter(Boolean).join(', ');
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Icon size={15} className="text-brand" /> {title}</p>
      {children}
    </div>
  );
}

function NavChip({ count, tone }) {
  if (!count) return null;
  const cls = tone === 'crit' ? 'bg-status-crit/15 text-status-crit'
    : tone === 'warn' ? 'bg-status-warn/15 text-status-warn'
    : 'bg-surface-overlay text-ink-faint';
  return <span className={`ml-auto tnum text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${cls}`}>{count}</span>;
}

function FilterChip({ label, onClear }) {
  return (
    <span className="chip bg-brand/10 text-brand border-brand/25">
      {label}
      <button onClick={onClear} aria-label={`Clear ${label}`} className="ml-1 text-brand/70 hover:text-brand cursor-pointer">
        <X size={10} />
      </button>
    </span>
  );
}

const SELECT_CLS = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer';

function FilterBar({ filters, setFilter, clearFilter, clearAll, options, matchedCount, totalCount }) {
  const chips = [];
  if (filters.q) chips.push({ k: 'q', label: `"${filters.q}"` });
  if (filters.model) chips.push({ k: 'model', label: `Model: ${filters.model}` });
  if (filters.version) chips.push({ k: 'version', label: `Purity: ${filters.version}` });
  if (filters.purity) chips.push({ k: 'purity', label: `Purity support: ${PURITY_BADGES[filters.purity]?.label || filters.purity}` });
  if (filters.hardware) chips.push({ k: 'hardware', label: `Hardware: ${HW_BADGES[filters.hardware]?.label || filters.hardware}` });
  if (filters.contract) chips.push({ k: 'contract', label: `Contract: ${CONTRACT_BADGES[filters.contract]?.label || filters.contract}` });
  if (filters.subscription) chips.push({ k: 'subscription', label: `Subscription: ${filters.subscription}` });

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
          placeholder="Search array, model, serial, version or subscription..."
          className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-sm text-ink focus:border-brand/60 outline-none"
        />
        <select value={filters.model} onChange={(e) => setFilter('model', e.target.value)} className={SELECT_CLS}>
          <option value="">All models</option>
          {options.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filters.version} onChange={(e) => setFilter('version', e.target.value)} className={SELECT_CLS}>
          <option value="">All Purity versions</option>
          {options.versions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={filters.purity} onChange={(e) => setFilter('purity', e.target.value)} className={SELECT_CLS}>
          <option value="">Any Purity support</option>
          {Object.entries(PURITY_BADGES).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
        </select>
        <select value={filters.hardware} onChange={(e) => setFilter('hardware', e.target.value)} className={SELECT_CLS}>
          <option value="">Any hardware state</option>
          {Object.entries(HW_BADGES).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
        </select>
        <select value={filters.contract} onChange={(e) => setFilter('contract', e.target.value)} className={SELECT_CLS}>
          <option value="">Any contract state</option>
          {Object.entries(CONTRACT_BADGES).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
        </select>
        <select value={filters.subscription} onChange={(e) => setFilter('subscription', e.target.value)} className={SELECT_CLS}>
          <option value="">All subscriptions</option>
          {options.subscriptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-[11px] text-ink-faint tnum ml-auto">
          {matchedCount === totalCount ? `${totalCount} rows` : `${matchedCount} of ${totalCount} rows`}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {chips.map((c) => <FilterChip key={c.k} label={c.label} onClear={() => clearFilter(c.k)} />)}
          <button onClick={clearAll} className="text-[11px] text-ink-faint hover:text-ink underline cursor-pointer">Clear all</button>
        </div>
      )}
    </div>
  );
}

function ModalShell({ title, subtitle, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-3xl max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate">{title}</p>
            {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function Fact({ label, children }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <div className="text-xs text-ink tnum">{children}</div>
    </div>
  );
}

function ArrayDetailModal({ row, onClose }) {
  const hw = row.hardware || {};
  const up = hw.upgrade;
  const addr = addressLine(hw.installAddress);
  const c = row.contract || {};
  const s = row.subscription;
  const l = row.license;
  const p = row.purity || {};
  return (
    <ModalShell title={row.name} subtitle={[row.model, row.fqdn, row.chassisSerial].filter(Boolean).join(' | ')} onClose={onClose}>
      <p className="text-xs font-semibold text-ink mb-2">Purity</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Version">{row.version || '-'}</Fact>
        <Fact label="Release line">{p.line ? `${p.line} (${p.kind === 'llr' ? 'long life' : p.kind || 'unknown'})` : '-'}</Fact>
        <Fact label="End of development">{fmtIsoDay(p.end_of_development)}</Fact>
        <Fact label="Support">
          <StateBadge map={PURITY_BADGES} state={p.phase} />
          {p.days_to_eol != null && <span className="ml-1.5 text-ink-faint">{daysNote(p.days_to_eol)}</span>}
        </Fact>
      </div>

      <p className="text-xs font-semibold text-ink mb-2">Hardware</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="End of life">{fmtDateUtcMs(hw.endOfLifeDate)}</Fact>
        <Fact label="State">
          <StateBadge map={HW_BADGES} state={hw.state} />
          {hw.daysToEol != null && <span className="ml-1.5 text-ink-faint">{daysNote(hw.daysToEol)}</span>}
        </Fact>
        <Fact label="Activation date">{fmtDateUtcMs(hw.activationDate)}</Fact>
        <Fact label="Customer">{hw.customerName || '-'}</Fact>
        <Fact label="Asset">{hw.assetName || hw.assetId || '-'}</Fact>
        <Fact label="Install address"><span className="whitespace-normal">{addr || '-'}</span></Fact>
        <Fact label="Health">{row.health || '-'}</Fact>
        <Fact label="OS">{row.os || '-'}</Fact>
      </div>
      {up && (up.actionNeeded || up.commitmentDate || up.eligibilityDate) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Fact label="Upgrade action">{up.actionNeeded || '-'}</Fact>
          <Fact label="Upgrade commitment">{fmtDateUtcMs(up.commitmentDate)}</Fact>
          <Fact label="Upgrade eligible">{fmtDateUtcMs(up.eligibilityDate)}</Fact>
        </div>
      )}

      <p className="text-xs font-semibold text-ink mb-2">Support contract</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Start">{fmtDateUtcMs(c.startDate)}</Fact>
        <Fact label="End">{fmtDateUtcMs(c.endDate)}</Fact>
        <Fact label="State">
          <StateBadge map={CONTRACT_BADGES} state={c.state} />
          {c.daysLeft != null && <span className="ml-1.5 text-ink-faint">{daysNote(c.daysLeft)}</span>}
        </Fact>
      </div>

      <p className="text-xs font-semibold text-ink mb-2">Subscription and license</p>
      {s ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Fact label="Subscription">{s.name || s.id}</Fact>
          <Fact label="Service">{s.service || '-'}</Fact>
          <Fact label="Tier">{s.serviceTier || '-'}</Fact>
          <Fact label="SLA">{s.serviceSla || '-'}</Fact>
          <Fact label="Status">{s.status || '-'}</Fact>
          <Fact label="Start">{fmtDateUtcMs(s.startDate)}</Fact>
          <Fact label="Expiration">{fmtDateUtcMs(s.expirationDate)}</Fact>
          <Fact label="State">
            <StateBadge map={SUB_STATE_BADGES} state={s.state} />
            {s.daysLeft != null && <span className="ml-1.5 text-ink-faint">{daysNote(s.daysLeft)}</span>}
          </Fact>
          <Fact label="Term">{s.term != null ? `${s.term} months` : '-'}</Fact>
        </div>
      ) : (
        <p className="text-xs text-ink-muted mb-3">No subscription on record for this array.</p>
      )}
      {l && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Fact label="License">{l.name || l.id}</Fact>
          <Fact label="Tier">{l.serviceTier || '-'}</Fact>
          <Fact label="Start">{fmtDateUtcMs(l.startDate)}</Fact>
          <Fact label="Expiration">
            {fmtDateUtcMs(l.expirationDate)}
            {l.daysLeft != null && <span className="ml-1.5 text-ink-faint">{daysNote(l.daysLeft)}</span>}
          </Fact>
        </div>
      )}
      <Link to="/pure/hardware" className="text-xs text-brand hover:underline">View in Pure Hardware &rsaquo;</Link>
    </ModalShell>
  );
}

function flattenArray(a) {
  const hw = a.hardware || {};
  const c = a.contract || {};
  const s = a.subscription || null;
  const p = a.purity || {};
  return {
    ...a,
    purityPhase: p.phase || 'unknown',
    purityEnd: p.end_of_development || null,
    hwState: hw.state || 'unknown',
    hwEol: hw.endOfLifeDate ?? null,
    contractState: c.state || 'unknown',
    contractEnd: c.endDate ?? null,
    subName: s?.name || '',
    subExpiration: s?.expirationDate ?? null,
    worstRank: WORST_RANK[a.worst] ?? 0,
  };
}

export default function PureGovernancePage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [filters, setFiltersState] = useState(() => readFilters(searchParams));

  const rawSection = searchParams.get('section');
  const section = SECTIONS.includes(rawSection) ? rawSection : 'arrays';

  // A failed request and an answer of the wrong shape are errors, never an
  // empty estate (a backend on older code answers unknown /api paths with 404
  // JSON, or the app shell on very old builds).
  const load = useCallback(() => client.get('/pure1/governance', { params: { _: Date.now() } })
    .then(({ data }) => {
      if (!data || typeof data !== 'object' || !Array.isArray(data.arrays)) {
        setData({});
        setLoadError('The server did not return governance data. The dashboard service is probably still running the previous version and needs a restart.');
        return;
      }
      setLoadError(null);
      setData(data);
      setLastRefreshed(new Date());
    })
    .catch((err) => {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message || 'request failed';
      setData({});
      setLoadError(`Could not load governance data${status ? ` (HTTP ${status})` : ''}: ${detail}`);
      toast({ type: 'error', title: 'Failed to load governance data' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('section', section);
      for (const k of FILTER_KEYS) {
        if (filters[k]) next.set(k, filters[k]); else next.delete(k);
      }
      return next;
    }, { replace: true });
  }, [section, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSection = (id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('section', id);
      return next;
    }, { replace: true });
  };

  const setFilter = (k, v) => setFiltersState((f) => ({ ...f, [k]: v }));
  const clearFilter = (k) => setFiltersState((f) => ({ ...f, [k]: '' }));
  const clearAll = () => setFiltersState({ ...EMPTY_FILTERS });

  const jumpToVersion = (version) => { setFiltersState((f) => ({ ...f, version })); setSection('arrays'); };
  const jumpToModel = (model) => { setFiltersState((f) => ({ ...f, model })); setSection('arrays'); };
  const jumpToSubscription = (name) => { setFiltersState((f) => ({ ...f, subscription: name })); setSection('arrays'); };

  const summary = data?.summary || null;
  const thresholds = data?.thresholds || null;
  const versions = data?.versions || [];
  const models = data?.models || [];
  const subscriptions = data?.subscriptions || [];
  const unmatched = data?.assetsUnmatched || [];

  const rows = useMemo(() => (data?.arrays || []).map(flattenArray), [data]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const options = useMemo(() => ({
    models: [...new Set(rows.map((r) => r.model).filter(Boolean))].sort(),
    versions: [...new Set(rows.map((r) => r.version).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    subscriptions: [...new Set(rows.map((r) => r.subName).filter(Boolean))].sort(),
  }), [rows]);

  const term = filters.q.trim().toLowerCase();
  const filteredRows = useMemo(() => rows.filter((r) => {
    if (filters.model && r.model !== filters.model) return false;
    if (filters.version && r.version !== filters.version) return false;
    if (filters.purity && r.purityPhase !== filters.purity) return false;
    if (filters.hardware && r.hwState !== filters.hardware) return false;
    if (filters.contract && r.contractState !== filters.contract) return false;
    if (filters.subscription && r.subName !== filters.subscription) return false;
    if (term) {
      const hay = [r.name, r.fqdn, r.model, r.chassisSerial, r.version, r.subName, r.subscription?.service, r.hardware?.customerName];
      if (!hay.some((v) => String(v || '').toLowerCase().includes(term))) return false;
    }
    return true;
  }), [rows, filters, term]);

  const arrayCtl = useTableControls(filteredRows, {
    defaultSortKey: 'worstRank',
    defaultSortDir: 'desc',
    paginate: true,
    deepLink: false,
  });

  const nav = [
    { id: 'arrays', label: 'Arrays', icon: HardDrive,
      count: rows.filter((r) => r.worst === 'crit' || r.worst === 'warn').length,
      tone: rows.some((r) => r.worst === 'crit') ? 'crit' : 'warn' },
    { id: 'versions', label: 'Purity versions', icon: GitCommitVertical,
      count: (summary?.purityEol || 0) + (summary?.purityApproaching || 0), tone: summary?.purityEol ? 'crit' : 'warn' },
    { id: 'models', label: 'Models', icon: Layers,
      count: (summary?.hwEolPast || 0) + (summary?.hwEolApproaching || 0), tone: summary?.hwEolPast ? 'crit' : 'warn' },
    { id: 'subscriptions', label: 'Subscriptions', icon: FileSignature,
      count: summary?.subscriptionsExpiring || 0, tone: 'warn' },
    ...(unmatched.length > 0 ? [{ id: 'unmatched', label: 'Unmatched assets', icon: Unlink, count: unmatched.length, tone: 'default' }] : []),
  ];
  const activeSection = nav.some((n) => n.id === section) ? section : 'arrays';

  const detailRow = detailId ? rowById.get(detailId) : null;

  const header = (children) => (
    <PageHeader icon={ShieldCheck} title="Pure Governance"
      description="Hardware end of life, support contracts, subscriptions and Purity code levels across the Pure1 fleet">
      {children}
    </PageHeader>
  );

  if (data == null) {
    return (
      <div className="animate-fade-in">
        {header(null)}
        <LoadingPanel label="Loading governance..." height={300} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="animate-fade-in">
        {header(<RefreshButton onClick={load} />)}
        <div className="panel p-8 text-center text-sm text-status-crit" style={{ borderTop: `3px solid ${BRAND}` }}>
          {loadError}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="animate-fade-in">
        {header(<RefreshButton onClick={load} />)}
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No Pure1 arrays. Configure Pure1 under <Link to="/pure/settings" className="text-brand hover:underline">Settings</Link>.
        </div>
      </div>
    );
  }

  const hwSub = thresholds ? `${summary?.hwEolApproaching ?? 0} within ${thresholds.hwEolWarnDays} days, ${summary?.hwEolUnknown ?? 0} with no date` : undefined;
  const contractSub = thresholds ? `${summary?.contractsExpiring ?? 0} within ${thresholds.contractWarnDays} days, ${summary?.contractsUnknown ?? 0} with none` : undefined;
  const purityEolSub = thresholds ? `${summary?.purityApproaching ?? 0} within ${thresholds.purityEolWarnDays} days, ${summary?.purityUnknown ?? 0} not in table` : undefined;

  return (
    <div className="animate-fade-in">
      {header(<>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </>)}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={HardDrive} label="Arrays" value={fmtNum(summary?.arrays)} tone="brand" />
        <StatCard icon={CalendarClock} label="Hardware past EOL" value={fmtNum(summary?.hwEolPast)}
          tone={summary?.hwEolPast > 0 ? 'crit' : 'default'} sub={hwSub} />
        <StatCard icon={FileSignature} label="Contracts expired" value={fmtNum(summary?.contractsExpired)}
          tone={summary?.contractsExpired > 0 ? 'crit' : 'default'} sub={contractSub} />
        <StatCard icon={GitCommitVertical} label="Purity past EOL" value={fmtNum(summary?.purityEol)}
          tone={summary?.purityEol > 0 ? 'crit' : 'default'} sub={purityEolSub} />
        <StatCard icon={Layers} label="Subscriptions" value={fmtNum(summary?.subscriptions)}
          tone={summary?.subscriptionsExpiring > 0 ? 'warn' : 'default'}
          sub={`${summary?.subscriptionsExpiring ?? 0} expiring soon`} />
      </div>

      <div className="flex gap-4 items-start">
        <div className="panel p-2 w-52 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSection(n.id)}
              className={`flex items-center gap-2 w-full text-left text-xs rounded-lg px-2.5 py-2 transition-colors cursor-pointer ${
                activeSection === n.id ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay/60'
              }`}
            >
              <n.icon size={14} className={activeSection === n.id ? 'text-brand' : 'text-ink-faint'} />
              <span className="truncate">{n.label}</span>
              <NavChip count={n.count} tone={n.tone} />
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {activeSection === 'arrays' && (
            <Section icon={HardDrive} title="Arrays">
              <FilterBar filters={filters} setFilter={setFilter} clearFilter={clearFilter} clearAll={clearAll}
                options={options} matchedCount={filteredRows.length} totalCount={rows.length} />
              <div className="flex justify-end mb-2">
                <CsvExportButton filename="pure-governance-arrays" rows={arrayCtl.rows} columns={[
                  { label: 'Array', get: 'name' }, { label: 'Model', get: 'model' }, { label: 'Serial', get: 'chassisSerial' },
                  { label: 'Purity version', get: 'version' },
                  { label: 'Purity support', get: 'purityPhase' },
                  { label: 'Purity end of development', get: 'purityEnd' },
                  { label: 'Hardware state', get: 'hwState' },
                  { label: 'Hardware EOL', get: (r) => r.hwEol ? new Date(r.hwEol).toISOString().slice(0, 10) : '' },
                  { label: 'Hardware days to EOL', get: (r) => r.hardware?.daysToEol },
                  { label: 'Contract state', get: 'contractState' },
                  { label: 'Contract end', get: (r) => r.contractEnd ? new Date(r.contractEnd).toISOString().slice(0, 10) : '' },
                  { label: 'Contract days left', get: (r) => r.contract?.daysLeft },
                  { label: 'Subscription', get: 'subName' },
                  { label: 'Service', get: (r) => r.subscription?.service },
                  { label: 'Tier', get: (r) => r.subscription?.serviceTier },
                  { label: 'Subscription expiration', get: (r) => r.subExpiration ? new Date(r.subExpiration).toISOString().slice(0, 10) : '' },
                  { label: 'Subscription days left', get: (r) => r.subscription?.daysLeft },
                  { label: 'Overall', get: 'worst' },
                ]} />
              </div>
              {arrayCtl.rows.length === 0 ? (
                <div className="text-sm text-ink-muted py-8 text-center">No arrays match your filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-2 w-4" />
                      <SortTh k="name" label="Array" ctl={arrayCtl} />
                      <SortTh k="model" label="Model" ctl={arrayCtl} />
                      <SortTh k="version" label="Purity" ctl={arrayCtl} />
                      <SortTh k="hwEol" label="Hardware EOL" ctl={arrayCtl} />
                      <SortTh k="contractEnd" label="Support contract" ctl={arrayCtl} />
                      <SortTh k="subExpiration" label="Subscription" ctl={arrayCtl} />
                    </tr></thead>
                    <tbody>
                      {arrayCtl.pageRows.map((r) => (
                        <tr key={r.id} onClick={() => setDetailId(r.id)}
                          className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors align-top">
                          <td className="py-2 pr-2"><span className={`inline-block h-2 w-2 rounded-full ${WORST_DOT[r.worst] || WORST_DOT.unknown}`} title={r.worst} /></td>
                          <td className="py-2 pr-3 text-ink font-medium">{r.name}</td>
                          <td className="py-2 pr-3 text-ink-muted">{r.model || '-'}</td>
                          <td className="py-2 pr-3">
                            <span className="text-ink-muted tnum">{r.version || '-'}</span>
                            <StateBadge map={PURITY_BADGES} state={r.purityPhase} className="ml-1.5"
                              title={r.purity?.end_of_development ? `End of development ${r.purity.end_of_development}` : ''} />
                            {r.purityEnd && <div className="text-[11px] text-ink-faint tnum">{fmtIsoDay(r.purityEnd)}</div>}
                          </td>
                          <td className="py-2 pr-3">
                            <span className="text-ink-muted tnum">{fmtDateUtcMs(r.hwEol)}</span>
                            <StateBadge map={HW_BADGES} state={r.hwState} className="ml-1.5" />
                            {r.hardware?.daysToEol != null && <div className="text-[11px] text-ink-faint">{daysNote(r.hardware.daysToEol)}</div>}
                          </td>
                          <td className="py-2 pr-3">
                            <span className="text-ink-muted tnum">{fmtDateUtcMs(r.contractEnd)}</span>
                            {r.contractState !== 'ok' && <StateBadge map={CONTRACT_BADGES} state={r.contractState} className="ml-1.5" />}
                            {r.contract?.daysLeft != null && <div className="text-[11px] text-ink-faint">{daysNote(r.contract.daysLeft)}</div>}
                          </td>
                          <td className="py-2 pr-3">
                            {r.subscription ? (
                              <>
                                <span className="text-ink">{r.subscription.name || r.subscription.id}</span>
                                <div className="text-[11px] text-ink-faint">
                                  {[r.subscription.service, r.subscription.serviceTier].filter(Boolean).join(' | ') || '-'}
                                </div>
                                <div className="text-[11px] text-ink-faint tnum">
                                  {fmtDateUtcMs(r.subExpiration)}{r.subscription.daysLeft != null ? ` (${daysNote(r.subscription.daysLeft)})` : ''}
                                  {r.subscription.state && r.subscription.state !== 'ok' && <StateBadge map={SUB_STATE_BADGES} state={r.subscription.state} className="ml-1.5" />}
                                </div>
                              </>
                            ) : <span className="text-ink-faint">-</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <TablePager ctl={arrayCtl} />
            </Section>
          )}

          {activeSection === 'versions' && (
            <Section icon={GitCommitVertical} title="Purity versions">
              {versions.length > 0 && (
                <div className="flex justify-end mb-2">
                  <CsvExportButton filename="pure-governance-purity-versions" rows={versions} columns={[
                    { label: 'Version', get: 'version' },
                    { label: 'Release line', get: (v) => v.purity?.line },
                    { label: 'Kind', get: (v) => v.purity?.kind },
                    { label: 'Support', get: (v) => v.purity?.phase },
                    { label: 'End of development', get: (v) => v.purity?.end_of_development },
                    { label: 'Days to EOL', get: (v) => v.purity?.days_to_eol },
                    { label: 'Arrays', get: 'count' },
                  ]} />
                </div>
              )}
              {versions.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">No version data.</p>
              ) : (
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Version</th>
                      <th className="py-2 pr-3">Release line</th>
                      <th className="py-2 pr-3">Support</th>
                      <th className="py-2 pr-3">End of development</th>
                      <th className="py-2 pr-3 text-right">Arrays</th>
                    </tr></thead>
                    <tbody>
                      {versions.map((v) => (
                        <tr key={v.version} onClick={() => jumpToVersion(v.version)}
                          className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                          <td className="py-2 pr-3 text-ink tnum font-medium">{v.version}</td>
                          <td className="py-2 pr-3 text-ink-muted tnum">
                            {v.purity?.line || '-'}{v.purity?.kind ? <span className="text-ink-faint text-[11px] ml-1.5">{v.purity.kind === 'llr' ? 'long life' : v.purity.kind}</span> : null}
                          </td>
                          <td className="py-2 pr-3">
                            <StateBadge map={PURITY_BADGES} state={v.purity?.phase} />
                            {v.purity?.days_to_eol != null && v.purity.phase !== 'unknown' && <div className="text-[11px] text-ink-faint">{daysNote(v.purity.days_to_eol)}</div>}
                          </td>
                          <td className="py-2 pr-3 text-ink-muted tnum">{fmtIsoDay(v.purity?.end_of_development)}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-ink-faint">
                Purity has no end of life field in the Pure1 API. A release line counts as end of life the day after its end of development date.
              </p>
            </Section>
          )}

          {activeSection === 'models' && (
            <Section icon={Layers} title="Models">
              {models.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">No model data.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Model</th>
                      <th className="py-2 pr-3 text-right">Arrays</th>
                      <th className="py-2 pr-3">Earliest hardware EOL</th>
                      <th className="py-2 pr-3 text-right">Past EOL</th>
                      <th className="py-2 pr-3 text-right">Approaching</th>
                    </tr></thead>
                    <tbody>
                      {models.map((m) => (
                        <tr key={m.model} onClick={() => jumpToModel(m.model)}
                          className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                          <td className="py-2 pr-3 text-ink font-medium">{m.model}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{m.count}</td>
                          <td className="py-2 pr-3 text-ink-muted tnum">{fmtDateUtcMs(m.earliestEol)}</td>
                          <td className="py-2 pr-3 text-right tnum">{m.pastEol > 0 ? <Badge tone="crit">{m.pastEol}</Badge> : <span className="text-ink-faint">0</span>}</td>
                          <td className="py-2 pr-3 text-right tnum">{m.approaching > 0 ? <Badge tone="warn">{m.approaching}</Badge> : <span className="text-ink-faint">0</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          )}

          {activeSection === 'subscriptions' && (
            <Section icon={FileSignature} title="Subscriptions">
              {subscriptions.length === 0 ? (
                <p className="text-sm text-ink-muted py-4 text-center">No subscriptions reported by Pure1.</p>
              ) : (
                <>
                  <div className="flex justify-end mb-2">
                    <CsvExportButton filename="pure-governance-subscriptions" rows={subscriptions} columns={[
                      { label: 'Subscription', get: 'name' }, { label: 'Service', get: 'service' }, { label: 'Tier', get: 'serviceTier' },
                      { label: 'SLA', get: 'serviceSla' }, { label: 'Status', get: 'status' },
                      { label: 'Start', get: (s) => s.startDate ? new Date(s.startDate).toISOString().slice(0, 10) : '' },
                      { label: 'Expiration', get: (s) => s.expirationDate ? new Date(s.expirationDate).toISOString().slice(0, 10) : '' },
                      { label: 'Days left', get: 'daysLeft' }, { label: 'Term (months)', get: 'term' },
                      { label: 'Customer', get: 'customerName' }, { label: 'Partner', get: 'partnerName' },
                      { label: 'Arrays', get: 'arrayCount' }, { label: 'Licenses', get: 'licenseCount' },
                    ]} />
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-2 pr-3">Subscription</th>
                        <th className="py-2 pr-3">Service</th>
                        <th className="py-2 pr-3">Tier</th>
                        <th className="py-2 pr-3">SLA</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Start</th>
                        <th className="py-2 pr-3">Expiration</th>
                        <th className="py-2 pr-3 text-right">Arrays</th>
                        <th className="py-2 pr-3 text-right">Licenses</th>
                      </tr></thead>
                      <tbody>
                        {subscriptions.map((s) => (
                          <tr key={s.id} onClick={() => s.name && jumpToSubscription(s.name)}
                            className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                            <td className="py-2 pr-3 text-ink font-medium">{s.name || s.id}{s.customerName && <div className="text-[11px] text-ink-faint font-normal">{s.customerName}</div>}</td>
                            <td className="py-2 pr-3 text-ink-muted">{s.service || '-'}</td>
                            <td className="py-2 pr-3 text-ink-muted">{s.serviceTier || '-'}</td>
                            <td className="py-2 pr-3 text-ink-muted">{s.serviceSla || '-'}</td>
                            <td className="py-2 pr-3 text-ink-muted">{s.status || '-'}</td>
                            <td className="py-2 pr-3 text-ink-muted tnum">{fmtDateUtcMs(s.startDate)}</td>
                            <td className="py-2 pr-3 text-ink-muted tnum">
                              {fmtDateUtcMs(s.expirationDate)}
                              {s.daysLeft != null && <div className="text-[11px] text-ink-faint">{daysNote(s.daysLeft)}</div>}
                            </td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.arrayCount}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.licenseCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Section>
          )}

          {activeSection === 'unmatched' && (
            <Section icon={Unlink} title="Unmatched assets">
              <p className="text-[11px] text-ink-faint mb-3">
                Pure1 subscription assets that ICC could not match to an array by chassis serial or name.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">Asset</th>
                    <th className="py-2 pr-3">Model</th>
                    <th className="py-2 pr-3">Purity</th>
                    <th className="py-2 pr-3">Chassis serial</th>
                    <th className="py-2 pr-3">Hardware EOL</th>
                    <th className="py-2 pr-3">Subscription</th>
                  </tr></thead>
                  <tbody>
                    {unmatched.map((u) => (
                      <tr key={u.assetId} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink">{u.name || u.assetId}</td>
                        <td className="py-2 pr-3 text-ink-muted">{u.model || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{u.version || '-'}</td>
                        <td className="py-2 pr-3 text-ink-faint tnum">{u.chassisSerial || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{fmtDateUtcMs(u.endOfLifeDate)}</td>
                        <td className="py-2 pr-3 text-ink-muted">{u.subscriptionName || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-1 text-[11px] text-ink-faint">
        {data.purityTable && (
          <p>
            Purity dates: {data.purityTable.source}{data.purityTable.captured ? `, captured ${data.purityTable.captured}` : ''}.
            {data.purityTable.note ? ` ${data.purityTable.note}` : ''}
          </p>
        )}
        <p>
          Hardware EOL, contract and subscription dates come from Pure1 subscription assets, support contracts and
          subscriptions as of {data.asOf ? new Date(data.asOf).toLocaleString() : 'an unknown time'}.
        </p>
      </div>

      {detailRow && <ArrayDetailModal row={detailRow} onClose={() => setDetailId(null)} />}
    </div>
  );
}
