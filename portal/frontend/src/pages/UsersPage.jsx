import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, UserRound } from 'lucide-react';
import client from '../api/client';

const input = 'w-full bg-surface-raised border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-faint focus:border-brand/60 transition-colors';

export default function UsersPage({ currentUser }) {
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await client.get('/users');
      setUsers(data.users);
    } catch {
      setError('Failed to load users.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (form.id) {
        const body = { displayName: form.displayName, isActive: form.isActive };
        if (form.password) body.password = form.password;
        await client.put(`/users/${form.id}`, body);
      } else {
        await client.post('/users', { username: form.username, password: form.password, displayName: form.displayName });
      }
      setForm(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"?`)) return;
    try {
      await client.delete(`/users/${u.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed.');
    }
  };

  return (
    <div className="flex flex-col gap-4 animate-fade-in max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Portal Users</h1>
          <p className="text-xs text-ink-muted mt-0.5">Everyone here has full portal access in this version.</p>
        </div>
        <button
          onClick={() => { setForm({ username: '', password: '', displayName: '', isActive: true }); setError(null); }}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 bg-brand hover:bg-brand-dark text-white rounded-lg transition-colors cursor-pointer"
        >
          <Plus size={14} /> Add user
        </button>
      </div>

      {error && !form && <p className="text-xs text-status-crit">{error}</p>}

      <div className="panel overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-faint border-b border-cohesity-border">
              <th className="px-4 py-2.5 font-semibold">Username</th>
              <th className="px-4 py-2.5 font-semibold">Display name</th>
              <th className="px-4 py-2.5 font-semibold">Active</th>
              <th className="px-4 py-2.5 font-semibold">Last login</th>
              <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users === null ? (
              <tr><td colSpan={5} className="px-4 py-6 text-ink-faint">Loading…</td></tr>
            ) : users.map((u) => (
              <tr key={u.id} className="border-b border-cohesity-border/50 last:border-0">
                <td className="px-4 py-2.5 font-semibold text-ink flex items-center gap-2">
                  <UserRound size={13} className="text-ink-faint" /> {u.username}
                  {u.id === currentUser.id && <span className="chip border-brand/40 text-brand">you</span>}
                </td>
                <td className="px-4 py-2.5 text-ink-muted">{u.displayName}</td>
                <td className="px-4 py-2.5">{u.isActive ? 'yes' : <span className="text-status-warn">no</span>}</td>
                <td className="px-4 py-2.5 text-ink-faint">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => { setForm({ id: u.id, username: u.username, password: '', displayName: u.displayName || '', isActive: u.isActive }); setError(null); }}
                      title="Edit"
                      className="p-1.5 rounded-md text-ink-faint hover:text-brand hover:bg-surface-raised transition-colors cursor-pointer"
                    >
                      <Pencil size={13} />
                    </button>
                    {u.id !== currentUser.id && (
                      <button onClick={() => remove(u)} title="Delete" className="p-1.5 rounded-md text-ink-faint hover:text-status-crit hover:bg-surface-raised transition-colors cursor-pointer">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <form onSubmit={save} className="panel p-5 flex flex-col gap-3 max-w-md">
          <p className="text-sm font-bold text-ink">{form.id ? `Edit ${form.username}` : 'Add user'}</p>
          {!form.id && (
            <input className={input} placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoFocus />
          )}
          <input className={input} placeholder="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <input
            className={input}
            type="password"
            placeholder={form.id ? 'New password (leave blank to keep current)' : 'Password'}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            autoComplete="new-password"
          />
          {form.id && form.id !== currentUser.id && (
            <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              Active
            </label>
          )}
          {error && <p className="text-xs text-status-crit">{error}</p>}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy} className="text-xs font-semibold px-3 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg transition-colors cursor-pointer">
              {form.id ? 'Save changes' : 'Create user'}
            </button>
            <button type="button" onClick={() => setForm(null)} className="text-xs font-medium px-3 py-2 text-ink-muted hover:text-ink transition-colors cursor-pointer">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
