import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Layers, FileText, Search } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Spinner } from '../../components/ui/primitives';
import { useTableControls, SortTh } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
const btnGhost = 'px-3 py-2 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5';

const RR_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR', 'NAPTR', 'HINFO', 'HTTPS', 'SVCB', 'URI', 'GENERIC'];

export default function BluecatDnsPage() {
  const { toast } = useToast();
  const [views, setViews] = useState(null);
  const [zones, setZones] = useState(null);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [zoneSearch, setZoneSearch] = useState('');
  const [q, setQ] = useState('');
  const [rrType, setRrType] = useState('');
  const [records, setRecords] = useState(null);
  const [total, setTotal] = useState(0);
  const [limited, setLimited] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [lookup, setLookup] = useState(null);
  const [lookingUp, setLookingUp] = useState(false);

  const loadViews = useCallback(() => client.get('/bluecat/views')
    .then(({ data }) => setViews(Array.isArray(data) ? data : []))
    .catch(() => setViews([])), []);

  const loadZones = useCallback(() => {
    const params = {};
    if (selectedViewId) params.viewId = selectedViewId;
    if (zoneSearch.trim()) params.q = zoneSearch.trim();
    return client.get('/bluecat/zones', { params })
      .then(({ data }) => setZones(Array.isArray(data) ? data : []))
      .catch(() => setZones([]));
  }, [selectedViewId, zoneSearch]);

  const loadRecords = useCallback(() => {
    const params = { limit: 200 };
    if (q.trim()) params.q = q.trim();
    if (rrType) params.rrType = rrType;
    if (selectedViewId) params.viewId = selectedViewId;
    if (selectedZoneId) params.zoneId = selectedZoneId;
    return client.get('/bluecat/records', { params })
      .then(({ data }) => {
        setRecords(Array.isArray(data?.records) ? data.records : []);
        setTotal(data?.total ?? 0);
        setLimited(!!data?.limited);
        setLastRefreshed(new Date());
      })
      .catch(() => { setRecords([]); setTotal(0); setLimited(false); toast({ type: 'error', title: 'Failed to load records' }); });
  }, [q, rrType, selectedViewId, selectedZoneId, toast]);

  useEffect(() => { loadViews(); }, [loadViews]);
  useEffect(() => { loadZones(); }, [loadZones]);
  useEffect(() => { loadRecords(); }, [loadRecords]);

  const ipSortValue = (ip) => {
    const parts = String(ip || '').split('.').map(Number);
    return parts.length === 4 && parts.every((n) => Number.isInteger(n)) ? ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3] : null;
  };
  const ctl = useTableControls(records || [], {
    defaultSortKey: 'absoluteName', defaultSortDir: 'asc',
    sortValues: {
      ip: (r) => ipSortValue(r.ip),
      networkRange: (r) => (r.network ? ipSortValue(r.network.range.split('/')[0]) : null),
    },
  });

  const liveLookup = async () => {
    if (!q.trim()) return;
    setLookingUp(true);
    setLookup(null);
    try {
      const { data } = await client.get('/bluecat/records/lookup', { params: { q: q.trim() } });
      setLookup(data);
    } catch (err) {
      setLookup({ ok: false, error: err?.response?.data?.error || 'Lookup failed' });
    } finally {
      setLookingUp(false);
    }
  };

  const scopedZones = useMemo(() => zones || [], [zones]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Globe} title="DNS" description="BlueCat views, zones and resource records">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={loadRecords} />
      </PageHeader>

      <div className="flex flex-col md:flex-row gap-4 items-start">
        <div className="w-full md:w-72 shrink-0 flex flex-col gap-3">
          <div className="panel p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint px-1 py-1 flex items-center gap-1.5"><Layers size={11} /> Views</p>
            <button onClick={() => { setSelectedViewId(''); setSelectedZoneId(''); }}
              className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left text-xs cursor-pointer ${
                !selectedViewId ? 'bg-surface-overlay text-ink' : 'text-ink-muted hover:text-ink'
              }`}>
              All views
            </button>
            {views == null ? (
              <LoadingPanel label="Loading views…" height={60} />
            ) : views.length === 0 ? (
              <p className="text-xs text-ink-muted px-2 py-3">No views found.</p>
            ) : views.map((v) => (
              <button key={v.id} onClick={() => { setSelectedViewId(v.viewId); setSelectedZoneId(''); }}
                className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left text-xs cursor-pointer ${
                  selectedViewId === v.viewId ? 'bg-surface-overlay text-ink' : 'text-ink-muted hover:text-ink'
                }`}>
                <span className="truncate">{v.name}</span>
                <span className="text-[10px] text-ink-faint shrink-0">{fmtNum(v.zoneCount)}z / {fmtNum(v.recordCount)}r</span>
              </button>
            ))}
          </div>

          <div className="panel p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint px-1 py-1">Zones</p>
            <input value={zoneSearch} onChange={(e) => setZoneSearch(e.target.value)} placeholder="Search zones…" className={`${inp} mb-2`} spellCheck={false} />
            <button onClick={() => setSelectedZoneId('')}
              className={`w-full flex items-center px-2 py-1.5 rounded-md text-left text-xs cursor-pointer ${
                !selectedZoneId ? 'bg-surface-overlay text-ink' : 'text-ink-muted hover:text-ink'
              }`}>
              All zones
            </button>
            <div className="max-h-72 overflow-y-auto">
              {zones == null ? (
                <LoadingPanel label="Loading zones…" height={60} />
              ) : scopedZones.length === 0 ? (
                <p className="text-xs text-ink-muted px-2 py-3">No zones found.</p>
              ) : scopedZones.map((z) => (
                <button key={z.id} onClick={() => setSelectedZoneId(z.zoneId)}
                  className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left text-xs cursor-pointer ${
                    selectedZoneId === z.zoneId ? 'bg-surface-overlay text-ink' : 'text-ink-muted hover:text-ink'
                  }`}>
                  <span className="truncate">{z.absoluteName || z.name}</span>
                  <span className="text-[10px] text-ink-faint shrink-0">{fmtNum(z.recordCount)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, FQDN or data…" className={`${inp} flex-1 min-w-[200px]`} spellCheck={false} />
            <select value={rrType} onChange={(e) => setRrType(e.target.value)}
              className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-2 text-xs text-ink outline-none cursor-pointer">
              <option value="">All types</option>
              {RR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button onClick={liveLookup} disabled={lookingUp || !q.trim()} className={btnGhost}>
              {lookingUp ? <Spinner size={13} /> : <Search size={13} />} Live lookup in BAM
            </button>
          </div>

          {lookup && (
            <div className="panel p-3 mb-3 bg-surface-overlay">
              <p className="text-xs font-semibold text-ink mb-1">
                Live lookup {lookup.ok ? `(${lookup.method || 'unknown'} method)` : '— failed'}
              </p>
              {lookup.ok ? (
                (lookup.results || []).length === 0 ? (
                  <p className="text-xs text-ink-muted">No live matches.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {lookup.results.map((r, i) => (
                      <p key={r.id ?? i} className="text-xs text-ink-muted">
                        <span className="text-ink">{r.absoluteName || r.name}</span> · {r.type} {r.recordType ? `(${r.recordType})` : ''} · {r.rdata || '—'}
                      </p>
                    ))}
                  </div>
                )
              ) : (
                <p className="text-xs text-status-crit">{lookup.error || 'Lookup failed.'}</p>
              )}
            </div>
          )}

          {records == null ? (
            <LoadingPanel label="Loading records…" height={200} />
          ) : records.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No records found.</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="absoluteName" label="Name" ctl={ctl} />
                    <SortTh k="rrType" label="Type" ctl={ctl} />
                    <SortTh k="rdata" label="Data" ctl={ctl} />
                    <SortTh k="ip" label="IP" ctl={ctl} />
                    <SortTh k="networkRange" label="IP Space" ctl={ctl} />
                    <SortTh k="ttl" label="TTL" ctl={ctl} align="right" />
                    <SortTh k="zoneName" label="Zone / View" ctl={ctl} />
                  </tr></thead>
                  <tbody>
                    {ctl.rows.map((r) => (
                      <tr key={r.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink tnum">{r.absoluteName || r.name}</td>
                        <td className="py-2 pr-3"><Badge tone="neutral">{r.rrType}</Badge></td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{r.rdata || '—'}</td>
                        <td className="py-2 pr-3 tnum text-ink">
                          {r.ip || '—'}
                          {r.ips && r.ips.length > 1 && <span className="text-ink-faint text-[11px]"> +{r.ips.length - 1}</span>}
                        </td>
                        <td className="py-2 pr-3 text-[12px]">
                          {r.network ? (
                            <Link to={`/bluecat/ipspaces?network=${r.network.id}`} className="text-brand hover:underline tnum" title={r.network.blockRange ? `Block ${r.network.blockRange}${r.network.blockName ? ` (${r.network.blockName})` : ''}` : undefined}>
                              {r.network.range}{r.network.name ? ` (${r.network.name})` : ''}
                            </Link>
                          ) : r.ip ? <span className="text-ink-faint">not in a managed network</span> : '—'}
                        </td>
                        <td className="py-2 pr-3 text-right tnum text-ink-faint">{r.ttl ?? 'inherit'}</td>
                        <td className="py-2 pr-3 text-ink-faint text-[11px]">{[r.zoneName, r.viewName].filter(Boolean).join(' / ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-faint mt-2">
                Showing {fmtNum(records.length)} of {fmtNum(total)}{limited ? ' (truncated — narrow your search)' : ''}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
