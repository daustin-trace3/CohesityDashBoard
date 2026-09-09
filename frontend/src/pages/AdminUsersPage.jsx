import { useEffect, useState, useCallback } from 'react';
import { Users, UserPlus, Shield, KeyRound, Pencil, Trash2, Plus, X, Copy, Check, Power, ChevronDown, ChevronRight, Building2 } from 'lucide-react';
import client from '../api/client';
import { PageHeader, Badge, LastUpdated } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import { useAuth } from '../auth/AuthContext';
import { usePlatforms } from '../platforms/PlatformsContext';
import AdminNav from '../components/AdminNav';
import DirectoryTab from './DirectoryTab';

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
const LEVELS = ['view', 'manage', '*'];

const TABS = [
  { key: 'users', label: 'Users', icon: Users },
  { key: 'groups', label: 'Groups', icon: Shield },
  { key: 'service-accounts', label: 'Service Accounts', icon: KeyRound },
  { key: 'directory', label: 'Directory', icon: Building2 },
];

function errorMessage(err, fallback) {
  return err?.response?.data?.error || fallback;
}

/* ── Modal shell ─────────────────────────────────────────────────────────── */
function Modal({ title, onClose, children, wide }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className={`relative bg-cohesity-gray border border-cohesity-border rounded-lg w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] flex flex-col shadow-xl animate-fade-in`}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-cohesity-border flex-shrink-0">
          <p className="text-sm font-bold text-ink">{title}</p>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/* ── Platform access matrix: one row per platform, None/View/Manage.
 *    Writes plain `<ns>:*:<level>` grants — same storage, friendlier editing.
 *    Rows come from the platform registry so new platforms appear on their own. ── */
const MATRIX_LEVELS = [
  { key: 'none', label: 'None' },
  { key: 'view', label: 'View' },
  { key: 'manage', label: 'Manage' },
];

// `<ns>:*:*` counts as manage for display — level '*' and 'manage' are
// equivalent for everything the app enforces (view/manage only).
function directLevel(grants, ns) {
  if (grants.some(p => p === `${ns}:*:*` || p === `${ns}:*:manage`)) return 'manage';
  if (grants.some(p => p === `${ns}:*:view`)) return 'view';
  return 'none';
}

function PlatformAccessEditor({ grants, onAdd, onRemove }) {
  const { platforms } = usePlatforms();
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const rows = [
    { ns: '*', label: 'All platforms', hint: 'includes future platforms and administration' },
    ...platforms.map(p => ({ ns: p.id, label: p.label, color: p.color })),
    { ns: 'admin', label: 'Administration', hint: 'settings, users, plugins, licensing' },
  ];
  const globalLvl = directLevel(grants, '*');

  // Grants the matrix can't express (section-scoped or unknown namespaces)
  // live in the Advanced section as removable chips.
  const matrixPerms = new Set(rows.flatMap(r => LEVELS.map(l => `${r.ns}:*:${l}`)));
  const advancedGrants = grants.filter(p => !matrixPerms.has(p));

  const setLevel = async (ns, level) => {
    if (busy) return;
    setBusy(true);
    try {
      for (const lvl of LEVELS) {
        const perm = `${ns}:*:${lvl}`;
        if (grants.includes(perm) && perm !== `${ns}:*:${level}`) await onRemove(perm);
      }
      if (level !== 'none' && !grants.includes(`${ns}:*:${level}`)) await onAdd(`${ns}:*:${level}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="border border-cohesity-border rounded-lg overflow-hidden">
        {rows.map((r, i) => {
          const direct = directLevel(grants, r.ns);
          const isGlobalRow = r.ns === '*';
          // A platform row is covered by the all-platforms grant even at None.
          const inherited = !isGlobalRow && direct === 'none' && globalLvl !== 'none' ? globalLvl : null;
          const effective = inherited || direct;
          return (
            <div key={r.ns}
              className={`flex items-center justify-between gap-3 px-3 py-2 ${i > 0 ? 'border-t border-cohesity-border' : ''} ${isGlobalRow ? 'bg-surface-overlay' : ''}`}>
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink flex items-center gap-2">
                  {r.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />}
                  {r.label}
                  {inherited && <span className="text-[10px] font-normal text-ink-faint">via all-platforms</span>}
                </p>
                {r.hint && <p className="text-[10px] text-ink-faint mt-0.5">{r.hint}</p>}
              </div>
              <div className="flex rounded-lg border border-cohesity-border overflow-hidden flex-shrink-0">
                {MATRIX_LEVELS.map(l => {
                  const active = effective === l.key;
                  const fromInherit = active && inherited;
                  return (
                    <button key={l.key} type="button" disabled={busy}
                      onClick={() => setLevel(r.ns, l.key)}
                      className={`px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                        active
                          ? l.key === 'none'
                            ? 'bg-surface-overlay text-ink'
                            : fromInherit ? 'bg-brand/5 text-brand/70' : 'bg-brand/15 text-brand'
                          : 'text-ink-faint hover:text-ink hover:bg-surface-overlay'
                      }`}>
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <button type="button" onClick={() => setShowAdvanced(o => !o)}
          className="flex items-center gap-1 text-[11px] font-medium text-ink-faint hover:text-ink transition-colors cursor-pointer">
          {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced: section-scoped grants{advancedGrants.length > 0 ? ` (${advancedGrants.length})` : ''}
        </button>
        {showAdvanced && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {advancedGrants.length === 0 && <p className="text-[11px] text-ink-faint">No section-scoped grants.</p>}
              {advancedGrants.map(p => <PermissionChip key={p} perm={p} onRemove={() => onRemove(p)} />)}
            </div>
            <PermissionBuilder onAdd={onAdd} namespaces={rows.map(r => r.ns)} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Permission string builder row: namespace / section / level → ns:section:level ── */
function PermissionBuilder({ onAdd, namespaces }) {
  const [namespace, setNamespace] = useState('cohesity');
  const [section, setSection] = useState('*');
  const [level, setLevel] = useState('view');

  const add = () => {
    const sec = (section || '*').trim() || '*';
    onAdd(`${namespace}:${sec}:${level}`);
    setSection('*');
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-1.5 flex-wrap">
        <div>
          <label className="text-[10px] font-medium text-ink-faint uppercase tracking-wider mb-0.5 block">Platform</label>
          <select value={namespace} onChange={e => setNamespace(e.target.value)} className={`${inputClass} w-auto`}>
            {namespaces.map(n => <option key={n} value={n}>{n === '*' ? '* (all)' : n}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-medium text-ink-faint uppercase tracking-wider mb-0.5 block">Section</label>
          <input value={section} onChange={e => setSection(e.target.value)} placeholder="*" title="Section within the platform (e.g. alerts, settings). Use * for all sections." className={`${inputClass} w-24`} />
        </div>
        <div>
          <label className="text-[10px] font-medium text-ink-faint uppercase tracking-wider mb-0.5 block">Access level</label>
          <select value={level} onChange={e => setLevel(e.target.value)} className={`${inputClass} w-auto`}>
            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <button onClick={add} type="button"
          className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer">
          <Plus size={12} /> Add
        </button>
      </div>
      <p className="text-[10px] text-ink-faint">Section is the API area within a platform (e.g. clusters, alerts, settings) — use * for all. Manage includes view.</p>
    </div>
  );
}

function PermissionChip({ perm, onRemove }) {
  return (
    <span className="chip bg-surface-overlay border-cohesity-border text-ink-muted font-mono">
      {perm}
      {onRemove && (
        <button onClick={onRemove} aria-label={`Remove ${perm}`} className="ml-1 text-ink-faint hover:text-status-crit cursor-pointer">
          <X size={10} />
        </button>
      )}
    </span>
  );
}

/* ── Directory object picker (shared by the user and group dialogs) ──────── */
function useDirectoryEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    client.get('/directory/config').then(({ data }) => setEnabled(!!data.configured)).catch(() => setEnabled(false));
  }, []);
  return enabled;
}

function SourceToggle({ value, onChange }) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start">
      {[{ id: 'local', label: 'Local' }, { id: 'ad', label: 'Active Directory' }].map(o => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)}
          className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${value === o.id ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Type a name, pick the AD object. kind = 'users' | 'groups'. */
function DirectoryPicker({ kind, selected, onPick }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Nothing is listed until the admin types: the directory is filtered by
  // what they enter (two characters minimum), debounced.
  const term = q.trim();
  useEffect(() => {
    if (selected) return undefined;
    if (term.length < 2) { setResults(null); setErr(null); return undefined; }
    const t = setTimeout(() => {
      setBusy(true); setErr(null);
      client.get(`/directory/${kind}`, { params: { q: term } })
        .then(({ data }) => setResults(data))
        .catch(e => { setResults([]); setErr(errorMessage(e, 'Directory search failed.')); })
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [term, kind, selected]);
  if (selected) {
    return (
      <div className="flex items-center gap-2 border border-brand/40 bg-brand/5 rounded-lg px-3 py-2">
        <Badge tone="info">AD</Badge>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-ink font-medium truncate">{kind === 'users' ? `${selected.displayName || selected.sam} (${selected.upn || selected.sam})` : selected.name}</p>
          <p className="text-[10px] text-ink-faint truncate" title={selected.dn}>{selected.dn}</p>
        </div>
        <button type="button" onClick={() => onPick(null)} aria-label="Clear selection" className="text-ink-faint hover:text-ink cursor-pointer"><X size={13} /></button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'users' ? 'Type a username or name to search the domain' : 'Type a group name to search the domain'} className={inputClass} />
      {err && <p className="text-[11px] text-status-crit">{err}</p>}
      {term.length < 2 ? (
        <p className="text-[11px] text-ink-faint px-1">Type at least two characters. The list narrows as you type.</p>
      ) : (
      <div className="border border-cohesity-border rounded-lg max-h-56 overflow-y-auto">
        {busy && !results && <p className="text-[11px] text-ink-faint px-3 py-2">Searching the directory...</p>}
        {results && results.length === 0 && <p className="text-[11px] text-ink-faint px-3 py-2">No {kind === 'users' ? 'user' : 'group'} matches "{term}".</p>}
        {(results || []).map(r => {
          const taken = kind === 'users' ? r.imported : r.linked;
          return (
            <button key={r.dn} type="button" disabled={!!taken || r.disabled} onClick={() => onPick(r)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left border-b border-cohesity-border/50 last:border-0 hover:bg-brand/10 disabled:opacity-50 disabled:cursor-default cursor-pointer">
              <span className="flex-1 min-w-0">
                <span className="block text-xs text-ink truncate">{kind === 'users' ? `${r.displayName || r.sam}` : r.name}</span>
                <span className="block text-[10px] text-ink-faint truncate">{kind === 'users' ? (r.upn || r.sam) : (r.description || r.dn)}</span>
              </span>
              {taken && <Badge tone="neutral">{kind === 'users' ? `added as ${r.imported}` : 'already added'}</Badge>}
              {r.disabled && <Badge tone="neutral">disabled in AD</Badge>}
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}

/* ── Users tab ───────────────────────────────────────────────────────────── */
function UserModal({ user, groups, onClose, onSaved }) {
  const isEdit = !!user;
  const { toast } = useToast();
  const [username, setUsername] = useState(user?.username || '');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [isActive, setIsActive] = useState(user?.isActive !== false);
  const [groupIds, setGroupIds] = useState(() => {
    if (!user) return [];
    const names = new Set(user.groups || []);
    return groups.filter(g => names.has(g.name)).map(g => g.id);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const directoryEnabled = useDirectoryEnabled();
  const [source, setSource] = useState('local');
  const [adUser, setAdUser] = useState(null);

  const toggleGroup = (id) => {
    setGroupIds(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      if (isEdit) {
        const payload = { displayName, isActive, groupIds };
        if (password) payload.password = password;
        await client.put(`/users/${user.id}`, payload);
      } else if (source === 'ad') {
        await client.post('/directory/users', { dn: adUser.dn, groupIds });
      } else {
        await client.post('/users', { username, password, displayName, groupIds });
      }
      toast({ type: 'success', title: isEdit ? 'User updated' : source === 'ad' ? 'Directory user added' : 'User created' });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not save the user.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={isEdit ? `Edit ${user.username}` : 'Create user'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {!isEdit && directoryEnabled && <SourceToggle value={source} onChange={(v) => { setSource(v); setAdUser(null); }} />}
        {!isEdit && source === 'ad' ? (
          <div>
            <label className="text-xs font-semibold text-ink mb-1 block">Directory user</label>
            <DirectoryPicker kind="users" selected={adUser} onPick={setAdUser} />
            <p className="text-[10px] text-ink-faint mt-1">Signs in with the domain password. Access comes from the groups ticked below plus any mirrored domain groups the user is in.</p>
          </div>
        ) : (
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block">Username</label>
          <input value={username} onChange={e => setUsername(e.target.value)} disabled={isEdit}
            className={`${inputClass} ${isEdit ? 'opacity-60' : ''}`} autoComplete="username" />
        </div>
        )}
        {(isEdit || source !== 'ad') && (
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block">Display name</label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputClass} />
        </div>
        )}
        {user?.provider === 'ad' || (!isEdit && source === 'ad') ? (
          user?.provider === 'ad' ? (
          <p className="text-[11px] text-ink-muted bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2">
            Directory account: signs in with the domain password. Membership in mirrored domain groups is managed by the sync; groups ticked here are added on top.
          </p>
          ) : null
        ) : (
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block">
            Password {isEdit && <span className="text-ink-faint font-normal">(leave blank to keep current)</span>}
          </label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputClass} autoComplete="new-password" />
        </div>
        )}
        <div>
          <label className="text-xs font-semibold text-ink mb-1.5 block">Groups</label>
          <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto border border-cohesity-border rounded-lg p-2.5">
            {groups.length === 0 && <p className="text-[11px] text-ink-faint">No groups available.</p>}
            {groups.map(g => (
              <label key={g.id} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} className="accent-brand cursor-pointer" />
                <span className="text-xs text-ink">{g.name}</span>
                {g.isSystem && <Badge tone="neutral">system</Badge>}
              </label>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="accent-brand cursor-pointer" />
          <span className="text-xs text-ink">Active</span>
        </label>
        {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
        <button onClick={save} disabled={saving || (!isEdit && (source === 'ad' ? !adUser : (!username || !password)))}
          className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
          {saving ? 'Saving…' : isEdit ? 'Save changes' : source === 'ad' ? 'Add directory user' : 'Create user'}
        </button>
      </div>
    </Modal>
  );
}

function UsersTab() {
  const { toast } = useToast();
  const [users, setUsers] = useState(null);
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState(null);
  const [modalUser, setModalUser] = useState(undefined); // undefined = closed, null = create, obj = edit
  const [deleteError, setDeleteError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([client.get('/users'), client.get('/users/groups')])
      .then(([u, g]) => { setUsers(u.data); setGroups(g.data); })
      .catch(err => setError(errorMessage(err, 'Could not load users.')));
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    setDeleteError(null);
    try {
      await client.delete(`/users/${u.id}`);
      toast({ type: 'success', title: 'User deleted' });
      load();
    } catch (err) {
      const msg = errorMessage(err, 'Could not delete the user.');
      if (err?.response?.status === 409) {
        setDeleteError(msg || 'Cannot delete the last active administrator.');
        toast({ type: 'error', title: 'Cannot delete user', message: msg });
      } else {
        toast({ type: 'error', title: 'Delete failed', message: msg });
      }
    }
  };

  if (error) return <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>;
  if (!users) return <p className="text-xs text-ink-faint">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setModalUser(null)}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer">
          <UserPlus size={13} /> Create user
        </button>
      </div>
      {deleteError && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{deleteError}</p>}
      <div className="panel p-0 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-cohesity-border text-ink-faint text-[10px] uppercase tracking-wider">
              <th className="text-left px-3 py-2 font-semibold">Username</th>
              <th className="text-left px-3 py-2 font-semibold">Display name</th>
              <th className="text-left px-3 py-2 font-semibold">Groups</th>
              <th className="text-left px-3 py-2 font-semibold">Active</th>
              <th className="text-left px-3 py-2 font-semibold">Last login</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-cohesity-border/50 last:border-0 hover:bg-surface-overlay/50">
                <td className="px-3 py-2 text-ink font-medium">
                  <span className="flex items-center gap-1.5">{u.username}{u.provider === 'ad' && <Badge tone="info">AD</Badge>}</span>
                </td>
                <td className="px-3 py-2 text-ink-muted">{u.displayName || '—'}</td>
                <td className="px-3 py-2 text-ink-muted">{(u.groups || []).join(', ') || '—'}</td>
                <td className="px-3 py-2">
                  <Badge tone={u.isActive ? 'ok' : 'neutral'}>{u.isActive ? 'Active' : 'Disabled'}</Badge>
                </td>
                <td className="px-3 py-2 text-ink-faint">{u.lastLoginAt ? <LastUpdated date={u.lastLoginAt} prefix="" /> : '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button onClick={() => setModalUser(u)} aria-label={`Edit ${u.username}`} className="text-ink-faint hover:text-brand cursor-pointer mr-2">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => remove(u)} aria-label={`Delete ${u.username}`} className="text-ink-faint hover:text-status-crit cursor-pointer">
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-faint">No users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {modalUser !== undefined && (
        <UserModal user={modalUser} groups={groups} onClose={() => setModalUser(undefined)} onSaved={load} />
      )}
    </div>
  );
}

/* ── Groups tab ──────────────────────────────────────────────────────────── */
function CreateGroupModal({ onClose, onSaved }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const directoryEnabled = useDirectoryEnabled();
  const [source, setSource] = useState('local');
  const [adGroup, setAdGroup] = useState(null);

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      if (source === 'ad') await client.post('/directory/links', { dn: adGroup.dn });
      else await client.post('/users/groups', { name, description });
      toast({ type: 'success', title: source === 'ad' ? 'Domain group added' : 'Group created', message: source === 'ad' ? 'Members are being pulled in. Grant it platform access below.' : undefined });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Could not create the group.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Create group" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {directoryEnabled && <SourceToggle value={source} onChange={(v) => { setSource(v); setAdGroup(null); }} />}
        {source === 'ad' ? (
          <div>
            <label className="text-xs font-semibold text-ink mb-1 block">Directory group</label>
            <DirectoryPicker kind="groups" selected={adGroup} onPick={setAdGroup} />
            <p className="text-[10px] text-ink-faint mt-1">Its members (nested groups included) are mirrored and kept current. Grant it platform access after adding.</p>
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Name</label>
              <input value={name} onChange={e => setName(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Description</label>
              <input value={description} onChange={e => setDescription(e.target.value)} className={inputClass} />
            </div>
          </>
        )}
        {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
        <button onClick={save} disabled={saving || (source === 'ad' ? !adGroup : !name.trim())}
          className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
          {saving ? 'Saving…' : source === 'ad' ? 'Add domain group' : 'Create group'}
        </button>
      </div>
    </Modal>
  );
}

function GroupsTab() {
  const { toast } = useToast();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [grants, setGrants] = useState(null);
  const [grantsError, setGrantsError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setError(null);
    client.get('/users/groups')
      .then(({ data }) => {
        setGroups(data);
        if (!selectedId && data.length > 0) setSelectedId(data[0].id);
      })
      .catch(err => setError(errorMessage(err, 'Could not load groups.')));
  }, [selectedId]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadGrants = useCallback((id) => {
    if (!id) return;
    setGrants(null);
    setGrantsError(null);
    client.get('/users/grants', { params: { subjectType: 'group', subjectId: id } })
      .then(({ data }) => setGrants((data || []).map(g => (typeof g === 'string' ? g : g.permission))))
      .catch(err => setGrantsError(errorMessage(err, 'Could not load grants.')));
  }, []);

  useEffect(() => { loadGrants(selectedId); }, [selectedId, loadGrants]);

  const selected = (groups || []).find(g => g.id === selectedId);

  const addGrant = async (permission) => {
    if (!selectedId) return;
    try {
      await client.post('/users/grants', { subjectType: 'group', subjectId: selectedId, permission });
      loadGrants(selectedId);
    } catch (err) {
      toast({ type: 'error', title: 'Could not add grant', message: errorMessage(err, 'Invalid permission string.') });
    }
  };

  const removeGrant = async (permission) => {
    if (!selectedId) return;
    try {
      await client.delete('/users/grants', { data: { subjectType: 'group', subjectId: selectedId, permission } });
      loadGrants(selectedId);
    } catch (err) {
      toast({ type: 'error', title: 'Could not remove grant', message: errorMessage(err, '') });
    }
  };

  const deleteGroup = async (g) => {
    if (!window.confirm(g.provider === 'ad' ? `Remove domain group "${g.name}" from ICC? Its access grants go with it; users stay.` : `Delete group "${g.name}"?`)) return;
    try {
      await client.delete(`/users/groups/${g.id}`);
      toast({ type: 'success', title: 'Group deleted' });
      setSelectedId(null);
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not delete group', message: errorMessage(err, 'System groups cannot be deleted.') });
    }
  };

  if (error) return <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>;
  if (!groups) return <p className="text-xs text-ink-faint">Loading…</p>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      <div className="flex flex-col gap-2">
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer self-start">
          <Plus size={13} /> New group
        </button>
        <div className="panel p-1 flex flex-col gap-0.5">
          {groups.map(g => (
            <button key={g.id} onClick={() => setSelectedId(g.id)}
              className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left text-xs transition-colors cursor-pointer ${
                selectedId === g.id ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink'
              }`}>
              <span className="truncate">{g.name}</span>
              {g.isSystem === 1 || g.isSystem === true ? <Badge tone="neutral">system</Badge> : g.provider === 'ad' ? <Badge tone="info">AD</Badge> : null}
            </button>
          ))}
          {groups.length === 0 && <p className="text-[11px] text-ink-faint px-2.5 py-2">No groups yet.</p>}
        </div>
      </div>

      <div className="panel p-4">
        {!selected ? (
          <p className="text-xs text-ink-faint">Select a group to manage its grants.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-ink flex items-center gap-2">
                  {selected.name}
                  {(selected.isSystem === 1 || selected.isSystem === true) && <Badge tone="neutral">system — rename/delete disabled</Badge>}
                  {selected.provider === 'ad' && <Badge tone="info">AD: {selected.externalName}</Badge>}
                </p>
                {selected.description && <p className="text-[11px] text-ink-muted mt-0.5">{selected.description}</p>}
              </div>
              {!(selected.isSystem === 1 || selected.isSystem === true) && (
                <button onClick={() => deleteGroup(selected)}
                  className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 text-status-crit border border-status-crit/30 rounded-lg hover:bg-status-crit/10 transition-colors cursor-pointer">
                  <Trash2 size={12} /> {selected.provider === 'ad' ? 'Remove domain group' : 'Delete group'}
                </button>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold text-ink mb-2">Grants</p>
              {grantsError && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2 mb-2">{grantsError}</p>}
              {grants === null ? (
                <p className="text-[11px] text-ink-faint">Loading…</p>
              ) : (
                <PlatformAccessEditor grants={grants} onAdd={addGrant} onRemove={removeGrant} />
              )}
            </div>
          </div>
        )}
      </div>
      {showCreate && <CreateGroupModal onClose={() => setShowCreate(false)} onSaved={load} />}
    </div>
  );
}

/* ── Service Accounts tab ────────────────────────────────────────────────── */
function CreateServiceAccountModal({ onClose, onSaved }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [issuedKey, setIssuedKey] = useState(null);
  const [copied, setCopied] = useState(false);

  const addPermission = (p) => setPermissions(prev => prev.includes(p) ? prev : [...prev, p]);
  const removePermission = (p) => setPermissions(prev => prev.filter(x => x !== p));

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const { data } = await client.post('/users/service-accounts', { name, permissions });
      setIssuedKey(data.key || data.fullKey || null);
      toast({ type: 'success', title: 'Service account created' });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, 'Could not create the service account.'));
    } finally {
      setSaving(false);
    }
  };

  const copyKey = () => {
    if (!issuedKey) return;
    navigator.clipboard?.writeText(issuedKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (issuedKey) {
    return (
      <Modal title="Service account created" onClose={onClose}>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-lg px-3 py-2">
            Store this key now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2 bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2">
            <code className="text-xs font-mono text-ink break-all flex-1">{issuedKey}</code>
            <button onClick={copyKey} aria-label="Copy key" className="text-ink-faint hover:text-brand cursor-pointer flex-shrink-0">
              {copied ? <Check size={14} className="text-status-ok" /> : <Copy size={14} />}
            </button>
          </div>
          <button onClick={onClose}
            className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer">
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create service account" onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="text-xs font-semibold text-ink mb-1.5 block">Permissions</label>
          <PlatformAccessEditor grants={permissions} onAdd={addPermission} onRemove={removePermission} />
        </div>
        {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
        <button onClick={save} disabled={saving || !name.trim() || permissions.length === 0}
          className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
          {saving ? 'Creating…' : 'Create service account'}
        </button>
      </div>
    </Modal>
  );
}

function ServiceAccountsTab() {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setError(null);
    client.get('/users/service-accounts')
      .then(({ data }) => setAccounts(data))
      .catch(err => setError(errorMessage(err, 'Could not load service accounts.')));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (a) => {
    try {
      await client.put(`/users/service-accounts/${a.id}`, { isActive: !a.isActive });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not update service account', message: errorMessage(err, '') });
    }
  };

  const revoke = async (a) => {
    if (!window.confirm(`Revoke service account "${a.name}"? This cannot be undone.`)) return;
    try {
      await client.delete(`/users/service-accounts/${a.id}`);
      toast({ type: 'success', title: 'Service account revoked' });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not revoke service account', message: errorMessage(err, '') });
    }
  };

  if (error) return <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>;
  if (!accounts) return <p className="text-xs text-ink-faint">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">{accounts.length} service account{accounts.length !== 1 ? 's' : ''}</p>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer">
          <Plus size={13} /> Create service account
        </button>
      </div>
      <div className="panel p-0 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-cohesity-border text-ink-faint text-[10px] uppercase tracking-wider">
              <th className="text-left px-3 py-2 font-semibold">Name</th>
              <th className="text-left px-3 py-2 font-semibold">Key prefix</th>
              <th className="text-left px-3 py-2 font-semibold">Permissions</th>
              <th className="text-left px-3 py-2 font-semibold">Active</th>
              <th className="text-left px-3 py-2 font-semibold">Last used</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.map(a => (
              <tr key={a.id} className="border-b border-cohesity-border/50 last:border-0 hover:bg-surface-overlay/50">
                <td className="px-3 py-2 text-ink font-medium">{a.name}</td>
                <td className="px-3 py-2 text-ink-muted font-mono">{a.keyPrefix}…</td>
                <td className="px-3 py-2 text-ink-muted">
                  <div className="flex flex-wrap gap-1">
                    {(a.permissions || []).map(p => <PermissionChip key={p} perm={p} />)}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <button onClick={() => toggleActive(a)}
                    className={`inline-flex items-center gap-1 chip cursor-pointer ${a.isActive ? 'bg-status-ok/10 text-status-ok border-status-ok/25' : 'bg-surface-overlay text-ink-muted border-cohesity-border'}`}>
                    <Power size={10} /> {a.isActive ? 'Active' : 'Disabled'}
                  </button>
                </td>
                <td className="px-3 py-2 text-ink-faint">{a.lastUsedAt ? <LastUpdated date={a.lastUsedAt} prefix="" /> : 'Never'}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => revoke(a)} aria-label={`Revoke ${a.name}`} className="text-ink-faint hover:text-status-crit cursor-pointer">
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-ink-faint">No service accounts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {showCreate && <CreateServiceAccountModal onClose={() => setShowCreate(false)} onSaved={load} />}
    </div>
  );
}

/* ── Auth mode banner: open-access vs enforced ──────────────────────────── */
function AuthModePanel() {
  const { authEnabled } = useAuth();
  const { toast } = useToast();
  const [showEnable, setShowEnable] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const openEnable = async () => {
    try {
      const { data } = await client.get('/auth/setup-status');
      setNeedsSetup(!!data.needsSetup);
      setShowEnable(true);
    } catch (err) {
      toast({ type: 'error', title: 'Could not check setup state', message: errorMessage(err, '') });
    }
  };

  const enable = async () => {
    setError(null);
    if (needsSetup) {
      if (!username.trim() || !password) { setError('Username and password are required.'); return; }
      if (password !== confirm) { setError('Passwords do not match.'); return; }
    }
    setBusy(true);
    try {
      await client.post('/auth/enable', needsSetup ? { username: username.trim(), password } : {});
      // Full reload picks up the new session (first-admin path) or bounces
      // through /login (existing-users path).
      window.location.assign('/');
    } catch (err) {
      setError(errorMessage(err, 'Could not enable authentication.'));
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!window.confirm('Disable authentication? The dashboard becomes open access for anyone who can reach it. Users, groups, and grants are kept and take effect again when re-enabled.')) return;
    try {
      await client.post('/auth/disable');
      window.location.assign('/');
    } catch (err) {
      toast({ type: 'error', title: 'Could not disable authentication', message: errorMessage(err, '') });
    }
  };

  if (!authEnabled) {
    return (
      <>
        <div className="flex items-center justify-between gap-3 bg-status-warn/10 border border-status-warn/30 rounded-lg px-4 py-3">
          <div>
            <p className="text-xs font-semibold text-status-warn">Authentication is disabled — open access</p>
            <p className="text-[11px] text-ink-muted mt-0.5">Anyone who can reach the dashboard has full access. Users, groups, and grants below only take effect once authentication is enabled.</p>
          </div>
          <button onClick={openEnable}
            className="flex-shrink-0 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer">
            Enable authentication
          </button>
        </div>
        {showEnable && (
          <Modal title="Enable authentication" onClose={() => setShowEnable(false)}>
            <div className="flex flex-col gap-3">
              {needsSetup ? (
                <>
                  <p className="text-xs text-ink-muted">Create the first administrator account. You'll be signed in as this user and login will be required from now on.</p>
                  <div>
                    <label className="text-xs font-semibold text-ink mb-1 block">Username</label>
                    <input value={username} onChange={e => setUsername(e.target.value)} className={inputClass} autoComplete="username" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-ink mb-1 block">Password</label>
                    <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputClass} autoComplete="new-password" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-ink mb-1 block">Confirm password</label>
                    <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} className={inputClass} autoComplete="new-password" />
                  </div>
                </>
              ) : (
                <p className="text-xs text-ink-muted">User accounts already exist. Enabling authentication requires everyone to sign in — you'll be redirected to the login page.</p>
              )}
              {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
              <button onClick={enable} disabled={busy}
                className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
                {busy ? 'Enabling…' : 'Enable authentication'}
              </button>
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 bg-surface border border-cohesity-border rounded-lg px-4 py-2.5">
      <p className="text-[11px] text-ink-muted"><span className="font-semibold text-ink">Authentication is enabled.</span> Sign-in is required and the grants below are enforced.</p>
      <button onClick={disable}
        className="flex-shrink-0 text-[11px] font-medium px-2.5 py-1.5 text-status-warn border border-status-warn/30 rounded-lg hover:bg-status-warn/10 transition-colors cursor-pointer">
        Disable authentication
      </button>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function AdminUsersPage() {
  const { hasPermission, loading: authLoading } = useAuth();
  const [tab, setTab] = useState('users');

  if (authLoading) return <p className="text-xs text-ink-faint">Loading…</p>;

  if (!hasPermission('admin:users:view')) {
    return (
      <div className="panel p-4 max-w-lg">
        <p className="text-sm font-bold text-ink">Access denied</p>
        <p className="text-xs text-ink-muted mt-1">You don't have permission to view Users & Access.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon={Users} title="Users & Access" description="Manage user accounts, groups, permission grants, and service accounts." />

      <div className="flex flex-col md:flex-row gap-5 items-start">
        <AdminNav />
        <div className="flex flex-col gap-4 flex-1 min-w-0">
          <AuthModePanel />
          <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-150 cursor-pointer ${
                    active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
                  }`}>
                  <Icon size={13} className={active ? 'text-brand' : ''} /> {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'users' && <UsersTab />}
          {tab === 'groups' && <GroupsTab />}
          {tab === 'service-accounts' && <ServiceAccountsTab />}
          {tab === 'directory' && <DirectoryTab />}
        </div>
      </div>
    </div>
  );
}
