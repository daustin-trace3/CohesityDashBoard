import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Network, X, ListTree, History } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtWhen, parseJsonArr } from './helpers';

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-2xl max-h-[80vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
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

function ZoneMembersModal({ zone, onClose }) {
  const members = parseJsonArr(zone.members);
  return (
    <ModalShell title={zone.zoneName} subtitle={zone.zoneTypeString} icon={ListTree} onClose={onClose}>
      {zone.inEffective ? <Badge tone="ok" className="mb-3">In effective config</Badge> : null}
      {members.length === 0 ? (
        <p className="text-xs text-ink-muted py-1">No members reported.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {members.map((m, i) => (
            <div key={i} className="text-xs text-ink tnum bg-surface-overlay rounded-lg px-3 py-1.5">{m}</div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}

const TABS = [{ key: 'browser', label: 'Zoning Browser' }, { key: 'changes', label: 'Changes' }];

export default function BrocadeZoningPage() {
  const { toast } = useToast();
  const [fabrics, setFabrics] = useState(null);
  const [fabric, setFabric] = useState('');
  const [zoning, setZoning] = useState(null);
  const [changes, setChanges] = useState(null);
  const [tab, setTab] = useState('browser');
  const [detailZone, setDetailZone] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const loadFabrics = useCallback(() => client.get('/brocade/zoning/fabrics')
    .then(({ data }) => {
      const list = data.fabrics || [];
      setFabrics(list);
      if (!fabric && list.length) setFabric(list[0].fabricName);
    })
    .catch(() => { setFabrics([]); toast({ type: 'error', title: 'Failed to load zoning fabrics' }); }), [toast, fabric]);

  useEffect(() => { loadFabrics(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadZoning = useCallback(() => {
    if (!fabric) return;
    client.get('/brocade/zoning', { params: { fabric } })
      .then(({ data }) => { setZoning(data); setLastRefreshed(new Date()); })
      .catch(() => { setZoning({ configs: [], zones: [], aliases: [] }); toast({ type: 'error', title: 'Failed to load zoning' }); });
  }, [fabric, toast]);

  const loadChanges = useCallback(() => {
    if (!fabric) return;
    client.get('/brocade/zoning/changes', { params: { fabric } })
      .then(({ data }) => setChanges(data.changes || []))
      .catch(() => setChanges([]));
  }, [fabric]);

  useEffect(() => { loadZoning(); loadChanges(); }, [loadZoning, loadChanges]);

  const reload = () => { loadFabrics(); loadZoning(); loadChanges(); };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="Zoning" description="Zone configs, zones and aliases per fabric via the FOS proxy">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {fabrics == null ? (
          <div className="text-xs text-ink-muted">Loading fabrics…</div>
        ) : fabrics.length === 0 ? (
          <div className="text-xs text-ink-muted">No fabrics available.</div>
        ) : (
          <select value={fabric} onChange={(e) => setFabric(e.target.value)}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
            {fabrics.map((f) => <option key={f.fabricName} value={f.fabricName}>{f.fabricName} ({f.zoneCount} zones)</option>)}
          </select>
        )}
        <div className="flex items-center gap-1 ml-auto">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${tab === t.key ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {!fabric ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">Select a fabric to browse its zoning.</div>
      ) : tab === 'browser' ? (
        zoning == null ? (
          <LoadingPanel label="Loading zoning…" height={200} />
        ) : (
          <div className="grid lg:grid-cols-3 gap-4">
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink mb-3">Configs ({zoning.configs?.length || 0})</p>
              <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto">
                {(zoning.configs || []).length === 0 ? (
                  <p className="text-xs text-ink-muted">No configs.</p>
                ) : zoning.configs.map((c) => (
                  <div key={c.cfgName} className={`text-xs rounded-lg px-3 py-2 ${c.isEffective ? 'bg-brand/10 border border-brand/30' : 'bg-surface-overlay'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink font-medium truncate">{c.cfgName}</span>
                      {c.isEffective && <Badge tone="ok">Effective</Badge>}
                    </div>
                    <p className="text-ink-faint mt-0.5">{parseJsonArr(c.memberZones).length} zones · access {c.defaultZoneAccess === 1 ? 'All' : 'None'}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink mb-3">Zones ({zoning.zones?.length || 0})</p>
              <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto">
                {(zoning.zones || []).length === 0 ? (
                  <p className="text-xs text-ink-muted">No zones.</p>
                ) : zoning.zones.map((z) => (
                  <button key={z.zoneName} onClick={() => setDetailZone(z)}
                    className="flex items-center justify-between gap-2 text-xs rounded-lg px-3 py-2 bg-surface-overlay hover:ring-1 hover:ring-brand/30 transition-all cursor-pointer text-left">
                    <span className="text-brand truncate">{z.zoneName}</span>
                    <span className="text-ink-faint tnum shrink-0">{parseJsonArr(z.members).length}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink mb-3">Aliases ({zoning.aliases?.length || 0})</p>
              <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto">
                {(zoning.aliases || []).length === 0 ? (
                  <p className="text-xs text-ink-muted">No aliases.</p>
                ) : zoning.aliases.map((a) => (
                  <div key={a.aliasName} className="text-xs rounded-lg px-3 py-2 bg-surface-overlay">
                    <p className="text-ink font-medium truncate">{a.aliasName}</p>
                    <p className="text-ink-faint mt-0.5 truncate">{parseJsonArr(a.members).join(', ') || '—'}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><History size={15} className="text-brand" /> Zone Drift Log</p>
          {changes == null ? (
            <LoadingPanel label="Loading changes…" height={140} />
          ) : changes.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No zoning changes recorded for this fabric.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {changes.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 text-xs bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <Badge tone="warn">{c.changeType}</Badge>
                    <span className="text-ink ml-2">{c.detail}</span>
                  </div>
                  <span className="text-ink-faint tnum shrink-0">{fmtWhen(c.detectedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {detailZone && <ZoneMembersModal zone={detailZone} onClose={() => setDetailZone(null)} />}
    </div>
  );
}
