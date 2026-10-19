import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import client from '../../../api/client';
import { Badge } from '../../../components/ui/primitives';
import { arr, fmtNum, stateTone, stateLabel } from '../helpers';
import { EventBadge, whenText, circuitName, numberWans } from '../circuitShared';

// Pinned detail cards for the circuit map (node and edge click). The map owns the
// position and close handling; these components only render the content.

const list = (v) => (Array.isArray(v) ? v : []);
const sevTone = (s) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'neutral');
const short = (v, n) => (v && v.length > n ? `${v.slice(0, n - 1)}~` : v || '');
const downish = (c) => stateTone(c.state) === 'crit' || c.statusText === 'down' || c.state === 'down';

function Section({ title, children }) {
  return (
    <div className="mt-3">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">{title}</p>
      {children}
    </div>
  );
}

function Shell({ testid, title, sub, onClose, children, footer }) {
  return (
    <div className="flex flex-col min-h-0" data-testid={testid} style={{ maxHeight: '70vh' }}>
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          <p className="text-[14px] font-bold text-ink truncate" title={title}>{title}</p>
          {sub && <p className="text-[11px] text-ink-muted">{sub}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink cursor-pointer shrink-0"><X size={16} /></button>
      </div>
      <div className="px-3 pb-2 overflow-y-auto text-[11px] leading-relaxed min-h-0">{children}</div>
      <div className="flex gap-2 px-3 py-2 border-t" style={{ borderColor: '#2b3b4b' }}>{footer}</div>
    </div>
  );
}

const btn = 'text-[11px] px-2.5 py-1 rounded border border-cohesity-border text-ink hover:bg-surface-overlay cursor-pointer';

export function SiteCard({ node, onClose, onOpenSite, onOpenIssues }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    client.get(`/logicmonitor/sites/${encodeURIComponent(node.siteKey)}/circuits`)
      .then(({ data: d }) => { if (alive) setData(d || {}); })
      .catch(() => { if (alive) setError('Could not load the circuit detail for this site.'); });
    return () => { alive = false; };
  }, [node.siteKey]);

  const dead = list(node.deadDevices);
  const deg = list(node.degradedDevices);
  const top = list(node.issuesTop);
  const wans = numberWans(data?.circuits);
  const groups = {};
  list(data?.siteLinks).forEach((c) => {
    const k = c.farSiteKey || '?';
    const g = groups[k] || (groups[k] = { name: c.farSiteName || c.farSiteKey || 'unknown site', n: 0, down: 0, f24: 0, f7: 0 });
    g.n += 1; if (downish(c)) g.down += 1; g.f24 += Number(c.flaps24h) || 0; g.f7 += Number(c.flaps7d) || 0;
  });
  const wan = data?.wan;
  const wanText = !wan || !wan.state ? 'No WAN circuit identified at this site.'
    : wan.state === 'down' ? `WAN down: all ${wan.total} circuit(s) down.`
      : wan.state === 'degraded' ? `WAN degraded: ${Math.max(0, wan.total - wan.down)} of ${wan.total} circuit(s) up, site still reachable.`
        : `WAN up: ${wan.total} circuit(s).`;

  return (
    <Shell testid="site-card" title={node.siteName || String(node.siteKey)} sub={node.tier === 'dc' ? 'Data center' : 'Site'} onClose={onClose}
      footer={(
        <>
          <button type="button" className={btn} onClick={() => onOpenSite(node.siteKey)}>Open Site 360</button>
          <button type="button" className={btn} onClick={() => onOpenIssues(node)}>Open issues</button>
        </>
      )}>
      {list(node.reasons).map((r, i) => <p key={i} className="text-ink">{r}</p>)}
      <Section title="WAN">
        {error ? <p className="text-status-warn">{error}</p> : data == null ? <p className="text-ink-faint" data-testid="site-card-loading">Loading...</p> : (
          <>
            <p className="text-ink-muted mb-1">{wanText}</p>
            {wans.map((c) => (
              <div key={c.instanceId ?? circuitName(c)} className="flex items-center gap-2 py-0.5 border-b border-cohesity-border/40">
                <span className="font-bold text-ink w-9 shrink-0">{c.wanLabel}</span>
                <span className="min-w-0 flex-1 truncate" title={`${c.carrier || ''} ${c.circuitId || ''} ${circuitName(c)}`}>
                  <span className="text-ink">{c.carrier || 'Carrier unknown'}</span>
                  <span className="text-ink-faint font-mono">{c.circuitId ? ` ${c.circuitId}` : ''}</span>
                  <span className="text-ink-muted">{` ${circuitName(c)}`}</span>
                </span>
                <Badge tone={stateTone(c.state)}>{downish(c) ? 'Down' : stateLabel(c.state)}</Badge>
                <span className="text-ink-muted tnum w-12 text-right shrink-0">{`${fmtNum(c.flaps24h)}/${fmtNum(c.flaps7d)}`}</span>
                <span className="text-ink-faint w-20 text-right shrink-0 truncate" title={c.lastDownAt || undefined}>{whenText(c.lastDownAt)}</span>
              </div>
            ))}
            {wans.length > 0 && <p className="text-ink-faint mt-0.5">Flaps are 24 h / 7 d, then last down.</p>}
          </>
        )}
      </Section>
      {data && Object.keys(groups).length > 0 && (
        <Section title="Site links">
          {Object.values(groups).map((g) => (
            <p key={g.name} className="text-ink-muted">
              <span className="text-ink">{g.name}</span>{`: ${g.down >= g.n ? 'down' : g.down > 0 ? 'degraded' : 'up'}, ${g.n} circuit(s), flaps ${g.f24} / ${g.f7}`}
            </p>
          ))}
        </Section>
      )}
      {dead.length > 0 && <Section title={`Dead devices (${node.devicesDead ?? dead.length})`}>{dead.slice(0, 10).map((d) => <p key={d} className="text-status-crit truncate">{d}</p>)}</Section>}
      {deg.length > 0 && <Section title="Degraded devices">{deg.slice(0, 10).map((d) => <p key={d} className="text-status-warn truncate">{d}</p>)}</Section>}
      {(top.length > 0 || Number(node.openIssues) > 0) && (
        <Section title={`Open issues (${node.openIssues ?? top.length})`}>
          {top.slice(0, 5).map((i, k) => (
            <p key={k} className="flex items-center gap-1.5 min-w-0" title={i.target}>
              <Badge tone={sevTone(i.severity)}>{i.severity}</Badge>
              <span className="truncate text-ink-muted">{`${i.type}: ${short(i.target, 60)}`}</span>
            </p>
          ))}
        </Section>
      )}
      {data && (
        <Section title="Recent circuit events">
          {arr(data.events).length === 0 ? <p className="text-ink-faint">No circuit events recorded.</p> : arr(data.events).slice(0, 5).map((e) => (
            <p key={e.id} className="flex items-center gap-1.5 min-w-0">
              <span className="text-ink-faint whitespace-nowrap">{whenText(e.at)}</span>
              <EventBadge event={e.event} />
              <span className="truncate text-ink">{circuitName(e)}</span>
              {e.note && <span className="truncate text-ink-faint" title={e.note}>{e.note}</span>}
            </p>
          ))}
        </Section>
      )}
    </Shell>
  );
}

export function EdgeCard({ edge, nameOf, onClose, onOpenEdge }) {
  const circuits = list(edge.circuits);
  return (
    <Shell testid="edge-card" title={`${nameOf(edge.a)} to ${nameOf(edge.b)}`} sub={`State ${edge.state}${edge.lastEventAt ? `, last event ${whenText(edge.lastEventAt)}` : ''}`} onClose={onClose}
      footer={<button type="button" className={btn} onClick={() => onOpenEdge(edge)}>{edge.issueKey ? 'Open issue' : 'Open Site 360'}</button>}>
      <Section title={`Circuits (${circuits.length})`}>
        {circuits.map((c, i) => (
          <p key={c.instanceId ?? i} className="flex items-center gap-2 min-w-0" title={c.label || undefined}>
            <span className="truncate text-ink flex-1">{[c.deviceName, c.port].filter(Boolean).join(' ')}</span>
            <Badge tone={c.state === 'down' ? 'crit' : 'ok'}>{c.state === 'down' ? 'Down' : 'Up'}</Badge>
            <span className="text-ink-muted tnum shrink-0">{`${fmtNum(c.flaps24h)} flaps / 24 h`}</span>
          </p>
        ))}
      </Section>
    </Shell>
  );
}
