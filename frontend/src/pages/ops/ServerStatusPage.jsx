import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Crosshair, Search, ShieldCheck, Loader2 } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, Badge } from '../../components/ui/primitives';

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};
const runTone = (s) => s === 'Succeeded' || s === 'SucceededWithWarning' ? 'ok' : s === 'Failed' ? 'crit' : s ? 'warn' : 'neutral';
const fmtAgo = (ms) => {
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

// Same brand colors as the global search dropdown's platform dots.
const PLATFORM_META = {
  cohesity: { label: 'Cohesity', color: '#6CB33F' },
};

function PlatformChip({ platform }) {
  const meta = PLATFORM_META[platform];
  if (!meta) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: `${meta.color}55`, color: meta.color, backgroundColor: `${meta.color}14` }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
      {meta.label}
    </span>
  );
}

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <div className="text-sm text-ink truncate">{children ?? '—'}</div>
    </div>
  );
}

/** Cross-platform "everything we know about this server" view. */
export default function ServerStatusPage() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('name') || '');
  const [suggestions, setSuggestions] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback((name) => {
    if (!name) return;
    setLoading(true);
    setSuggestions([]);
    client.get('/server360', { params: { name } })
      .then(({ data }) => setData(data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    setParams({ name }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    const name = params.get('name');
    if (name) load(name);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = input.trim();
    if (q.length < 2 || q === params.get('name')) { setSuggestions([]); return undefined; }
    const id = ++seqRef.current;
    const t = setTimeout(() => {
      client.get('/server360/suggest', { params: { q } })
        .then(({ data }) => { if (seqRef.current === id) setSuggestions(data.names || []); })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const pluginSections = data?.plugins || [];
  const nothingFound = data && !data.cohesity && !pluginSections.length;

  return (
    <div className="animate-fade-in flex flex-col gap-4">
      <PageHeader icon={Crosshair} title="Server 360"
        description="Everything the estate knows about one server — provisioning, compute, backup, DR, and live storage mounts" />

      {/* Picker */}
      <div className="panel p-4">
        <div className="relative max-w-lg">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(suggestions[0] && input !== params.get('name') ? suggestions[0] : input.trim()); }}
            placeholder="Server name or hostname…"
            className="w-full bg-surface border border-cohesity-border text-sm text-ink rounded-lg pl-9 pr-3 py-2 placeholder-ink-faint focus:border-brand/60 transition-colors"
          />
          {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint animate-spin" />}
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl overflow-hidden">
              {suggestions.map((n) => (
                <button key={n} onClick={() => { setInput(n); load(n); }}
                  className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-brand/10 transition-colors cursor-pointer">{n}</button>
              ))}
            </div>
          )}
        </div>
        {data?.identity && (
          <p className="text-[11px] text-ink-faint mt-2 tnum">
            Pivoting on {data.identity.names.join(', ')}{data.identity.ips.length ? ` · IPs ${data.identity.ips.join(', ')}` : ' · no known IPs'}
          </p>
        )}
      </div>

      {nothingFound && (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No platform has data for “{data.query}”. Check the spelling, or the server may not be inventoried yet.
        </div>
      )}

      {/* Cohesity backup posture */}
      {data?.cohesity && (
        <Panel title="Backup" icon={ShieldCheck} actions={<PlatformChip platform="cohesity" />}>
          {data.cohesity.objects.map((o) => (
            <div key={o.id} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-2 border-b border-cohesity-border/40 last:border-0 pb-2">
              <Fact label="Object">{o.name} <span className="text-ink-faint text-[11px]">({o.environment})</span></Fact>
              <Fact label="Protected"><Badge tone={o.is_protected ? 'ok' : 'warn'}>{o.is_protected ? 'protected' : 'unprotected'}</Badge></Fact>
              <Fact label="Cluster">{o.cluster_name}</Fact>
              <Fact label="Protection Group">{o.protection_groups.join(', ') || '—'}</Fact>
              <Fact label="Last Backup">
                {o.last_backup_status ? <Badge tone={runTone(o.last_backup_status)}>{o.last_backup_status}</Badge> : '—'}
                {o.last_backup_ms ? (
                  <span className={`ml-1.5 text-[11px] tnum ${Date.now() - o.last_backup_ms > 7 * 86400000 ? 'text-amber-400' : 'text-ink-faint'}`}>
                    {new Date(o.last_backup_ms).toLocaleDateString()} · {fmtAgo(o.last_backup_ms)}
                  </span>
                ) : null}
              </Fact>
              <Fact label="Logical">{fmtBytes(o.logical_bytes)}</Fact>
              <div className="col-span-full -mt-1">
                <Link to={`/cohesity/object-360?name=${encodeURIComponent(o.name)}`}
                  className="text-[11px] text-brand hover:text-brand-bright" title="Open Cohesity Object 360">
                  Open Object 360 →
                </Link>
              </div>
            </div>
          ))}
          {data.cohesity.agents.map((a) => (
            <p key={a.id} className="text-[11px] text-ink-faint tnum">
              agent {String(a.agent_version || 'unknown').split('_release')[0]} · {a.agent_status || '—'} · {a.upgradability === 'Upgradable' ? 'upgrade available' : a.upgradability || '—'} · {a.cluster_name}
            </p>
          ))}
        </Panel>
      )}

      {/* Installed plugins (display-ready sections from manifest.server360) */}
      {pluginSections.map((p) => (
        <Panel key={p.id} title={p.title} icon={ShieldCheck}
          actions={p.chip ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
              style={{ borderColor: `${p.chip.color}55`, color: p.chip.color, backgroundColor: `${p.chip.color}14` }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: p.chip.color }} />
              {p.chip.label}
            </span>
          ) : null}>
          {(p.groups || []).map((g, i) => (
            <div key={i} className="mb-2 border-b border-cohesity-border/40 last:border-0 pb-2 last:pb-0 last:mb-0">
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
                {(g.facts || []).map((f, j) => (
                  <Fact key={j} label={f.label}>
                    {f.tone ? <Badge tone={f.tone}>{f.value ?? '—'}</Badge> : (f.value ?? '—')}
                  </Fact>
                ))}
              </div>
              {(g.lines || []).map((line, j) => (
                <p key={j} className="text-[11px] text-ink-faint tnum mt-1">{line}</p>
              ))}
              {g.link && (
                <Link to={g.link.href} className="inline-block text-[11px] text-brand hover:text-brand-bright mt-1" title={g.link.label}>
                  {g.link.label}
                </Link>
              )}
            </div>
          ))}
        </Panel>
      ))}
    </div>
  );
}
