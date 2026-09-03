import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Check, ChevronRight, GripVertical, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import client from '../../api/client';
import { PlatformLogo } from '../../components/PlatformSwitcher';
import { DriftOverview, NocturneOverview, StyleToggle, TvButton } from './OpsOverviewVariants';

const CARD_ORDER_KEY = 'ops-card-order';
// Overview style: the global default comes from Global Settings
// (ops_overview_style); the page toggle is a session-only override.
const STYLES = ['classic', 'drift', 'nocturne'];

const TONES = {
  ok: '#6CB33F',
  warning: '#D4A24E',
  critical: '#C75D5D',
  unknown: '#8FA3B0',
  stale: '#8FA3B0',
};

const fmt = (v) => (v == null ? '—' : typeof v === 'string' ? v : Number(v).toLocaleString());

// Per-platform data freshness from the /poller/status payload. Stale data
// silently lying is the worst failure mode on a wall monitor, so staleness
// overrides the health verdict on a card.
function freshness(status, id) {
  const p = status?.[id];
  if (!p) return null;
  if (p.entities) {
    if (!p.entities.length) return null;
    const ages = p.entities.map((e) => e.ageMinutes).filter((v) => v != null);
    return {
      age: ages.length ? Math.max(...ages) : null,
      stale: p.entities.some((e) => e.isStale),
      error: p.entities.some((e) => e.lastPollStatus === 'error'),
    };
  }
  return { age: p.ageMinutes ?? null, stale: !!p.isStale, error: !!(p.failedSources?.length) };
}

function Spark({ values, color, label }) {
  if (!values || !values.some((v) => v > 0)) return null;
  const max = Math.max(...values, 1);
  const w = 104;
  const h = 28;
  const bw = w / values.length;
  return (
    <div className="flex flex-col items-end gap-0.5" title={label ? `7 days — ${label}` : undefined}>
      <svg width={w} height={h} aria-hidden="true">
        {values.map((v, i) => {
          const bh = Math.max(1.5, (v / max) * h);
          return <rect key={i} x={i * bw + 1.5} y={h - bh} width={Math.max(1, bw - 3)} height={bh} rx={1} fill={color} opacity={v ? 0.8 : 0.25} />;
        })}
      </svg>
      {label && <span className="text-[9px] text-ink-faint leading-none">{label}</span>}
    </div>
  );
}

function SevDot({ severity }) {
  return <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: TONES[severity] || TONES.unknown }} />;
}

function PlatformCard({ card, fresh, onNavigate, dragEnabled, dragOver, onGripDown, onGripUp, onDragStart, onDragEnd, onDragOver, onDrop }) {
  const stale = fresh?.stale || fresh?.error;
  const tone = stale ? TONES.stale : TONES[card.health] || TONES.unknown;
  const verdict = fresh?.error ? 'POLL ERROR'
    : stale ? `STALE · ${fresh.age != null ? `${Math.round(fresh.age)}m` : 'no data'}`
    : card.health === 'ok' ? null
    : card.health === 'unknown' ? 'NO DATA'
    : card.health.toUpperCase();
  const shown = card.exceptions.slice(0, 3);
  const hidden = card.exceptions.length - shown.length;
  return (
    <button
      onClick={() => onNavigate(card.route)}
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`panel p-5 text-left transition-all cursor-pointer hover:-translate-y-0.5 flex flex-col gap-4 relative group/card ${dragOver ? 'ring-2 ring-brand/60' : ''}`}
      style={{ borderTop: `3px solid ${card.color}`, opacity: stale ? 0.85 : 1 }}
    >
      {dragEnabled && (
        <span
          onMouseDown={onGripDown}
          onMouseUp={onGripUp}
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
          className="absolute right-2 top-2 z-10 p-1 rounded text-ink-faint opacity-0 group-hover/card:opacity-100 hover:text-ink hover:bg-surface-overlay cursor-grab active:cursor-grabbing transition-opacity"
        >
          <GripVertical size={14} />
        </span>
      )}
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-[11px] font-bold"
          style={{ backgroundColor: `${card.color}22`, color: card.color }}>
          <PlatformLogo platform={card} size={20} />
        </span>
        <span className="text-[15px] font-semibold text-ink flex-1 truncate">{card.label}</span>
        {verdict ? (
          <span className="text-[11px] font-bold tracking-wide px-2.5 py-1 rounded-full flex-shrink-0"
            style={{ backgroundColor: `${tone}1f`, color: tone }}>
            {verdict}
          </span>
        ) : (
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tone, boxShadow: `0 0 8px ${tone}88` }} />
        )}
      </div>

      <div className="flex items-end gap-7">
        {card.headline.map((hRow) => (
          <div key={hRow.label} className="min-w-0">
            <p className="text-3xl font-bold text-ink tnum leading-none">{fmt(hRow.value)}</p>
            <p className="text-[11px] uppercase tracking-wide text-ink-faint truncate mt-1.5">{hRow.label}</p>
          </div>
        ))}
      </div>

      {card.error ? (
        <p className="text-[13px] text-ink-faint">Summary unavailable</p>
      ) : shown.length === 0 ? (
        card.health === 'unknown' ? (
          <p className="text-[13px] text-ink-faint">No source connected — add one under {card.label} settings</p>
        ) : (
          <p className="flex items-center gap-2 text-[13px] font-medium" style={{ color: TONES.ok }}>
            <Check size={15} strokeWidth={2.5} /> healthy
          </p>
        )
      ) : (
        <div className="flex flex-col gap-1.5">
          {shown.map((e, i) => (
            <span
              key={i}
              role="link"
              tabIndex={0}
              onClick={(ev) => { ev.stopPropagation(); onNavigate(e.link); }}
              onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); onNavigate(e.link); } }}
              className="flex items-center gap-2 text-[13px] hover:underline"
              style={{ color: TONES[e.severity] }}
            >
              <SevDot severity={e.severity} />
              <span className="truncate">{e.text}</span>
            </span>
          ))}
          {hidden > 0 && <span className="text-[12px] text-ink-faint pl-4">+{hidden} more</span>}
        </div>
      )}

      <div className="flex items-end justify-between mt-auto pt-1">
        <span className="text-[11px] text-ink-faint tnum">{fmt(card.objects)} objects</span>
        <Spark values={card.spark} color={card.color} label={card.sparkLabel} />
      </div>
    </button>
  );
}

export default function OpsMonitorPage() {
  const navigate = useNavigate();
  const rootRef = useRef(null);
  const [data, setData] = useState(null);
  const [pollerStatus, setPollerStatus] = useState(null);
  const [countdown, setCountdown] = useState(60);
  const [tv, setTv] = useState(false);
  const [style, setStyle] = useState(null);
  const changeStyle = (v) => setStyle(STYLES.includes(v) ? v : 'classic');
  useEffect(() => {
    let cancelled = false;
    const loadStyle = () => client.get('/settings')
      .then((r) => { if (!cancelled) setStyle(STYLES.includes(r.data?.opsOverviewStyle) ? r.data.opsOverviewStyle : 'classic'); })
      .catch(() => { if (!cancelled) setStyle((s) => s || 'classic'); });
    loadStyle();
    window.addEventListener('ops-style-changed', loadStyle);
    return () => { cancelled = true; window.removeEventListener('ops-style-changed', loadStyle); };
  }, []);
  const [order, setOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CARD_ORDER_KEY)) || []; } catch { return []; }
  });
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [armed, setArmed] = useState(null);

  const load = useCallback(() => {
    client.get('/ops/summary').then((r) => setData(r.data)).catch(() => {});
    client.get('/poller/status').then((r) => setPollerStatus(r.data)).catch(() => {});
    setCountdown(60);
  }, []);

  useEffect(() => {
    load();
    const refresh = setInterval(load, 60000);
    const tick = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, [load]);

  // Platform enable/disable and plugin installs fire 'platforms-changed'
  // (Global Settings, Plugins page); refetch so the estate updates in place.
  useEffect(() => {
    window.addEventListener('platforms-changed', load);
    return () => window.removeEventListener('platforms-changed', load);
  }, [load]);

  useEffect(() => {
    const onFs = () => setTv(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleTv = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else rootRef.current?.requestFullscreen?.();
  };

  const cards = data?.platforms || [];
  const totals = data?.totals || {};
  const attention = data?.attention || [];

  const ids = useMemo(() => cards.map((c) => c.id), [cards]);
  const orderedIds = useMemo(() => {
    const kept = order.filter((id) => ids.includes(id));
    const merged = [...kept];
    ids.forEach((id) => { if (!merged.includes(id)) merged.push(id); });
    return merged;
  }, [order, ids]);
  const customized = JSON.stringify(orderedIds) !== JSON.stringify(ids);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  const sortedCards = orderedIds.map((id) => byId[id]).filter(Boolean);

  const persistOrder = (next) => {
    setOrder(next);
    try { localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };

  const moveCard = (from, to, before) => {
    const next = orderedIds.filter((id) => id !== from);
    const j = next.indexOf(to);
    next.splice(before ? j : j + 1, 0, from);
    if (JSON.stringify(next) !== JSON.stringify(orderedIds)) persistOrder(next);
  };

  const resetOrder = () => persistOrder([]);

  const freshById = Object.fromEntries(cards.map((c) => [c.id, freshness(pollerStatus, c.id)]));
  const staleIds = cards.filter((c) => freshById[c.id]?.stale || freshById[c.id]?.error).map((c) => c.id);
  const oldestAge = Math.max(0, ...cards.map((c) => freshById[c.id]?.age ?? 0));

  const estate = cards.some((c) => c.health === 'critical') ? { label: 'ATTENTION', tone: TONES.critical }
    : cards.some((c) => c.health === 'warning') ? { label: 'DEGRADED', tone: TONES.warning }
    : cards.length ? { label: 'HEALTHY', tone: TONES.ok }
    : { label: 'NO DATA', tone: TONES.unknown };

  if (style == null) {
    return <div ref={rootRef} className="ops-root animate-fade-in"><div className="panel p-8 text-center text-sm text-ink-muted">Loading estate...</div></div>;
  }

  if (style !== 'classic') {
    const dark = style === 'nocturne';
    const Variant = dark ? NocturneOverview : DriftOverview;
    return (
      <div ref={rootRef} className="ops-root animate-fade-in">
        <Variant
          data={data}
          pollerStatus={pollerStatus}
          countdown={countdown}
          onNavigate={navigate}
          controls={(
            <>
              <StyleToggle value={style} onChange={changeStyle} dark={dark} />
              <TvButton tv={tv} onToggle={toggleTv} dark={dark} />
            </>
          )}
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="ops-root animate-fade-in">
      {/* Estate strip */}
      <div className="panel px-5 py-4 mb-4 flex flex-wrap items-center gap-x-8 gap-y-3" style={{ borderTop: `3px solid ${estate.tone}` }}>
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: estate.tone, boxShadow: `0 0 10px ${estate.tone}aa`, animation: 'orb-pulse 2.5s ease-in-out infinite' }} />
          <span className="text-2xl font-bold tracking-tight" style={{ color: estate.tone }}>{estate.label}</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <SevDot severity="critical" />
            <span className="text-lg font-bold tnum" style={{ color: totals.critical ? TONES.critical : undefined }}>{fmt(totals.critical ?? 0)}</span>
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">critical</span>
          </div>
          <div className="flex items-center gap-2">
            <SevDot severity="warning" />
            <span className="text-lg font-bold tnum" style={{ color: totals.warning ? TONES.warning : undefined }}>{fmt(totals.warning ?? 0)}</span>
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">warning</span>
          </div>
        </div>
        <p className="text-[12px] text-ink-muted">
          <span className="font-semibold text-ink tnum">{fmt(totals.objects)}</span> objects monitored across{' '}
          <span className="font-semibold text-ink tnum">{totals.platforms ?? 0}</span> platform{totals.platforms === 1 ? '' : 's'}
          {' · '}
          {staleIds.length
            ? <span style={{ color: TONES.warning }}>{staleIds.length} platform{staleIds.length === 1 ? '' : 's'} stale</span>
            : <>all data fresh{oldestAge > 0 && ` (oldest poll ${Math.round(oldestAge)}m)`}</>}
        </p>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-ink-faint tnum">refresh in {countdown}s</span>
          <StyleToggle value={style} onChange={changeStyle} dark />
          <button
            onClick={toggleTv}
            title={tv ? 'Exit TV mode' : 'TV mode (fullscreen)'}
            className="flex items-center justify-center h-8 w-8 rounded-lg border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer"
          >
            {tv ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* Platform cards */}
      {data == null ? (
        <div className="panel p-8 text-center text-sm text-ink-muted">Loading estate…</div>
      ) : cards.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted">No platforms enabled yet — connect one under its Settings page.</div>
      ) : (
        <>
          {!tv && customized && (
            <div className="flex justify-end -mb-1">
              <button
                onClick={resetOrder}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-ink-faint hover:text-ink border border-transparent hover:border-cohesity-border transition-colors cursor-pointer"
              >
                <RotateCcw size={11} /> Reset layout
              </button>
            </div>
          )}
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-4">
            {sortedCards.map((c) => (
              <PlatformCard
                key={c.id}
                card={c}
                fresh={freshById[c.id]}
                onNavigate={navigate}
                dragEnabled={!tv}
                dragOver={dragId != null && dragId !== c.id && overId === c.id}
                onGripDown={() => setArmed(c.id)}
                onGripUp={() => setArmed(null)}
                onDragStart={(e) => { if (armed !== c.id) { e.preventDefault(); return; } setDragId(c.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => { setDragId(null); setOverId(null); setArmed(null); }}
                onDragOver={(e) => {
                  if (!dragId || dragId === c.id) return;
                  e.preventDefault();
                  setOverId(c.id);
                  const r = e.currentTarget.getBoundingClientRect();
                  moveCard(dragId, c.id, e.clientX < r.left + r.width / 2);
                }}
                onDrop={(e) => { e.preventDefault(); setDragId(null); setOverId(null); setArmed(null); }}
              />
            ))}
          </div>
        </>
      )}

      {/* Attention feed */}
      {data != null && (
        <div className="panel p-4">
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2">
            <Activity size={15} className="text-brand" /> Needs Attention
            {attention.length > 0 && <span className="text-ink-faint font-normal text-[12px]">· top {attention.length}</span>}
          </p>
          {attention.length === 0 ? (
            <p className="flex items-center gap-2 text-[13px] py-2" style={{ color: TONES.ok }}>
              <Check size={14} strokeWidth={2.5} /> Nothing needs attention — all platforms healthy.
            </p>
          ) : (
            <div className="flex flex-col">
              {attention.map((a, i) => (
                <button
                  key={i}
                  onClick={() => navigate(a.link)}
                  className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg text-left hover:bg-surface-overlay transition-colors cursor-pointer border-b border-cohesity-border/40 last:border-b-0"
                >
                  <SevDot severity={a.severity} />
                  <span className="text-[10px] font-bold uppercase tracking-wide w-16 flex-shrink-0" style={{ color: a.color }}>{a.platform}</span>
                  <span className="text-[13px] text-ink flex-1 truncate">{a.text}</span>
                  <ChevronRight size={14} className="text-ink-faint flex-shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
