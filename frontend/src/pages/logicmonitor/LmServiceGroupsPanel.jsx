import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderKanban, ArrowUp, ArrowDown, Trash2, Plus, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel } from '../../components/ui/primitives';
import { TabSaveBar } from '../../components/settings/SettingRow';
import { SectionPanel, inp, sel, iconBtn } from './ui';
import { fmtNum, arr } from './helpers';

const MAX_SERVICES = 64;
const MAX_MEMBERS = 32;
const PATTERN_OK = /^[A-Za-z0-9 \-_.()*/]+$/;

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

const slugify = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'service';

// Round 14 entries ({ sourceId, groupId, label? }) become one-group services with the id <sid>-<gid>.
function parseServices(text) {
  if (!text) return [];
  try {
    const v = typeof text === 'string' ? JSON.parse(text) : text;
    return arr(v).map((p) => {
      if (!p || typeof p !== 'object') return null;
      if (!Array.isArray(p.members)) {
        if (!Number.isInteger(Number(p.sourceId)) || !Number.isInteger(Number(p.groupId))) return null;
        return { id: `${Number(p.sourceId)}-${Number(p.groupId)}`, label: p.label ? String(p.label) : '', members: [{ kind: 'group', sourceId: Number(p.sourceId), groupId: Number(p.groupId) }] };
      }
      return { id: p.id ? String(p.id) : null, label: p.label ? String(p.label) : '', members: p.members.filter((m) => m && typeof m === 'object').map((m) => ({ ...m })) };
    }).filter(Boolean);
  } catch { return []; }
}

// Ids: keep the ones already pinned, derive the rest from the label (de-duplicated with -2, -3).
function withIds(list) {
  const used = new Set(list.map((s) => s.id).filter(Boolean));
  return list.map((s) => {
    if (s.id) return s;
    let base = slugify(s.label);
    let id = base;
    for (let n = 2; used.has(id); n += 1) { const suf = `-${n}`; id = `${base.slice(0, 40 - suf.length)}${suf}`; }
    used.add(id);
    return { ...s, id };
  });
}
const isSingleGroup = (s) => s.members.length === 1 && s.members[0].kind === 'group';

function serialize(list) {
  return JSON.stringify(withIds(list).map((s) => {
    const o = { id: s.id };
    if (s.label && s.label.trim()) o.label = s.label.trim();
    o.members = s.members.map((m) => {
      if (m.kind === 'group') return { kind: 'group', sourceId: m.sourceId, groupId: m.groupId };
      if (m.kind === 'pattern') return { kind: 'pattern', sourceId: m.sourceId ?? null, match: m.match };
      return { kind: 'role', sourceId: m.sourceId ?? null, role: m.role };
    });
    return o;
  }));
}

function problem(list) {
  for (const s of list) {
    if (!s.members.length) return `${s.label || 'A new service'} has no members yet.`;
    if (!isSingleGroup(s) && !(s.label || '').trim()) return 'Every service with a pattern, a role or several members needs a name.';
  }
  return null;
}

export default function LmServiceGroupsPanel({ sources }) {
  const { toast } = useToast();
  const [saved, setSaved] = useState(null); // serialized string
  const [list, setList] = useState(null);
  const [selected, setSelected] = useState(0);
  const [sourceId, setSourceId] = useState(null);
  const [groupsBySource, setGroupsBySource] = useState({});
  const [roles, setRoles] = useState([]);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);
  // Add-member row
  const [addKind, setAddKind] = useState('pattern');
  const [pattern, setPattern] = useState('');
  const [role, setRole] = useState('firewall');
  const [addSource, setAddSource] = useState('');
  const [preview, setPreview] = useState(null);

  const srcList = arr(sources);
  useEffect(() => { if (sourceId == null && srcList.length) setSourceId(srcList[0].id); }, [srcList, sourceId]);

  useEffect(() => {
    client.get('/logicmonitor/config')
      .then(({ data }) => {
        const p = parseServices(data?.lm_service_groups);
        setList(p); setSaved(serialize(p));
        const g = p.flatMap((s) => s.members).find((m) => m.kind === 'group');
        if (g) setSourceId(g.sourceId);
      })
      .catch(() => { setList([]); setSaved(serialize([])); });
    client.get('/logicmonitor/services/roles').then(({ data }) => setRoles(arr(data))).catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    for (const s of srcList) {
      if (groupsBySource[s.id]) continue;
      client.get(`/logicmonitor/sources/${s.id}/groups`)
        .then(({ data }) => setGroupsBySource((cur) => ({ ...cur, [s.id]: arr(data) })))
        .catch(() => setGroupsBySource((cur) => ({ ...cur, [s.id]: [] })));
    }
  }, [srcList]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live preview for the member being typed (debounced).
  useEffect(() => {
    if (addKind === 'group') { setPreview(null); return undefined; }
    const params = {};
    if (addKind === 'pattern') {
      if (!pattern.trim() || !PATTERN_OK.test(pattern) || pattern.length > 200) { setPreview(null); return undefined; }
      params.match = pattern.trim();
    } else params.role = role;
    if (addSource) params.sourceId = addSource;
    let live = true;
    const t = setTimeout(() => {
      client.get('/logicmonitor/services/preview', { params })
        .then(({ data }) => { if (live) setPreview(data || null); })
        .catch(() => { if (live) setPreview(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [addKind, pattern, role, addSource]);

  const groups = useMemo(() => (groupsBySource[sourceId] || []).slice()
    .sort((a, b) => String(a.fullPath || a.name).localeCompare(String(b.fullPath || b.name))), [groupsBySource, sourceId]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return groups.filter((g) => !term || String(g.fullPath || g.name).toLowerCase().includes(term));
  }, [groups, q]);

  const lookup = useCallback((sid, gid) => (groupsBySource[sid] || []).find((g) => Number(g.id) === gid), [groupsBySource]);
  const cur = list && list[selected] ? list[selected] : null;
  const hasGroup = (g) => !!cur && cur.members.some((m) => m.kind === 'group' && m.sourceId === Number(sourceId) && m.groupId === Number(g.id));

  const patch = (i, fn) => setList((l) => l.map((s, k) => (k === i ? fn(s) : s)));
  const addMember = (member) => {
    if (!cur) { toast({ type: 'error', title: 'Select a service first', message: 'Click a service card on the right, or add a new service.' }); return; }
    if (cur.members.length >= MAX_MEMBERS) { toast({ type: 'error', title: `At most ${MAX_MEMBERS} members per service` }); return; }
    patch(selected, (s) => ({ ...s, members: [...s.members, member] }));
  };
  const toggleGroup = (g) => {
    if (!cur) { toast({ type: 'error', title: 'Select a service first', message: 'Click a service card on the right, or add a new service.' }); return; }
    const sid = Number(sourceId); const gid = Number(g.id);
    if (hasGroup(g)) patch(selected, (s) => ({ ...s, members: s.members.filter((m) => !(m.kind === 'group' && m.sourceId === sid && m.groupId === gid)) }));
    else addMember({ kind: 'group', sourceId: sid, groupId: gid });
  };
  const removeMember = (i, mi) => patch(i, (s) => ({ ...s, members: s.members.filter((_, k) => k !== mi) }));
  const newService = () => {
    if (list.length >= MAX_SERVICES) { toast({ type: 'error', title: `At most ${MAX_SERVICES} services` }); return; }
    // New card goes to the top so it sits beside the Groups list without scrolling; the
    // arrows move it down the header order later.
    setList((l) => [{ id: null, label: '', members: [] }, ...l]);
    setSelected(0);
  };
  const moveService = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    setList((l) => { const next = l.slice(); [next[i], next[j]] = [next[j], next[i]]; return next; });
    setSelected((s) => (s === i ? j : s === j ? i : s));
  };
  const removeService = (i) => {
    setList((l) => l.filter((_, k) => k !== i));
    setSelected((s) => (s > i ? s - 1 : s === i ? Math.max(0, i - 1) : s));
  };
  const submitMember = () => {
    const sid = addSource ? Number(addSource) : null;
    if (addKind === 'pattern') {
      const m = pattern.trim();
      if (!m) return;
      if (!PATTERN_OK.test(m)) { toast({ type: 'error', title: 'Pattern not allowed', message: 'Use letters, digits, space and * / - _ . ( )' }); return; }
      addMember({ kind: 'pattern', sourceId: sid, match: m });
      setPattern('');
    } else if (addKind === 'role') addMember({ kind: 'role', sourceId: sid, role });
  };

  const dirty = list != null && serialize(list) !== saved;
  const issue = list ? problem(list) : null;

  const save = async () => {
    if (issue) { toast({ type: 'error', title: 'Cannot save yet', message: issue }); return; }
    setSaving(true);
    try {
      const pinned = withIds(list);
      const body = { lm_service_groups: pinned.length ? serialize(list) : '' };
      await client.put('/logicmonitor/config', body);
      setList(pinned); setSaved(serialize(pinned));
      toast({ type: 'success', title: 'Saved', message: 'The header shows these services while you are on a LogicMonitor page.' });
      window.dispatchEvent(new Event('platforms-changed'));
    } catch (err) {
      const d = err?.response?.data;
      toast({ type: 'error', title: 'Save failed', message: d?.details?.[0]?.msg || d?.error });
    } finally {
      setSaving(false);
    }
  };

  const memberText = (m) => {
    if (m.kind === 'group') {
      const g = lookup(m.sourceId, m.groupId);
      return { text: g ? String(g.fullPath || g.name) : `Group ${m.groupId}`, missing: !g && !!groupsBySource[m.sourceId] };
    }
    if (m.kind === 'pattern') return { text: m.match, missing: false };
    return { text: m.role, missing: false };
  };
  const portalName = (sid) => (sid == null ? (srcList.length > 1 ? 'all portals' : null) : (srcList.length > 1 ? srcList.find((s) => s.id === sid)?.name : null));
  const KIND_CHIP = { group: 'Group', pattern: 'Pattern', role: 'Role' };

  return (
    <SectionPanel icon={FolderKanban} title="Service groups"
      blurb="Define services for the header. A service is one LogicMonitor group, or a group of groups: add path patterns such as **/*_Firewalls and device roles as members, and the service rolls up every device they cover. While you are on a LogicMonitor page the header shows one pill per service with its state. Installed-pack builds show services on the Groups page only.">
      {list == null ? <LoadingPanel label="Loading..." height={100} /> : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs font-semibold text-ink">Groups <span className="text-ink-faint font-normal">(ticks add to the selected service)</span></p>
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
                        <input type="checkbox" checked={hasGroup(g)} onChange={() => toggleGroup(g)} />
                        <span className="truncate" title={path}>{g.name || path}</span>
                        <span className="text-[10px] text-ink-faint tnum ml-auto pr-1">{fmtNum(g.numOfHosts)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs font-semibold text-ink">Services <span className="text-ink-faint font-normal">({list.length} of {MAX_SERVICES})</span></p>
                <button type="button" className={`${sel} ml-auto inline-flex items-center gap-1 cursor-pointer`} onClick={newService}><Plus size={12} /> New service</button>
              </div>
              {list.length === 0 ? (
                <p className="text-sm text-ink-muted py-3">No services defined. The header keeps the platform tabs. Use New service, then tick groups or add a pattern or role.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {list.map((s, i) => {
                    const active = i === selected;
                    const single = isSingleGroup(s);
                    const g0 = single ? lookup(s.members[0].sourceId, s.members[0].groupId) : null;
                    return (
                      <div key={s.id || `new-${i}`} onClick={() => setSelected(i)}
                        className={`border rounded-lg px-2 py-2 cursor-pointer ${active ? 'border-brand ring-1 ring-brand/40' : 'border-cohesity-border'}`}>
                        <div className="flex items-center gap-2">
                          <div className="flex flex-col">
                            <button type="button" className={iconBtn} disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveService(i, -1); }} aria-label="Move up"><ArrowUp size={12} /></button>
                            <button type="button" className={`${iconBtn} mt-0.5`} disabled={i === list.length - 1} onClick={(e) => { e.stopPropagation(); moveService(i, 1); }} aria-label="Move down"><ArrowDown size={12} /></button>
                          </div>
                          <div className="min-w-0 flex-1">
                            <input value={s.label} onChange={(e) => patch(i, (x) => ({ ...x, label: e.target.value.slice(0, 60) }))} maxLength={60}
                              onClick={(e) => e.stopPropagation()} onFocus={() => setSelected(i)}
                              placeholder={single && g0 ? deriveLabel(g0.name) : 'Service name'} className={`${inp} py-1`} aria-label="Service name" />
                            <p className="text-[10px] text-ink-faint mt-0.5 truncate">{s.id ? `id ${s.id}` : `id from the name on save: ${slugify(s.label)}`}</p>
                          </div>
                          <button type="button" className={iconBtn} onClick={(e) => { e.stopPropagation(); removeService(i); }} aria-label="Delete service"><Trash2 size={12} /></button>
                        </div>
                        <div className="mt-2 flex flex-col gap-1">
                          {s.members.length === 0 && <p className="text-[11px] text-ink-muted">No members.{active ? ' Tick groups on the left or add a pattern or role below.' : ''}</p>}
                          {s.members.map((m, mi) => {
                            const t = memberText(m);
                            const pn = portalName(m.sourceId);
                            return (
                              <div key={`${m.kind}-${mi}`} className="flex items-center gap-2 text-xs">
                                <span className="text-[10px] px-1.5 rounded border border-cohesity-border text-ink-muted flex-shrink-0">{KIND_CHIP[m.kind] || m.kind}</span>
                                <span className="truncate text-ink" title={t.text}>{t.text}</span>
                                {pn ? <span className="text-[10px] text-ink-faint flex-shrink-0">{pn}</span> : null}
                                {t.missing ? <span className="text-[10px] px-1.5 rounded border border-status-warn/50 text-status-warn flex-shrink-0">missing</span> : null}
                                <button type="button" className={`${iconBtn} ml-auto flex-shrink-0`} onClick={(e) => { e.stopPropagation(); removeMember(i, mi); }} aria-label="Remove member"><X size={12} /></button>
                              </div>
                            );
                          })}
                        </div>
                        {active && (
                          <div className="mt-2 pt-2 border-t border-cohesity-border" onClick={(e) => e.stopPropagation()}>
                            <div className="flex flex-wrap items-center gap-2">
                              <select value={addKind} onChange={(e) => setAddKind(e.target.value)} className={sel} aria-label="Member kind">
                                <option value="group">Group</option>
                                <option value="pattern">Path pattern</option>
                                <option value="role">Device role</option>
                              </select>
                              {addKind === 'group' && <span className="text-[11px] text-ink-muted">Tick groups in the list on the left.</span>}
                              {addKind === 'pattern' && (
                                <input value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitMember(); }}
                                  placeholder="**/*_Firewalls" className={`${inp} py-1 flex-1 min-w-[10rem]`} spellCheck={false} aria-label="Path pattern" />
                              )}
                              {addKind === 'role' && (
                                <select value={role} onChange={(e) => setRole(e.target.value)} className={sel} aria-label="Device role">
                                  {(roles.length ? roles : [{ role: 'firewall', label: 'Firewall', devices: 0 }]).map((r) => <option key={r.role} value={r.role}>{r.label || r.role} ({fmtNum(r.devices)})</option>)}
                                </select>
                              )}
                              {addKind !== 'group' && srcList.length > 1 && (
                                <select value={addSource} onChange={(e) => setAddSource(e.target.value)} className={sel} aria-label="Portal for the member">
                                  <option value="">All portals</option>
                                  {srcList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                                </select>
                              )}
                              {addKind !== 'group' && (
                                <button type="button" className={`${sel} inline-flex items-center gap-1 cursor-pointer`} onClick={submitMember}
                                  disabled={addKind === 'pattern' && !pattern.trim()}><Plus size={12} /> Add member</button>
                              )}
                            </div>
                            {addKind !== 'group' && (
                              <p className="text-[11px] text-ink-muted mt-1.5" title={preview && arr(preview.sample).length ? arr(preview.sample).join('\n') : undefined}>
                                {addKind === 'pattern' && !pattern.trim() ? '* stays inside one path level, ** crosses levels.'
                                  : preview == null ? 'Checking...'
                                    : addKind === 'pattern' ? `Matches ${fmtNum(preview.groups)} groups, ${fmtNum(preview.devices)} devices.`
                                      : `${fmtNum(preview.devices)} devices have this role.`}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {issue && dirty ? <p className="text-[11px] text-status-warn mt-2">{issue}</p> : null}
            </div>
          </div>
          <TabSaveBar onSave={save} saving={saving} dirty={dirty} />
        </>
      )}
    </SectionPanel>
  );
}
