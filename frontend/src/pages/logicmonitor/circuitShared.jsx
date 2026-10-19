// Small pieces shared by the round 13 circuit surfaces: Site 360 Circuits tab,
// the Circuits page events section and the Circuit Map. Every field is read
// defensively because the routes are built by another work package.
import { useState } from 'react';
import { Pencil, Check, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { Badge } from '../../components/ui/primitives';
import { arr, fmtWhen } from './helpers';
import { sel } from './ui';

export const ROLE_LABEL = { wan: 'WAN', 'site-link': 'Site link', uplink: 'Uplink' };
export const roleLabel = (r) => ROLE_LABEL[r] || (r ? String(r) : '-');

// Site WAN state -> badge tone, label and a plain color for SVG fills.
export const WAN_META = {
  ok: { tone: 'ok', label: 'WAN up', color: '#6CB33F' },
  degraded: { tone: 'warn', label: 'WAN degraded', color: '#FBBF24' },
  down: { tone: 'crit', label: 'WAN down', color: '#F87171' },
};
export const wanMeta = (s) => WAN_META[String(s || '').toLowerCase()] || null;
export const NO_WAN_COLOR = '#6B7C8D';

export function WanBadge({ state, total, down, withCount = false }) {
  const m = wanMeta(state);
  if (!m) return <span className="text-[11px] text-ink-faint">-</span>;
  const t = Number(total);
  const d = Number(down);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={m.tone}>{m.label.replace('WAN ', '')}</Badge>
      {withCount && Number.isFinite(t) && t > 0 && <span className="text-[10px] text-ink-faint tnum">{`${Math.max(0, t - (Number.isFinite(d) ? d : 0))}/${t}`}</span>}
    </span>
  );
}

// Circuit state as the Circuits page uses it (critical = down), plus the event kinds.
export const EVENT_META = {
  down: { tone: 'crit', label: 'Down' },
  up: { tone: 'ok', label: 'Up' },
  'flap-start': { tone: 'warn', label: 'Flap start' },
  'flap-stop': { tone: 'neutral', label: 'Flap stop' },
  saturated: { tone: 'warn', label: 'Saturated' },
  cleared: { tone: 'ok', label: 'Cleared' },
};
export const eventMeta = (e) => EVENT_META[e] || { tone: 'neutral', label: e ? String(e) : '-' };
export const EVENT_KINDS = Object.keys(EVENT_META);

export function EventBadge({ event }) {
  const m = eventMeta(event);
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

// Issues page deep link: the shared table kit starts filtered by ?q= (search
// covers message, type and target), so the issue target text is the query.
// An issue key is "type|source|target"; the target segment is what the search matches.
export const issueTargetOf = (key, fallback = '') => {
  const parts = String(key || '').split('|');
  return parts.length >= 3 ? parts.slice(2).join('|') : fallback;
};
export const issuesLink = (key, fallback = '') => `/logicmonitor/issues?q=${encodeURIComponent(issueTargetOf(key, fallback))}`;

// The route answers a row with the saved note; a demo or permission refusal
// comes back as { error } and is shown as written.
export function NoteCell({ ev, onSaved, compact = false }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(ev.note || '');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');

  const save = async () => {
    if (!text.trim()) { setRefusal('Write a note first.'); return; }
    setBusy(true); setRefusal('');
    try {
      const { data } = await client.put(`/logicmonitor/circuits/events/${encodeURIComponent(ev.id)}/note`, { note: text.trim() });
      onSaved?.({ ...ev, ...(data && typeof data === 'object' ? data : {}), note: data?.note ?? text.trim() });
      setEditing(false);
      toast({ type: 'success', title: 'Note saved' });
    } catch (err) {
      setRefusal(err?.response?.data?.error || 'Could not save the note.');
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <span className="inline-flex items-start gap-1.5 min-w-0">
        <span className={`text-[11px] ${ev.note ? 'text-ink' : 'text-ink-faint'} ${compact ? 'truncate max-w-[220px]' : ''}`} title={ev.note || undefined}>{ev.note || 'No note'}</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); setText(ev.note || ''); setRefusal(''); setEditing(true); }}
          aria-label="Edit note" title="Edit note" className="text-ink-faint hover:text-brand cursor-pointer shrink-0"><Pencil size={12} /></button>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1 min-w-[220px]" onClick={(e) => e.stopPropagation()}>
      <span className="flex items-center gap-1">
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} autoFocus aria-label="Event note"
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          className={`${sel} w-full`} placeholder="Carrier ticket, cause, who was told..." />
        <button type="button" onClick={save} disabled={busy} aria-label="Save note" className="text-status-ok hover:opacity-80 cursor-pointer disabled:opacity-40"><Check size={14} /></button>
        <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="text-ink-faint hover:text-ink cursor-pointer"><X size={14} /></button>
      </span>
      {refusal && <span className="text-[10px] text-status-warn">{refusal}</span>}
    </span>
  );
}

export function whenText(iso) {
  return iso ? fmtWhen(iso) : '-';
}

export const circuitName = (c) => [c.deviceName, c.port].filter(Boolean).join(' ');

// WAN1, WAN2, ... in the order carrier then circuit id then device and port.
export function numberWans(circuits) {
  return arr(circuits).slice().sort((a, b) => (
    String(a.carrier || '~').localeCompare(String(b.carrier || '~'))
    || String(a.circuitId || '~').localeCompare(String(b.circuitId || '~'))
    || circuitName(a).localeCompare(circuitName(b))
  )).map((c, i) => ({ ...c, wanLabel: `WAN${i + 1}` }));
}
