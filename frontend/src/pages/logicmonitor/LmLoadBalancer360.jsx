import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Scale, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { DASH, arr, fmtNum, fmtPct, fmtWhen, stateTone, stateLabel, hostStatusTone, hostStatusLabel } from './helpers';
import { Modal, SectionPanel, Fact, iconBtn, headRow } from './ui';
import { num, AutoTable, TrendLine, IssuesList, pointsOf } from './LmFirewall360';

const VIP_LIMIT = 50;

// Member availability reads as an LM enum (1 = available is the assumption,
// UNVERIFIED) or text; anything else shows raw with a neutral tone.
function availOf(v) {
  if (v == null || v === '') return { tone: 'neutral', text: DASH, up: null };
  if (typeof v === 'boolean') return v ? { tone: 'ok', text: 'Available', up: true } : { tone: 'crit', text: 'Down', up: false };
  const n = num(v);
  if (n != null) return n === 1 ? { tone: 'ok', text: 'Available', up: true } : { tone: 'crit', text: `Down (${n})`, up: false };
  const s = String(v);
  if (/^(avail|up|green|ok)/i.test(s)) return { tone: 'ok', text: s, up: true };
  if (/(down|offline|red|unavail|disabled)/i.test(s)) return { tone: 'crit', text: s, up: false };
  return { tone: 'neutral', text: s, up: null };
}

function enabledText(v) {
  if (v == null || v === '') return DASH;
  const n = num(v);
  if (n != null) return n === 1 ? 'Enabled' : `Disabled (${n})`;
  return String(v);
}

function PoolsPanel({ pools }) {
  const [q, setQ] = useState('');
  const [openSet, setOpenSet] = useState(() => new Set());
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = arr(pools).map((p) => {
      const members = arr(p.members);
      const down = num(p.down) ?? members.filter((m) => availOf(m.avail).up === false).length;
      const up = num(p.up) ?? members.filter((m) => availOf(m.avail).up === true).length;
      return { ...p, members, up, down, total: members.length || up + down };
    });
    const filtered = !term ? rows : rows.filter((p) => String(p.pool).toLowerCase().includes(term) || p.members.some((m) => String(m.member).toLowerCase().includes(term)));
    return filtered.sort((a, b) => (b.down > 0) - (a.down > 0) || b.down - a.down || String(a.pool).localeCompare(String(b.pool)));
  }, [pools, q]);
  const term = q.trim().toLowerCase();

  if (!arr(pools).length) return <p className="text-[12px] text-ink-muted py-3 text-center">No pools collected yet. The metrics tier runs every 30 minutes by default; check Settings &gt; Scope &gt; Metric families.</p>;
  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter pools or members..." spellCheck={false}
          className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-sm text-ink focus:border-brand/60 outline-none" />
        <span className="text-[11px] text-ink-faint ml-auto">{fmtNum(list.length)} pool(s)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            <th className="py-2 pr-3 w-6" /><th className="py-2 pr-3 text-left">Pool</th><th className="py-2 pr-3 text-right">Members</th><th className="py-2 pr-3 text-right">Up</th><th className="py-2 pr-3 text-right">Down</th><th className="py-2 pr-3 text-left">State</th>
          </tr></thead>
          <tbody>
            {list.map((p) => {
              const isOpen = openSet.has(p.pool) || (term && p.members.some((m) => String(m.member).toLowerCase().includes(term)));
              const Chev = isOpen ? ChevronDown : ChevronRight;
              const tone = p.total >= 2 && p.down >= p.total ? 'crit' : p.down > 0 ? 'warn' : 'ok';
              return [
                <tr key={p.pool} className="border-b border-cohesity-border/40 cursor-pointer hover:bg-surface-overlay"
                  onClick={() => setOpenSet((cur) => { const n = new Set(cur); if (n.has(p.pool)) n.delete(p.pool); else n.add(p.pool); return n; })}>
                  <td className="py-1.5 pr-1"><Chev size={13} className="text-ink-faint" /></td>
                  <td className="py-1.5 pr-3 text-ink text-[12px]">{p.pool}</td>
                  <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(p.total)}</td>
                  <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(p.up)}</td>
                  <td className={`py-1.5 pr-3 text-right tnum text-[12px] ${p.down ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(p.down)}</td>
                  <td className="py-1.5 pr-3"><Badge tone={tone}>{tone === 'crit' ? 'All down' : tone === 'warn' ? 'Degraded' : 'OK'}</Badge></td>
                </tr>,
                isOpen ? (
                  <tr key={`${p.pool}-m`} className="border-b border-cohesity-border/40 bg-surface-overlay/40">
                    <td />
                    <td colSpan={5} className="py-2 pr-3">
                      <table className="w-full text-sm">
                        <thead><tr className={headRow}><th className="py-1 pr-3 text-left">Member</th><th className="py-1 pr-3 text-left">Availability</th><th className="py-1 pr-3 text-left">Enabled</th><th className="py-1 pr-3 text-right">Connections</th></tr></thead>
                        <tbody>
                          {p.members.filter((m) => !term || String(p.pool).toLowerCase().includes(term) || String(m.member).toLowerCase().includes(term)).map((m, i) => {
                            const a = availOf(m.avail);
                            return (
                              <tr key={`${m.member}-${i}`} className="border-t border-cohesity-border/30">
                                <td className="py-1 pr-3 text-ink-muted text-[12px] font-mono">{m.member}</td>
                                <td className="py-1 pr-3"><Badge tone={a.tone}>{a.text}</Badge></td>
                                <td className="py-1 pr-3 text-ink-muted text-[12px]">{enabledText(m.enabled)}</td>
                                <td className="py-1 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(m.connections)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DaemonsAndCerts({ daemons, certs }) {
  const d = arr(daemons);
  const c = arr(certs);
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <SectionPanel title="Daemons" blurb="Each F5 service reports running or not. A daemon that is not running raises a critical issue.">
        {d.length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No daemon status collected.</p> : (
          <div className="flex flex-wrap gap-1.5">
            {d.map((x, i) => {
              const n = num(x.state);
              const ok = n != null ? n === 1 : /run|up|ok|avail/i.test(String(x.state));
              return <Badge key={`${x.name}-${i}`} tone={x.state == null ? 'neutral' : ok ? 'ok' : 'crit'}>{x.name}{x.state == null ? '' : ok ? ': running' : `: ${n != null ? n : x.state}`}</Badge>;
            })}
          </div>
        )}
      </SectionPanel>
      <SectionPanel title="Certificates" blurb="Days left on each SSL certificate, soonest first.">
        {c.length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No certificates collected.</p> : (
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}><th className="py-1 pr-3 text-left">Certificate</th><th className="py-1 pr-3 text-right">Days left</th></tr></thead>
              <tbody>
                {[...c].sort((a, b) => (num(a.daysLeft) ?? 1e9) - (num(b.daysLeft) ?? 1e9)).map((x, i) => {
                  const dl = num(x.daysLeft);
                  return (
                    <tr key={`${x.name}-${i}`} className="border-t border-cohesity-border/30">
                      <td className="py-1 pr-3 text-ink-muted text-[12px] truncate max-w-[300px]" title={x.name}>{x.name}</td>
                      <td className={`py-1 pr-3 text-right tnum text-[12px] ${dl != null && dl < 7 ? 'text-status-crit' : dl != null && dl < 30 ? 'text-status-warn' : 'text-ink-muted'}`}>{dl == null ? DASH : fmtNum(dl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>
    </div>
  );
}

export default function LmLoadBalancer360({ deviceId, sourceId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [vipPage, setVipPage] = useState(1);

  useEffect(() => { setVipPage(1); setData(null); setError(null); }, [deviceId, sourceId]);

  // A VIP page change refetches the payload and keeps the old one on screen.
  useEffect(() => {
    let live = true;
    const params = { page: vipPage, limit: VIP_LIMIT };
    if (sourceId) params.sourceId = sourceId;
    client.get(`/logicmonitor/load-balancers/${deviceId}`, { params })
      .then(({ data: d }) => { if (live) setData(d || {}); })
      .catch((e) => { if (live) setError(e?.response?.status === 404 ? 'Load balancer not found. It may have been removed or is not an F5.' : 'Failed to load the load balancer.'); });
    return () => { live = false; };
  }, [deviceId, sourceId, vipPage]);

  const s = data?.summary || {};
  const d = data?.device || {};
  const vips = data?.vips;
  const vipRows = Array.isArray(vips) ? vips : arr(vips?.items);
  const vipTotal = Array.isArray(vips) ? vips.length : (num(vips?.total) ?? vipRows.length);

  return (
    <Modal icon={Scale} title={s.deviceName || d.displayName || `Load balancer ${deviceId}`} subtitle={[s.vendor, s.model, s.version].filter(Boolean).join(' - ')} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading load balancer..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={stateTone(s.state)}>{stateLabel(s.state)}</Badge>
            <Badge tone={hostStatusTone(s.hostStatus)}>{hostStatusLabel(s.hostStatus)}</Badge>
            <Badge tone={/active/i.test(String(s.failoverText)) ? 'ok' : /standby/i.test(String(s.failoverText)) ? 'info' : /offline/i.test(String(s.failoverText)) ? 'warn' : 'neutral'}>{s.failoverText || 'Failover unknown'}</Badge>
            <button onClick={() => navigate(`/logicmonitor/issues?q=${encodeURIComponent(s.deviceName || '')}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open issues page</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Fact label="Site">{s.siteName || s.siteKey}</Fact>
            <Fact label="Sync state">{s.syncState}</Fact>
            <Fact label="CPU">{fmtPct(s.cpuPct)}</Fact>
            <Fact label="Memory">{fmtPct(s.memPct)}</Fact>
            <Fact label="Client connections">{fmtNum(s.clientConnections)}</Fact>
            <Fact label="Server connections">{fmtNum(s.serverConnections)}</Fact>
            <Fact label="Pools degraded / total">{`${fmtNum(s.poolsDegraded)} / ${fmtNum(s.pools)}`}</Fact>
            <Fact label="Members down / total">{`${fmtNum(s.membersDown)} / ${fmtNum(s.membersTotal)}`}</Fact>
            <Fact label="Wide IPs down">{`${fmtNum(s.wideIpsDown)} / ${fmtNum(s.wideIps)}`}</Fact>
            <Fact label="VIPs down">{`${fmtNum(s.vipsDown)} / ${fmtNum(s.vips)}`}</Fact>
            <Fact label="Daemons down">{fmtNum(s.daemonsDown)}</Fact>
            <Fact label="Sampled">{s.sampledAt ? fmtWhen(s.sampledAt) : DASH}</Fact>
          </div>

          <SectionPanel title="Open issues"><IssuesList issues={data.issues} /></SectionPanel>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="CPU, 24 hours"><TrendLine pct series={[{ label: 'CPU %', points: pointsOf(data.cpuHistory, ['cpu_pct', 'cpuPct']) }]} /></SectionPanel>
            <SectionPanel title="Connections, 24 hours">
              <TrendLine series={[
                { label: 'Client connections', points: pointsOf(data.connectionsHistory, ['client_connections', 'clientConnections', 'client']) },
                { label: 'Server connections', points: pointsOf(data.connectionsHistory, ['server_connections', 'serverConnections', 'server']), color: '#3FB950' },
              ]} />
            </SectionPanel>
          </div>

          <SectionPanel title="Pools" blurb="Pool is the instance name before the first / or : of the pool member instance (an assumption until the first live poll). Pools with down members sort first.">
            <PoolsPanel pools={data.pools} />
          </SectionPanel>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Wide IPs"><AutoTable rows={data.wideIps} empty="No GTM wide IPs collected." /></SectionPanel>
            <SectionPanel title="GTM servers and data centers">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Servers</p>
              <AutoTable rows={data.gtmServers} empty="No GTM servers collected." pageSize={5} />
              <p className="text-[11px] uppercase tracking-wide text-ink-faint mt-3 mb-1">Data centers</p>
              <AutoTable rows={data.datacenters} empty="No GTM data centers collected." pageSize={5} />
            </SectionPanel>
          </div>

          <SectionPanel title="Virtual servers" right={<span className="text-[11px] text-ink-muted tnum">{fmtNum(vipTotal)} VIP(s)</span>}>
            <AutoTable rows={vipRows} empty="No virtual servers collected." pageSize={VIP_LIMIT} />
            {!Array.isArray(vips) && vipTotal > VIP_LIMIT && (
              <div className="flex items-center justify-between mt-3">
                <p className="text-[11px] text-ink-faint">Showing {fmtNum(vipRows.length)} of {fmtNum(vipTotal)} VIP(s)</p>
                <div className="flex items-center gap-2">
                  <button onClick={() => setVipPage((p) => Math.max(1, p - 1))} disabled={vipPage <= 1} className={iconBtn} aria-label="Previous page"><ChevronLeft size={14} /></button>
                  <span className="text-xs text-ink-muted tnum">{vipPage} / {Math.max(1, Math.ceil(vipTotal / VIP_LIMIT))}</span>
                  <button onClick={() => setVipPage((p) => Math.min(Math.ceil(vipTotal / VIP_LIMIT), p + 1))} disabled={vipPage >= Math.ceil(vipTotal / VIP_LIMIT)} className={iconBtn} aria-label="Next page"><ChevronRight size={14} /></button>
                </div>
              </div>
            )}
          </SectionPanel>

          <DaemonsAndCerts daemons={data.daemons} certs={data.certs} />

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Hardware">
              {Array.isArray(data.hardware) ? <AutoTable rows={data.hardware} empty="No hardware sensors collected." pageSize={8} /> : (
                Object.entries(data.hardware && typeof data.hardware === 'object' ? data.hardware : {}).filter(([, v]) => Array.isArray(v)).length === 0
                  ? <p className="text-[12px] text-ink-muted py-3 text-center">No hardware sensors collected.</p>
                  : Object.entries(data.hardware).filter(([, v]) => Array.isArray(v)).map(([k, v]) => (
                    <div key={k} className="mb-3"><p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">{k}</p><AutoTable rows={v} pageSize={5} /></div>
                  ))
              )}
            </SectionPanel>
            <SectionPanel title="Interfaces"><AutoTable rows={data.interfaces} empty="No interfaces collected." pageSize={8} /></SectionPanel>
          </div>
        </div>
      )}
    </Modal>
  );
}
