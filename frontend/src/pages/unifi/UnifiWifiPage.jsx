import { useEffect, useState, useCallback } from 'react';
import { Wifi, Radio, ShieldAlert } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

const BUCKET_COLOR = { excellent: '#6CB33F', good: '#8FA3B0', fair: '#D4A24E', poor: '#C75D5D' };
const BUCKET_LABEL = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor' };
const BAND_LABEL = { ng: '2.4 GHz', na: '5 GHz', '6e': '6 GHz' };

function SignalBar({ buckets }) {
  const total = Object.values(buckets || {}).reduce((a, b) => a + (b || 0), 0);
  if (!total) return <p className="text-sm text-ink-muted">No wireless clients.</p>;
  return (
    <div>
      <div className="flex w-full h-3 rounded-full overflow-hidden mb-2">
        {['excellent', 'good', 'fair', 'poor'].map((k) => {
          const pct = ((buckets[k] || 0) / total) * 100;
          return pct > 0 ? <div key={k} style={{ width: `${pct}%`, backgroundColor: BUCKET_COLOR[k] }} /> : null;
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {['excellent', 'good', 'fair', 'poor'].map((k) => (
          <span key={k} className="text-[11px] text-ink-muted inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: BUCKET_COLOR[k] }} />
            {BUCKET_LABEL[k]} ({buckets[k] || 0})
          </span>
        ))}
      </div>
    </div>
  );
}

function ApSignalRows({ signalByAp }) {
  if (!signalByAp?.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-2.5">
      <p className="text-[11px] uppercase tracking-wide text-ink-faint">By access point</p>
      {signalByAp.map((a) => (
        <div key={a.apMac} className="flex items-center gap-3">
          <div className="w-44 shrink-0 min-w-0">
            <p className="text-xs text-ink truncate">{a.apName}</p>
            <p className="text-[10px] text-ink-faint tnum">{a.total} client{a.total === 1 ? '' : 's'}{a.avgSignal != null ? ` · avg ${a.avgSignal} dBm` : ''}</p>
          </div>
          <div className="flex flex-1 h-2.5 rounded-full overflow-hidden bg-surface-overlay">
            {['excellent', 'good', 'fair', 'poor'].map((k) => {
              const pct = a.total ? ((a.buckets[k] || 0) / a.total) * 100 : 0;
              return pct > 0 ? (
                <div key={k} style={{ width: `${pct}%`, backgroundColor: BUCKET_COLOR[k] }}
                  title={`${BUCKET_LABEL[k]}: ${a.buckets[k]}`} />
              ) : null;
            })}
          </div>
          <div className="w-28 shrink-0 text-right text-[10px] text-ink-faint tnum">
            {['excellent', 'good', 'fair', 'poor'].filter((k) => a.buckets[k]).map((k) => `${a.buckets[k]} ${BUCKET_LABEL[k].toLowerCase()}`).slice(0, 2).join(' · ')}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function UnifiWifiPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/unifi/wifi')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ wlans: [], radios: [], rogues: [], signalBuckets: {} }); toast({ type: 'error', title: 'Failed to load WiFi data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const wlans = data?.wlans || [];
  const radios = data?.radios || [];
  const rogues = data?.rogues || [];
  const signalBuckets = data?.signalBuckets || {};

  const rogueList = rogues.map((r) => ({ ...r, rogue_label: r.is_rogue ? 'Flagged' : 'Neighbor' }));
  const ctl = useTableControls(rogueList, {
    searchKeys: ['essid', 'bssid', 'oui'],
    defaultSortKey: 'signal', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Wifi} title="WiFi" description="Wireless networks, radios and nearby access points">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading WiFi data…" height={160} />
      ) : (
        <>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Wifi size={15} className="text-brand" /> WLANs</p>
          {wlans.length === 0 ? (
            <div className="panel p-6 text-sm text-ink-muted text-center mb-4">No WLANs configured.</div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
              {wlans.map((w) => (
                <div key={w.id || w.wlan_id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-sm font-semibold text-ink truncate">{w.name}</p>
                    <Badge tone={w.enabled ? 'ok' : 'neutral'}>{w.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge tone="neutral">{w.security || 'open'}</Badge>
                    {w.is_guest ? <Badge tone="info">Guest</Badge> : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Radio size={15} className="text-brand" /> Radios</p>
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            {radios.length === 0 ? (
              <div className="text-sm text-ink-muted py-4 text-center">No radio data collected.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">Access Point</th>
                    <th className="py-2 pr-3">Band</th>
                    <th className="py-2 pr-3 text-right">Channel</th>
                    <th className="py-2 pr-3 text-right">Width</th>
                    <th className="py-2 pr-3 text-right">Tx Power</th>
                    <th className="py-2 pr-3 text-right">Utilization</th>
                    <th className="py-2 pr-3 text-right">Satisfaction</th>
                    <th className="py-2 pr-3 text-right">Clients</th>
                  </tr></thead>
                  <tbody>
                    {radios.map((r, i) => (
                      <tr key={i} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink">{r.deviceName || r.deviceMac}</td>
                        <td className="py-2 pr-3 text-ink-muted">{BAND_LABEL[r.radio] || r.radio || '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.channel ?? '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.width ? `${r.width} MHz` : '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.txPower != null ? `${r.txPower} dBm${r.txPowerMode ? ` (${r.txPowerMode})` : ''}` : '—'}</td>
                        <td className={`py-2 pr-3 text-right tnum ${r.utilization > 60 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{r.utilization != null ? `${r.utilization}%` : '—'}</td>
                        <td className={`py-2 pr-3 text-right tnum ${r.satisfaction != null && r.satisfaction < 70 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{r.satisfaction != null ? `${r.satisfaction}%` : '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.numSta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-sm font-semibold text-ink mb-3">Signal Quality Distribution</p>
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <SignalBar buckets={signalBuckets} />
            <ApSignalRows signalByAp={data?.signalByAp} />
          </div>

          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Neighboring / Rogue Access Points</p>
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <TableControls ctl={ctl} rows={rogueList} searchPlaceholder="Filter by SSID, BSSID or vendor…"
              filters={[{ k: 'rogue_label', label: 'Flag' }, { k: 'security', label: 'Security' }]} />
            {rogueList.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No neighboring access points detected.</div>
            ) : ctl.rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No results match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="essid" label="SSID" ctl={ctl} />
                    <SortTh k="bssid" label="BSSID" ctl={ctl} />
                    <SortTh k="channel" label="Channel" ctl={ctl} align="right" />
                    <SortTh k="signal" label="Signal" ctl={ctl} align="right" />
                    <SortTh k="security" label="Security" ctl={ctl} />
                    <SortTh k="rogue_label" label="Flag" ctl={ctl} />
                  </tr></thead>
                  <tbody>
                    {ctl.pageRows.map((r, i) => (
                      <tr key={r.id || i} className={`border-b border-cohesity-border/50 ${r.is_rogue ? 'bg-status-crit/5' : ''}`}>
                        <td className="py-2 pr-3 text-ink">{r.essid || '(hidden)'}</td>
                        <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{r.bssid}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.channel ?? '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.signal ?? '—'}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.security || '—'}</td>
                        <td className="py-2 pr-3"><Badge tone={r.is_rogue ? 'crit' : 'neutral'}>{r.rogue_label}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={ctl} />
          </div>
        </>
      )}
    </div>
  );
}
