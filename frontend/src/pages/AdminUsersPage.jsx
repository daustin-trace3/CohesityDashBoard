import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Users, UserPlus, Shield, KeyRound, Pencil, Trash2, Plus, X, Copy, Check, Power, ChevronDown, ChevronRight, Fingerprint } from 'lucide-react';
import client from '../api/client';
import { PageHeader, Badge, LastUpdated } from '../components/ui/primitives';
import { useTableControls, TableSearch, TablePager } from '../components/ui/tableTools';
import { useToast } from '../components/ui/Toaster';
import { useAuth } from '../auth/AuthContext';
import AdminNav from '../components/AdminNav';
import IdentityProvidersTab from './IdentityProvidersTab';
import ProviderBadge from '../components/idp/ProviderBadge';
import { copyText } from '../utils/clipboard';
import SettingsTabs, { useSettingsTab } from '../components/settings/SettingsTabs';
import GrantEditor from '../components/access/GrantEditor';
import { PermissionChip, useGrantCatalog } from '../components/access/PermissionParts';

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';

const TABS = [
  { key: 'users', label: 'Users', icon: Users },
  { key: 'groups', label: 'Groups', icon: Shield },
  { key: 'service-accounts', label: 'Service Accounts', icon: KeyRound },
  { key: 'identity', label: 'Identity providers', icon: Fingerprint },
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

/* ── Directory object picker (shared by the user and group dialogs) ──────── */
function useDirectoryEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    client.get('/directory/config').then(({ data }) => setEnabled(!!data.configured)).catch(() => setEnabled(false));
  }, []);
  return enabled;
}

function useIdpProviders() {
  const [providers, setProviders] = useState([]);
  useEffect(() => {
    client.get('/idp/providers').then(({ data }) => setProviders(Array.isArray(data) ? data : [])).catch(() => setProviders([]));
  }, []);
  return providers;
}

function SourceToggle({ value, onChange, adEnabled = true, providers = [] }) {
  const options = [{ id: 'local', label: 'Local' }];
  if (adEnabled) options.push({ id: 'ad', label: 'Active Directory' });
  providers.filter(p => p.enabled).forEach(p => options.push({ id: `idp:${p.id}`, label: p.name }));
  return (
    <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start flex-wrap">
      {options.map(o => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)}
          className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${value === o.id ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Type a name, pick the AD object. kind = 'users' | 'groups'. */
function AdPicker({ kind, selected, onPick }) {
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

/** Identity provider picker. With an Okta Management API token it searches Okta;
 *  without one the admin types the exact name or email. */
function IdpPicker({ kind, provider, selected, onPick }) {
  const searchable = provider?.mgmtKind === 'okta' && provider?.mgmtTokenSet;
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const term = q.trim();
  useEffect(() => {
    if (!searchable || selected) return undefined;
    if (term.length < 2) { setResults(null); setErr(null); return undefined; }
    const t = setTimeout(() => {
      setBusy(true); setErr(null);
      client.get(`/idp/providers/${provider.id}/${kind}`, { params: { q: term } })
        .then(({ data }) => setResults(data))
        .catch(e => { setResults([]); setErr(errorMessage(e, 'Provider search failed.')); })
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [term, kind, selected, searchable, provider?.id]);

  if (!searchable) {
    return (
      <div className="flex flex-col gap-1.5">
        <input autoFocus value={q} onChange={e => { setQ(e.target.value); const v = e.target.value.trim(); onPick(v ? (kind === 'users' ? { email: v } : { name: v }) : null); }}
          placeholder={kind === 'users' ? 'Email address of the Okta user' : 'Okta group name exactly as in Okta'} className={inputClass} />
        <p className="text-[11px] text-ink-faint px-1">This provider has no Management API token, so names cannot be searched.</p>
      </div>
    );
  }
  if (selected) {
    return (
      <div className="flex items-center gap-2 border border-brand/40 bg-brand/5 rounded-lg px-3 py-2">
        <Badge tone="brand">{provider.name}</Badge>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-ink font-medium truncate">{kind === 'users' ? `${selected.displayName || selected.login} (${selected.email || selected.login})` : selected.name}</p>
        </div>
        <button type="button" onClick={() => onPick(null)} aria-label="Clear selection" className="text-ink-faint hover:text-ink cursor-pointer"><X size={13} /></button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'users' ? 'Type a name, login or email to search Okta' : 'Type a group name to search Okta'} className={inputClass} />
      {err && <p className="text-[11px] text-status-crit">{err}</p>}
      {term.length < 2 ? (
        <p className="text-[11px] text-ink-faint px-1">Type at least two characters. The list narrows as you type.</p>
      ) : (
        <div className="border border-cohesity-border rounded-lg max-h-56 overflow-y-auto">
          {busy && !results && <p className="text-[11px] text-ink-faint px-3 py-2">Searching...</p>}
          {results && results.length === 0 && <p className="text-[11px] text-ink-faint px-3 py-2">No {kind === 'users' ? 'user' : 'group'} matches "{term}".</p>}
          {(results || []).map(r => {
            const taken = kind === 'users' ? r.imported : r.linked;
            return (
              <button key={r.id} type="button" disabled={!!taken} onClick={() => onPick(r)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left border-b border-cohesity-border/50 last:border-0 hover:bg-brand/10 disabled:opacity-50 disabled:cursor-default cursor-pointer">
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-ink truncate">{kind === 'users' ? (r.displayName || r.login) : r.name}</span>
                  <span className="block text-[10px] text-ink-faint truncate">{kind === 'users' ? (r.email || r.login) : (r.description || '')}</span>
                </span>
                {taken && <Badge tone="neutral">{kind === 'users' ? `added as ${r.imported}` : 'already added'}</Badge>}
                {kind === 'users' && r.status && r.status !== 'ACTIVE' && <Badge tone="neutral">{String(r.status).toLowerCase()}</Badge>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Picker for the chosen source: 'ad' or 'idp:<id>'. */
function DirectoryPicker({ source = 'ad', providers = [], kind, selected, onPick }) {
  if (source.startsWith('idp:')) {
    const provider = providers.find(p => `idp:${p.id}` === source);
    return <IdpPicker key={source} kind={kind} provider={provider} selected={selected} onPick={onPick} />;
  }
  return <AdPicker kind={kind} selected={selected} onPick={onPick} />;
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
  const idpProviders = useIdpProviders();
  const [source, setSource] = useState('local');
  const [adUser, setAdUser] = useState(null);
  const isIdpSource = source.startsWith('idp:');
  const idpSourceId = isIdpSource ? Number(source.slice(4)) : null;
  const idpSourceName = isIdpSource ? (idpProviders.find(p => p.id === idpSourceId)?.name || 'provider') : '';
  const isSsoUser = user?.provider === 'oidc' || user?.provider === 'saml';

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
      } else if (isIdpSource) {
        await client.post(`/idp/providers/${idpSourceId}/users`, { oktaUserId: adUser.id, email: adUser.email, groupIds });
      } else {
        await client.post('/users', { username, password, displayName, groupIds });
      }
      toast({ type: 'success', title: isEdit ? 'User updated' : source === 'ad' ? 'Directory user added' : isIdpSource ? 'Identity provider user added' : 'User created' });
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
        {!isEdit && (directoryEnabled || idpProviders.some(p => p.enabled)) && <SourceToggle value={source} adEnabled={directoryEnabled} providers={idpProviders} onChange={(v) => { setSource(v); setAdUser(null); }} />}
        {!isEdit && source !== 'local' ? (
          <div>
            <label className="text-xs font-semibold text-ink mb-1 block">{isIdpSource ? `${idpSourceName} user` : 'Directory user'}</label>
            <DirectoryPicker source={source} providers={idpProviders} kind="users" selected={adUser} onPick={setAdUser} />
            {isIdpSource ? (
              <p className="text-[10px] text-ink-faint mt-1">Signs in through {idpSourceName}. The user is pinned: it keeps access from the groups ticked below even when it is in no linked group.</p>
            ) : (
              <p className="text-[10px] text-ink-faint mt-1">Signs in with the domain password. Access comes from the groups ticked below plus any mirrored domain groups the user is in.</p>
            )}
          </div>
        ) : (
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block">Username</label>
          <input value={username} onChange={e => setUsername(e.target.value)} disabled={isEdit}
            className={`${inputClass} ${isEdit ? 'opacity-60' : ''}`} autoComplete="username" />
        </div>
        )}
        {(isEdit || source === 'local') && (
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block">Display name</label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputClass} />
        </div>
        )}
        {user?.provider === 'ad' || isSsoUser || (!isEdit && source !== 'local') ? (
          isSsoUser ? (
          <p className="text-[11px] text-ink-muted bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2">
            Single sign-on account: signs in through its identity provider and has no ICC password. Membership from linked provider groups is managed by sign-in and sync; groups ticked here are added on top.
          </p>
          ) : user?.provider === 'ad' ? (
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
        <button onClick={save} disabled={saving || (!isEdit && (source === 'ad' ? !adUser : isIdpSource ? !(adUser && (adUser.id || adUser.email)) : (!username || !password)))}
          className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
          {saving ? 'Saving...' : isEdit ? 'Save changes' : source === 'ad' ? 'Add directory user' : isIdpSource ? 'Add provider user' : 'Create user'}
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
  const idpProviders = useIdpProviders();

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

  // Search and paging over the loaded list (a directory sync can add hundreds of rows at once).
  const userRows = useMemo(() => (users || []).map((u) => ({ ...u, groupText: (u.groups || []).join(', ') })), [users]);
  const ctl = useTableControls(userRows, { searchKeys: ['username', 'displayName', 'email', 'domain', 'groupText', 'provider'], paginate: true, defaultPageSize: 10, deepLink: false });

  if (error) return <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>;
  if (!users) return <p className="text-xs text-ink-faint">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-xs text-ink-muted whitespace-nowrap">{ctl.q ? `${ctl.rows.length} of ${users.length}` : users.length} user{users.length !== 1 ? 's' : ''}</p>
          <TableSearch ctl={ctl} placeholder="Search users..." className="w-64" />
        </div>
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
              <th className="text-left px-3 py-2 font-semibold">Domain</th>
              <th className="text-left px-3 py-2 font-semibold">Display name</th>
              <th className="text-left px-3 py-2 font-semibold">Groups</th>
              <th className="text-left px-3 py-2 font-semibold">Active</th>
              <th className="text-left px-3 py-2 font-semibold">Last login</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {ctl.pageRows.map(u => (
              <tr key={u.id} className="border-b border-cohesity-border/50 last:border-0 hover:bg-surface-overlay/50">
                <td className="px-3 py-2 text-ink font-medium">
                  <span className="flex items-center gap-1.5">{u.username}{u.provider === 'ad' && <Badge tone="info">AD</Badge>}{(u.provider === 'oidc' || u.provider === 'saml') && <ProviderBadge providerId={u.idpProviderId} providers={idpProviders} />}</span>
                </td>
                <td className="px-3 py-2 text-ink-muted font-mono text-[11px]">{u.domain || (u.provider === 'local' ? 'local' : u.provider)}</td>
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
              <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-faint">No users yet.</td></tr>
            )}
            {users.length > 0 && ctl.rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-faint">No user matches the search.</td></tr>
            )}
          </tbody>
        </table>
        <div className="px-3 pb-2"><TablePager ctl={ctl} sizes={[10, 25, 50, 100, 'all']} /></div>
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
  const idpProviders = useIdpProviders();
  const [source, setSource] = useState('local');
  const [adGroup, setAdGroup] = useState(null);
  const isIdpSource = source.startsWith('idp:');
  const idpSourceId = isIdpSource ? Number(source.slice(4)) : null;
  const idpSourceName = isIdpSource ? (idpProviders.find(p => p.id === idpSourceId)?.name || 'provider') : '';

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      if (source === 'ad') await client.post('/directory/links', { dn: adGroup.dn });
      else if (isIdpSource) await client.post(`/idp/providers/${idpSourceId}/links`, adGroup.id ? { groupId: adGroup.id, name: adGroup.name } : { name: adGroup.name });
      else await client.post('/users/groups', { name, description });
      toast({ type: 'success', title: source === 'ad' ? 'Domain group added' : isIdpSource ? 'Provider group linked' : 'Group created', message: source === 'ad' ? 'Members are being pulled in. Grant it platform access below.' : isIdpSource ? 'Members get access when they sign in. Grant it platform access below.' : undefined });
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
        {(directoryEnabled || idpProviders.some(p => p.enabled)) && <SourceToggle value={source} adEnabled={directoryEnabled} providers={idpProviders} onChange={(v) => { setSource(v); setAdGroup(null); }} />}
        {source !== 'local' ? (
          <div>
            <label className="text-xs font-semibold text-ink mb-1 block">{isIdpSource ? `${idpSourceName} group` : 'Directory group'}</label>
            <DirectoryPicker source={source} providers={idpProviders} kind="groups" selected={adGroup} onPick={setAdGroup} />
            {isIdpSource ? (
              <p className="text-[10px] text-ink-faint mt-1">Users who sign in through {idpSourceName} with this group get this group's access. Grant it platform access after adding.</p>
            ) : (
              <p className="text-[10px] text-ink-faint mt-1">Its members (nested groups included) are mirrored and kept current. Grant it platform access after adding.</p>
            )}
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
        <button onClick={save} disabled={saving || (source !== 'local' ? !adGroup : !name.trim())}
          className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
          {saving ? 'Saving...' : source === 'ad' ? 'Add domain group' : isIdpSource ? 'Link provider group' : 'Create group'}
        </button>
      </div>
    </Modal>
  );
}

// Short grey line under each group name, from the grants GET /users/groups returns.
function grantSummary(list) {
  if (!Array.isArray(list)) return '';
  const perms = list.map(g => (typeof g === 'string' ? g : g?.permission)).filter(Boolean);
  if (perms.length === 0) return 'No grants';
  const star = perms.find(p => p.startsWith('*:*:'));
  if (star) return `All platforms: ${star.endsWith(':view') ? 'view' : 'manage'}`;
  const ns = new Set(perms.map(p => p.split(':')[0]).filter(n => n !== 'admin' && n !== 'ops'));
  if (ns.size > 0) return `${ns.size} ${ns.size === 1 ? 'platform' : 'platforms'}`;
  return `${perms.length} ${perms.length === 1 ? 'grant' : 'grants'}`;
}

function GroupsTab() {
  const { toast } = useToast();
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [grants, setGrants] = useState(null);
  const [grantsError, setGrantsError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [savingGrants, setSavingGrants] = useState(false);
  const grantsDirty = useRef(false);
  const { catalog, error: catalogError } = useGrantCatalog();
  const idpProviders = useIdpProviders();

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

  const saveGrants = async (next) => {
    if (!selectedId) return;
    setSavingGrants(true);
    try {
      await client.put(`/users/grants/group/${selectedId}`, { permissions: next });
      toast({ type: 'success', title: 'Grants saved' });
      grantsDirty.current = false;
      loadGrants(selectedId);
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not save grants', message: errorMessage(err, 'Invalid permission string.') });
    } finally {
      setSavingGrants(false);
    }
  };

  const copyFromGroup = async (id) => {
    try {
      const { data } = await client.get('/users/grants', { params: { subjectType: 'group', subjectId: id } });
      return (data || []).map(g => (typeof g === 'string' ? g : g.permission));
    } catch (err) {
      toast({ type: 'error', title: 'Could not load that group', message: errorMessage(err, '') });
      return null;
    }
  };

  const selectGroup = (id) => {
    if (id === selectedId) return;
    if (grantsDirty.current && !window.confirm('Discard unsaved grant changes?')) return;
    grantsDirty.current = false;
    setSelectedId(id);
  };

  const deleteGroup = async (g) => {
    if (!window.confirm(g.provider === 'ad' ? `Remove domain group "${g.name}" from ICC? Its access grants go with it; users stay.` : g.provider === 'idp' ? `Unlink provider group "${g.name}" from ICC? Its access grants go with it; users stay.` : `Delete group "${g.name}"?`)) return;
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
            <button key={g.id} onClick={() => selectGroup(g.id)}
              className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left text-xs transition-colors cursor-pointer ${
                selectedId === g.id ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink'
              }`}>
              <span className="min-w-0">
                <span className="block truncate">{g.name}</span>
                <span className="block truncate text-[10px] text-ink-faint">{grantSummary(g.grants)}</span>
              </span>
              {g.isSystem === 1 || g.isSystem === true ? <Badge tone="neutral">system</Badge> : g.provider === 'ad' ? <Badge tone="info">AD</Badge> : g.provider === 'idp' ? <ProviderBadge providerId={g.idpProviderId} providers={idpProviders} /> : null}
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
                  {selected.provider === 'idp' && <ProviderBadge providerId={selected.idpProviderId} providers={idpProviders} fallback={`SSO: ${selected.externalName || ''}`} />}
                </p>
                {selected.description && <p className="text-[11px] text-ink-muted mt-0.5">{selected.description}</p>}
              </div>
              {!(selected.isSystem === 1 || selected.isSystem === true) && (
                <button onClick={() => deleteGroup(selected)}
                  className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 text-status-crit border border-status-crit/30 rounded-lg hover:bg-status-crit/10 transition-colors cursor-pointer">
                  <Trash2 size={12} /> {selected.provider === 'ad' ? 'Remove domain group' : selected.provider === 'idp' ? 'Unlink provider group' : 'Delete group'}
                </button>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold text-ink mb-2">Grants</p>
              {catalogError && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2 mb-2">{catalogError}</p>}
              {grantsError && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2 mb-2">{grantsError}</p>}
              {grants === null ? (
                <p className="text-[11px] text-ink-faint">Loading…</p>
              ) : (
                <GrantEditor key={selectedId} grants={grants} catalog={catalog} saving={savingGrants}
                  onSave={saveGrants} onDirtyChange={(d) => { grantsDirty.current = d; }}
                  copySources={groups.filter(g => g.id !== selectedId).map(g => ({ id: g.id, name: g.name }))}
                  onCopyFrom={copyFromGroup} />
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

  const { catalog } = useGrantCatalog();

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

  const copyKey = async () => {
    if (!issuedKey) return;
    if (await copyText(issuedKey)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast({ type: 'error', title: 'Could not copy', message: 'Select the key and copy it manually.' });
    }
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
          <GrantEditor grants={permissions} catalog={catalog} onSave={setPermissions} live />
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
  const [tab, setTab] = useSettingsTab(TABS, 'users');

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
          <SettingsTabs tabs={TABS} active={tab} onChange={setTab} label="Users and access" />

          {tab === 'users' && <UsersTab />}
          {tab === 'groups' && <GroupsTab />}
          {tab === 'service-accounts' && <ServiceAccountsTab />}
          {tab === 'identity' && <IdentityProvidersTab />}
        </div>
      </div>
    </div>
  );
}
