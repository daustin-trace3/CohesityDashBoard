import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderKanban, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel } from '../../components/ui/primitives';
import { TabSaveBar } from '../../components/settings/SettingRow';
import { SectionPanel, inp, sel, iconBtn } from './ui';
import { fmtNum, arr } from './helpers';

const MAX_PICKS = 64;

// Same rule as the backend default label (section 4 of the round 14 contract).
const KEEP_UPPER = new Set(['ddi', 'wan', 'lan', 'dns', 'dhcp', 'aws', 'vpn', 'ipam', 'sdwan', 'ldap', 'ntp', 'ise', 'sql', 'api', 'nas', 'san']);
export function deriveLabel(name) {
  const words = String(name || '').split('/').pop().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.map((w) => {
    if (/^[A-Z0-9]{2,5}$/.test(w) && /[A-Z]/.test(w)) return w;
    if (KEEP_UPPER.has(w.toLowerCase())) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function parsePicks(text) {
  if (!text) return [];
  try {
    const v = typeof text === 'string' ? JSON.parse(text) : text;
    return arr(v).filter((p) => p && Number.isInteger(Number(p.sourceId)) && Number.isInteger(Number(p.groupId)))
      .map((p) => ({ sourceId: Number(p.sourceId), groupId: Number(p.groupId), label: p.label ? String(p.label) : '' }));
  } catch { return []; }
}

const serialize = (picks) => JSON.stringify(picks.map((p) => (p.label && p.label.trim()
  ? { sourceId: p.sourceId, groupId: p.groupId, label: p.label.trim() }
  : { sourceId: p.sourceId, groupId: p.groupId })));

export default function LmServiceGroupsPanel({ sources }) {
  const { toast } = useToast();
  const [saved, setSaved] = useState(null); // serialized string
  const [picks, setPicks] = useState(null);
  const [sourceId, setSourceId] = useState(null);
  const [groupsBySource, setGroupsBySource] = useState({}); // id -> array
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);

  const srcList = arr(sources);
  useEffect(() => { if (sourceId == null && srcList.length) setSourceId(srcList[0].id); }, [srcList, sourceId]);

  useEffect(() => {
    client.get('/logicmonitor/config')
      .then(({ data }) => {
        const p = parsePicks(data?.lm_service_groups);
        setPicks(p); setSaved(serialize(p));
        // Open the picker on the portal the existing picks come from.
        if (p.length) setSourceId(p[0].sourceId);
      })
      .catch(() => { setPicks([]); setSaved(serialize([])); });
  }, []);

  // Names for picks may live on any source, so load every source's groups once.
  useEffect(() => {
    for (const s of srcList) {
      if (groupsBySource[s.id]) continue;
      client.get(`/logicmonitor/sources/${s.id}/groups`)
        .then(({ data }) => setGroupsBySource((cur) => ({ ...cur, [s.id]: arr(data) })))
        .catch(() => setGroupsBySource((cur) => ({ ...cur, [s.id]: [] })));
    }
  }, [srcList]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => (groupsBySource[sourceId] || []).slice()
    .sort((a, b) => String(a.fullPath || a.name).localeCompare(String(b.fullPath || b.name))), [groupsBySource, sourceId]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return groups.filter((g) => !term || String(g.fullPath || g.name).toLowerCase().includes(term));
  }, [groups, q]);

  const lookup = useCallback((p) => (groupsBySource[p.sourceId] || []).find((g) => Number(g.id) === p.groupId), [groupsBySource]);
  const isPicked = (g) => (picks || []).some((p) => p.sourceId === Number(sourceId) && p.groupId === Number(g.id));

  const toggle = (g) => {
    setPicks((cur) => {
      const has = cur.some((p) => p.sourceId === Number(sourceId) && p.groupId === Number(g.id));
      if (has) return cur.filter((p) => !(p.sourceId === Number(sourceId) && p.groupId === Number(g.id)));
      if (cur.length >= MAX_PICKS) { toast({ type: 'error', title: `At most ${MAX_PICKS} services` }); return cur; }
      return [...cur, { sourceId: Number(sourceId), groupId: Number(g.id), label: '' }];
    });
  };
  const move = (i, d) => setPicks((cur) => {
    const j = i + d;
    if (j < 0 || j >= cur.length) return cur;
    const next = cur.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const setLabel = (i, v) => setPicks((cur) => cur.map((p, k) => (k === i ? { ...p, label: v.slice(0, 60) } : p)));
  const remove = (i) => setPicks((cur) => cur.filter((_, k) => k !== i));

  const dirty = picks != null && serialize(picks) !== saved;

  const save = async () => {
    setSaving(true);
    try {
      const body = { lm_service_groups: picks.length ? serialize(picks) : '' };
      await client.put('/logicmonitor/config', body);
      setSaved(serialize(picks));
      toast({ type: 'success', title: 'Saved', message: 'The header shows these services while you are on a LogicMonitor page.' });
      window.dispatchEvent(new Event('platforms-changed'));
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionPanel icon={FolderKanban} title="Service groups"
      blurb="Pick the LogicMonitor groups that count as services. While you are on a LogicMonitor page the header shows one tab per service with its state instead of the platform tabs. Installed-pack builds show services on the Groups page only.">
      {picks == null ? <LoadingPanel label="Loading..." height={100} /> : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs font-semibold text-ink">Groups</p>
                {srcList.length > 1 && (
                  <select value={sourceId ?? ''} onChange={(e) => setSourceId(Number(e.target.value))} className={`${sel} ml-auto`} aria-label="Portal">
                    {srcList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                )}
              </div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter groups..." className={`${inp} mb-2`} spellCheck={false} />
              {srcList.length === 0 ? (
                <p className="text-sm text-ink-muted py-3">No portal connected yet.</p>
              ) : !groupsBySource[sourceId] ? <LoadingPanel label="Loading groups..." height={80} /> : groups.length === 0 ? (
                <p className="text-sm text-ink-muted py-3">No groups stored yet. They arrive with the first poll.</p>
              ) : (
                <div className="max-h-96 overflow-y-auto border border-cohesity-border rounded-lg p-2">
                  {shown.map((g) => {
                    const path = String(g.fullPath || g.name);
                    const depth = path.split('/').length - 1;
                    return (
                      <label key={g.id} className="flex items-center gap-2 py-0.5 text-xs text-ink cursor-pointer hover:bg-surface-overlay/60 rounded" style={{ paddingLeft: depth * 16 }}>
                        <input type="checkbox" checked={isPicked(g)} onChange={() => toggle(g)} />
                        <span className="truncate" title={path}>{g.name || path}</span>
                        <span className="text-[10px] text-ink-faint tnum ml-auto pr-1">{fmtNum(g.numOfHosts)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold text-ink mb-2">Services <span className="text-ink-faint font-normal">({picks.length} of {MAX_PICKS})</span></p>
              {picks.length === 0 ? (
                <p className="text-sm text-ink-muted py-3">No services picked. The header keeps the platform tabs.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {picks.map((p, i) => {
                    const g = lookup(p);
                    const known = g || groupsBySource[p.sourceId];
                    const missing = !g && !!groupsBySource[p.sourceId];
                    const name = g ? String(g.fullPath || g.name) : `Group ${p.groupId}`;
                    const srcName = srcList.length > 1 ? srcList.find((s) => s.id === p.sourceId)?.name : null;
                    return (
                      <div key={`${p.sourceId}-${p.groupId}`} className="flex items-center gap-2 border border-cohesity-border rounded-lg px-2 py-1.5">
                        <div className="flex flex-col">
                          <button type="button" className={iconBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={12} /></button>
                          <button type="button" className={`${iconBtn} mt-0.5`} disabled={i === picks.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={12} /></button>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-ink-muted truncate" title={name}>
                            {name}{srcName ? ` (${srcName})` : ''}
                            {missing ? <span className="ml-2 text-[10px] px-1.5 rounded border border-status-warn/50 text-status-warn">missing</span> : null}
                          </p>
                          <input value={p.label} onChange={(e) => setLabel(i, e.target.value)} maxLength={60}
                            placeholder={known ? deriveLabel(g?.name || name) : deriveLabel(name)} className={`${inp} mt-1 py-1`} aria-label="Label" />
                        </div>
                        <button type="button" className={iconBtn} onClick={() => remove(i)} aria-label="Remove"><Trash2 size={12} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <TabSaveBar onSave={save} saving={saving} dirty={dirty} />
        </>
      )}
    </SectionPanel>
  );
}
