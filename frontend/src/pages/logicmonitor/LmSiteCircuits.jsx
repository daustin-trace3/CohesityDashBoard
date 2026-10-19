// Site 360 > Circuits (round 13): WAN banner, WAN1/WAN2 cards, site links and
// the circuit event timeline. Fed by GET /logicmonitor/sites/:siteKey/circuits.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { arr, fmtNum, fmtPct, stateTone, stateLabel } from './helpers';
import { headRow } from './ui';
import { wanMeta, EventBadge, NoteCell, issuesLink, whenText, circuitName, numberWans, roleLabel } from './circuitShared';

function banner(wan, wans) {
  const m = wanMeta(wan?.state);
  if (!m) return { m: null, text: 'No WAN circuit has been identified at this site.' };
  const total = Number(wan.total) || wans.length;
  const down = Number(wan.down) || 0;
  const flapping = Number(wan.flapping) || 0;
  const up = Math.max(0, total - down);
  if (wan.state === 'down') return { m, text: `Site is down: all ${total} WAN circuit(s) are down.` };
  if (wan.state === 'degraded') {
    const carrier = wans.find((c) => stateTone(c.state) !== 'crit');
    const via = carrier ? ` The site is reachable through ${carrier.wanLabel}${carrier.carrier ? ` (${carrier.carrier})` : ''}.` : '';
    return { m, text: down > 0 ? `Site is degraded, not down: ${up} of ${total} WAN circuit(s) up.${via}` : `Site is degraded: ${flapping} WAN circuit(s) flapping.${via}` };
  }
  return { m, text: `All ${total} WAN circuit(s) are up.` };
}

function WanCard({ c }) {
  const tone = stateTone(c.state);
  const color = tone === 'crit' ? '#F87171' : tone === 'warn' ? '#FBBF24' : '#6CB33F';
  return (
    <div className="rounded-lg border bg-surface-overlay p-3 min-w-0" style={{ borderColor: `${color}66`, borderTop: `3px solid ${color}` }} data-testid="wan-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink">{c.wanLabel}</span>
        <Badge tone={tone}>{tone === 'crit' ? 'Down' : stateLabel(c.state)}</Badge>
      </div>
      <p className="text-[12px] text-ink mt-1 truncate" title={c.carrier || undefined}>{c.carrier || 'Carrier unknown'}</p>
      <p className="text-[11px] text-ink-faint font-mono truncate" title={c.circuitId || undefined}>{c.circuitId || 'No circuit ID'}</p>
      <p className="text-[11px] text-ink-muted mt-1 truncate" title={circuitName(c)}>{circuitName(c) || '-'}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2 text-[11px]">
        <span className="text-ink-faint">p95 in / out</span><span className="text-ink tnum text-right">{`${fmtPct(c.p95InPct)} / ${fmtPct(c.p95OutPct)}`}</span>
        <span className="text-ink-faint">Flaps 24 h / 7 d</span>
        <span className={`tnum text-right ${(Number(c.flaps24h) || Number(c.flaps7d)) ? 'text-status-warn' : 'text-ink'}`}>{`${fmtNum(c.flaps24h)} / ${fmtNum(c.flaps7d)}`}</span>
        <span className="text-ink-faint">Last down</span><span className="text-ink text-right truncate" title={c.lastDownAt || undefined}>{whenText(c.lastDownAt)}</span>
      </div>
      {c.openIssueKey && <p className="text-[10px] mt-1.5"><Link to={issuesLink(c.openIssueKey, circuitName(c))} className="text-brand hover:underline">Open issue</Link></p>}
    </div>
  );
}

export default function SiteCircuitsPanel({ siteKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);

  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    client.get(`/logicmonitor/sites/${encodeURIComponent(siteKey)}/circuits`)
      .then(({ data: d }) => { if (!alive) return; setData(d || {}); setEvents(arr(d?.events)); })
      .catch((e) => { if (alive) setError(e?.response?.status === 404 ? 'The circuit view needs the round 13 backend.' : 'Failed to load the site circuits.'); });
    return () => { alive = false; };
  }, [siteKey]);

  if (error) return <p className="text-sm text-ink-muted py-4 text-center">{error}</p>;
  if (data == null) return <LoadingPanel label="Loading circuits..." height={140} />;

  const wans = numberWans(data.circuits);
  const links = arr(data.siteLinks);
  const b = banner(data.wan, wans);
  const meta = b.m || { tone: 'neutral', color: '#6B7C8D' };
  const patch = (next) => setEvents((cur) => cur.map((e) => (e.id === next.id ? { ...e, ...next } : e)));

  return (
    <div data-testid="site-circuits">
      <div className="rounded-lg px-3 py-2 mb-3 text-xs font-medium flex items-center gap-2 flex-wrap"
        style={{ background: `${meta.color}1a`, border: `1px solid ${meta.color}55`, color: meta.color }} data-testid="wan-banner">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: meta.color }} />
        <span>{b.text}</span>
      </div>

      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">WAN circuits</p>
      {wans.length === 0 ? <p className="text-sm text-ink-muted py-3 text-center">No provider WAN circuit at this site.</p> : (
        <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {wans.map((c) => <WanCard key={c.instanceId ?? `${c.deviceName}:${c.port}`} c={c} />)}
        </div>
      )}

      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Site links</p>
      {links.length === 0 ? <p className="text-sm text-ink-muted py-2 mb-3">No links to other sites.</p> : (
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <th className="py-1.5 pr-3">Far site</th><th className="py-1.5 pr-3">Circuit</th><th className="py-1.5 pr-3">State</th>
              <th className="py-1.5 pr-3 text-right">Flaps 24 h</th><th className="py-1.5 pr-3 text-right">Flaps 7 d</th>
            </tr></thead>
            <tbody>
              {links.map((c, i) => (
                <tr key={c.instanceId ?? i} className="border-b border-cohesity-border/40">
                  <td className="py-1.5 pr-3 text-ink text-[12px]">{c.farSiteName || c.farSiteKey || '-'}</td>
                  <td className="py-1.5 pr-3 text-ink-muted text-[12px]" title={c.label || undefined}>{circuitName(c)}</td>
                  <td className="py-1.5 pr-3"><Badge tone={stateTone(c.state)}>{stateTone(c.state) === 'crit' ? 'Down' : stateLabel(c.state)}</Badge></td>
                  <td className={`py-1.5 pr-3 text-right tnum ${c.flaps24h ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(c.flaps24h)}</td>
                  <td className={`py-1.5 pr-3 text-right tnum ${c.flaps7d ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(c.flaps7d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Circuit events</p>
      {events.length === 0 ? <p className="text-sm text-ink-muted py-2">No circuit events recorded for this site yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <th className="py-1.5 pr-3">When</th><th className="py-1.5 pr-3">Event</th><th className="py-1.5 pr-3">Circuit</th><th className="py-1.5 pr-3">Role</th><th className="py-1.5 pr-3">Note</th>
            </tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-cohesity-border/40 align-top">
                  <td className="py-1.5 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{whenText(e.at)}</td>
                  <td className="py-1.5 pr-3"><EventBadge event={e.event} /></td>
                  <td className="py-1.5 pr-3 text-ink text-[12px]">
                    {circuitName(e)}
                    {e.farSiteKey ? <span className="text-ink-faint"> to {e.farSiteKey}</span> : null}
                    {e.issueKey ? <Link to={issuesLink(e.issueKey, circuitName(e))} className="ml-2 text-[10px] text-brand hover:underline">Issue</Link> : null}
                  </td>
                  <td className="py-1.5 pr-3 text-ink-muted text-[11px]">{roleLabel(e.role)}</td>
                  <td className="py-1.5 pr-3"><NoteCell ev={e} onSaved={patch} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
