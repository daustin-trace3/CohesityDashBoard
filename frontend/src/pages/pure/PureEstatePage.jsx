import { useEffect, useState, useCallback, useMemo } from 'react';
import { LayoutList, Search, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum, fmtRatio, severityTone } from './helpers';

const HEALTH = {
  ok: { label: 'Healthy', tone: 'ok' },
  warn: { label: 'Attention', tone: 'warn' },
  crit: { label: 'Critical', tone: 'crit' },
};
const healthMeta = (h) => HEALTH[h] || { label: 'Unknown', tone: 'neutral' };

function toCsv(rows) {
  const cols = [
    ['Name', (r) => r.name],
    ['Serial', (r) => r.serial || ''],
    ['Controller serials', (r) => (r.controllerSerials || []).join(' ')],
    ['Model', (r) => r.model || ''],
    ['Purity', (r) => r.version || ''],
    ['Status', (r) => healthMeta(r.health).label],
    ['Capacity (TB)', (r) => (r.total ? (r.total / 1e12).toFixed(2) : '')],
    ['Used (TB)', (r) => (r.used ? (r.used / 1e12).toFixed(2) : '')],
    ['Free (TB)', (r) => (r.free != null ? (r.free / 1e12).toFixed(2) : '')],
    ['% Full', (r) => (r.pctUsed != null ? r.pctUsed.toFixed(1) : '')],
    ['Data reduction', (r) => (r.dataReduction ? r.dataReduction.toFixed(2) : '')],
    ['Provisioned (TB)', (r) => (r.provisioned ? (r.provisioned / 1e12).toFixed(2) : '')],
    ['Over-subscription', (r) => (r.oversub != null ? r.oversub.toFixed(2) : '')],
    ['Open alerts', (r) => r.alertCount || 0],
    ['Tags', (r) => r.tagStr],
    ['FQDN', (r) => r.fqdn || ''],
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => c[0]).join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(c[1](r))).join(','));
  return lines.join('\n');
}

export default function PureEstatePage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [enrichment, setEnrichment] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState(null);
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback((force = false) => {
    const suffix = force ? '?refresh=1' : '';
    return Promise.allSettled([
      client.get(`/pure1/overview${suffix}`),
      client.get(`/pure1/enrichment${suffix}`),
      client.get(`/pure1/alerts${suffix}`),
      client.get('/pure1/status'),
    ]).then(([o, e, a, s]) => {
      if (o.status === 'fulfilled') setRows(o.value.data); else { setRows([]); toast({ type: 'error', title: 'Failed to load estate' }); }
      if (e.status === 'fulfilled') setEnrichment(e.value.data || {});
      if (a.status === 'fulfilled') setAlerts(a.value.data || []);
      if (s.status === 'fulfilled') setStatus(s.value.data);
    });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const hardRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
    setLastRefreshed(new Date());
    toast({ type: 'success', title: 'Estate data refreshed' });
  };

  const alertsByArray = useMemo(() => {
    const rank = (s) => ({ critical: 3, warning: 2 }[String(s || '').toLowerCase()] || 1);
    const m = new Map();
    for (const a of alerts) {
      if (String(a.severity || '').toLowerCase() === 'hidden' && !(status && status.showHiddenAlerts)) continue;
      if (!a.arrayName) continue;
      const cur = m.get(a.arrayName) || { count: 0, worst: 'info' };
      cur.count += 1;
      if (rank(a.severity) > rank(cur.worst)) cur.worst = a.severity;
      m.set(a.arrayName, cur);
    }
    return m;
  }, [alerts, status]);

  const estate = useMemo(() => (rows || []).map((r) => {
    const en = enrichment[r.id] || {};
    const al = alertsByArray.get(r.name);
    return {
      ...r,
      serial: en.chassisSerial || null,
      controllerSerials: en.controllerSerials || [],
      health: en.health || null,
      unhealthy: en.unhealthy || 0,
      provisioned: en.provisioned || 0,
      oversub: r.total ? (en.provisioned || 0) / r.total : null,
      free: (r.total != null && r.used != null) ? Math.max(0, r.total - r.used) : null,
      alertCount: al ? al.count : 0,
      alertWorst: al ? al.worst : null,
      tagStr: (r.tags || []).map((t) => `${t.key}=${t.value}`).join('; '),
    };
  }), [rows, enrichment, alertsByArray]);

  const models = useMemo(() => [...new Set(estate.map((r) => r.model).filter(Boolean))].sort(), [estate]);
  const allTags = useMemo(() => {
    const s = new Set();
    for (const r of estate) for (const t of (r.tags || [])) s.add(`${t.key}=${t.value}`);
    return [...s].sort();
  }, [estate]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = estate.filter((r) => {
      const hay = [r.name, r.serial, r.model, r.version, r.fqdn, r.tagStr, ...(r.controllerSerials || [])];
      const matchesText = !needle || hay.some((v) => String(v || '').toLowerCase().includes(needle));
      const matchesTag = !tagFilter || (r.tags || []).some((t) => `${t.key}=${t.value}` === tagFilter);
      const matchesModel = !modelFilter || r.model === modelFilter;
      const matchesStatus = !statusFilter || (r.health || 'unknown') === statusFilter;
      return matchesText && matchesTag && matchesModel && matchesStatus;
    });
    const { key, dir } = sort;
    list = [...list].sort((a, b) => {
      const va = a[key], vb = b[key];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((va || 0) - (vb || 0)) * dir;
    });
    return list;
  }, [estate, q, tagFilter, modelFilter, statusFilter, sort]);

  const totals = useMemo(() => {
    const t = filtered.reduce((s, r) => s + (r.total || 0), 0);
    const u = filtered.reduce((s, r) => s + (r.used || 0), 0);
    return { total: t, used: u, free: Math.max(0, t - u), attention: filtered.filter((r) => r.health && r.health !== 'ok').length };
  }, [filtered]);

  const setSortKey = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }));
  const Th = ({ k, children, right }) => (
    <th className={`py-2 pr-3 ${right ? 'text-right' : 'text-left'} cursor-pointer select-none hover:text-ink whitespace-nowrap`} onClick={() => setSortKey(k)}>
      {children}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const exportCsv = () => {
    const csv = toCsv(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pure-estate-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ type: 'success', title: `Exported ${filtered.length} arrays` });
  };

  const clearFilters = () => { setQ(''); setTagFilter(''); setModelFilter(''); setStatusFilter(''); };
  const anyFilter = q || tagFilter || modelFilter || statusFilter;
  const selCls = 'bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg px-2 py-1.5 focus:border-brand/60';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={LayoutList} title="Pure Estate Overview" description="Every Pure array — serials, versions, capacity, health — on one filterable page">
        <div className="flex items-center gap-2">
          <LastUpdated date={lastRefreshed} prefix="Updated" />
          <button onClick={exportCsv} disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
            <Download size={15} /> Export CSV
          </button>
          <RefreshButton onClick={hardRefresh} refreshing={refreshing} />
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={LayoutList} label="Arrays (filtered)" value={fmtNum(filtered.length)} tone="brand" />
        <StatCard icon={LayoutList} label="Total Capacity" value={fmtBytes(totals.total)} />
        <StatCard icon={LayoutList} label="Used / Free" value={`${fmtBytes(totals.used)} / ${fmtBytes(totals.free)}`} />
        <StatCard icon={LayoutList} label="Needs Attention" value={fmtNum(totals.attention)} tone={totals.attention > 0 ? 'warn' : 'ok'} />
      </div>

      {/* Filters */}
      <div className="panel p-3 mb-4 flex flex-wrap items-center gap-2" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, serial, model, version, tag…"
            className="w-full bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg pl-9 pr-3 py-1.5 placeholder-ink-faint focus:border-brand/60" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selCls}>
          <option value="">All statuses</option>
          <option value="ok">Healthy</option>
          <option value="warn">Attention</option>
          <option value="crit">Critical</option>
        </select>
        {models.length > 1 && (
          <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} className={selCls}>
            <option value="">All models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {allTags.length > 0 && (
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className={`${selCls} max-w-[200px]`}>
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t.replace('=', ': ')}</option>)}
          </select>
        )}
        {anyFilter && <button onClick={clearFilters} className="text-[12px] text-ink-muted hover:text-ink px-2 py-1">Clear</button>}
      </div>

      {/* Estate table */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {rows == null ? (
          <LoadingPanel label="Loading estate…" height={240} />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-muted py-10 text-center">No arrays match the filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface z-10"><tr className="text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <Th k="health">Status</Th><Th k="name">Array</Th><Th k="serial">Serial</Th><Th k="model">Model</Th><Th k="version">Purity</Th>
                <Th k="total" right>Capacity</Th><Th k="used" right>Used</Th><Th k="free" right>Free</Th><Th k="pctUsed" right>% Full</Th>
                <Th k="dataReduction" right>Reduction</Th><Th k="provisioned" right>Provisioned</Th><Th k="alertCount" right>Alerts</Th>
                <th className="py-2 pr-3 text-left">FQDN</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => {
                  const hm = healthMeta(r.health);
                  return (
                    <tr key={r.id} className="border-b border-cohesity-border/50 hover:bg-surface-overlay/40">
                      <td className="py-2 pr-3"><Badge tone={hm.tone}>{hm.label}</Badge></td>
                      <td className="py-2 pr-3">
                        <div className="text-ink font-medium">{r.name}</div>
                        {r.tags && r.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {r.tags.slice(0, 3).map((t, i) => (
                              <span key={i} className="inline-block px-1.5 py-px rounded text-[10px] bg-surface-overlay border border-cohesity-border text-ink-faint">{t.key}: {t.value}</span>
                            ))}
                            {r.tags.length > 3 && <span className="text-[10px] text-ink-faint self-center">+{r.tags.length - 3}</span>}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted font-mono text-[11px]" title={(r.controllerSerials || []).length ? `Controllers: ${(r.controllerSerials || []).join(', ')}` : ''}>{r.serial || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.model || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{r.version || '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.total)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.used)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.free)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.pctUsed != null ? `${r.pctUsed.toFixed(0)}%` : '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(r.dataReduction)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.provisioned ? fmtBytes(r.provisioned) : '—'}{r.oversub ? <span className="text-ink-faint"> ({r.oversub.toFixed(1)}×)</span> : ''}</td>
                      <td className="py-2 pr-3 text-right">{r.alertCount ? <Badge tone={severityTone(r.alertWorst)}>{r.alertCount}</Badge> : <span className="text-ink-faint">—</span>}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px]">{r.fqdn || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-ink-faint mt-2">{filtered.length} of {estate.length} arrays{anyFilter ? ' (filtered)' : ''}. Click a column header to sort.</p>
      </div>
    </div>
  );
}
