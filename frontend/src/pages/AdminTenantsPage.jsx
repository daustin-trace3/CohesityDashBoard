import { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, UserPlus, Trash2, PauseCircle, PlayCircle } from 'lucide-react';
import client from '../api/client';
import { PageHeader, Badge, LoadingPanel } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import AdminNav from '../components/AdminNav';
import { useAuth } from '../auth/AuthContext';
import { tenantHome } from '../tenant';

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
const buttonClass = 'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer';

/**
 * Global admin only (docs/MULTI-TENANT-DESIGN.md, decisions 7 and 8): create
 * tenants and manage who may enter each one. Roles inside a tenant are set on
 * that tenant's own Users & Access page.
 */
export default function AdminTenantsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [tenants, setTenants] = useState(null);
  const [selected, setSelected] = useState(null);
  const [members, setMembers] = useState([]);
  const [platforms, setPlatforms] = useState([]);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newPlatforms, setNewPlatforms] = useState(null); // null = all
  const [adminUser, setAdminUser] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [seedDemo, setSeedDemo] = useState(false);
  const [newMember, setNewMember] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => client.get('/tenants/manage', { params: { _: Date.now() } })
    .then(({ data }) => { setTenants(data.tenants || []); setPlatforms(data.platforms || []); })
    .catch(() => { setTenants([]); toast({ type: 'error', title: 'Could not load tenants' }); }), [toast]);

  const loadMembers = useCallback((id) => client.get(`/tenants/${id}/members`, { params: { _: Date.now() } })
    .then(({ data }) => setMembers(data.members || []))
    .catch(() => setMembers([])), []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (selected) loadMembers(selected); }, [selected, loadMembers]);

  const createTenant = async () => {
    setBusy(true);
    try {
      const body = { id: newId.trim().toLowerCase(), name: newName.trim(), seedDemo };
      if (newPlatforms) body.platforms = newPlatforms;
      if (adminUser.trim()) body.admin = { username: adminUser.trim(), password: adminPassword || undefined };
      const { data } = await client.post('/tenants', body);
      toast({ type: 'success', title: `Tenant ${data.name} created`, message: data.seeded === false ? 'Demo data seeding failed; see the server log.' : undefined });
      setNewId(''); setNewName(''); setNewPlatforms(null); setAdminUser(''); setAdminPassword(''); setSeedDemo(false);
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not create tenant', message: err?.response?.data?.error });
    } finally { setBusy(false); }
  };

  const togglePlatform = (id) => setNewPlatforms((cur) => {
    const base = cur || platforms;
    return base.includes(id) ? base.filter((p) => p !== id) : [...base, id];
  });

  const setStatus = async (t, status) => {
    const verb = status === 'suspended' ? 'Suspend' : 'Resume';
    if (!window.confirm(`${verb} ${t.name}? ${status === 'suspended' ? 'Polling stops and members only reach the licence page.' : 'Polling and access resume.'}`)) return;
    try {
      await client.put(`/tenants/${t.id}`, { status });
      await load();
    } catch (err) {
      toast({ type: 'error', title: `Could not ${verb.toLowerCase()} tenant`, message: err?.response?.data?.error });
    }
  };

  const addMember = async () => {
    if (!selected || !newMember.trim()) return;
    setBusy(true);
    try {
      await client.post(`/tenants/${selected}/members`, { username: newMember.trim() });
      setNewMember('');
      await loadMembers(selected);
    } catch (err) {
      toast({ type: 'error', title: 'Could not add member', message: err?.response?.data?.error });
    } finally { setBusy(false); }
  };

  const removeMember = async (m) => {
    if (!window.confirm(`Remove ${m.username} from this tenant? The account itself stays.`)) return;
    try {
      await client.delete(`/tenants/${selected}/members/${m.id}`);
      await loadMembers(selected);
    } catch (err) {
      toast({ type: 'error', title: 'Could not remove member', message: err?.response?.data?.error });
    }
  };

  if (!user?.isGlobalAdmin) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={Building2} title="Tenants" description="Tenants and who may enter them." />
        <div className="flex flex-col md:flex-row gap-5 items-start">
          <AdminNav />
          <div className="panel p-6 text-sm text-ink-muted flex-1">Only a global admin can manage tenants.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Building2} title="Tenants" description="Tenants and who may enter them. Roles inside a tenant are set on that tenant's Users & Access page." />
      <div className="flex flex-col md:flex-row gap-5 items-start">
        <AdminNav />
        <div className="flex flex-col gap-4 flex-1 min-w-0">
          <div className="panel p-4">
            <p className="text-sm font-semibold text-ink mb-3">Tenants</p>
            {tenants == null ? <LoadingPanel label="Loading tenants..." height={80} /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Id</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">License</th><th className="py-2 pr-3">Platforms</th><th className="py-2 pr-3">Members</th><th className="py-2 pr-3"></th>
                  </tr></thead>
                  <tbody>
                    {tenants.map((t) => (
                      <tr key={t.id} onClick={() => setSelected(t.id)}
                        className={`border-b border-cohesity-border/50 cursor-pointer transition-colors ${selected === t.id ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'}`}>
                        <td className="py-2 pr-3 text-ink font-medium">{t.name}</td>
                        <td className="py-2 pr-3 text-ink-muted font-mono text-xs">{t.id}</td>
                        <td className="py-2 pr-3"><Badge tone={t.status === 'active' ? 'ok' : 'warn'}>{t.status}</Badge></td>
                        <td className="py-2 pr-3 text-xs text-ink-muted">{t.license?.state}{t.license?.expiry ? ` to ${t.license.expiry}` : ''}</td>
                        <td className="py-2 pr-3 text-xs text-ink-muted">{(t.platforms || []).length}</td>
                        <td className="py-2 pr-3 text-xs text-ink-muted tnum">{t.members}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">
                          {t.id !== 'default' && (
                            <button onClick={(e) => { e.stopPropagation(); setStatus(t, t.status === 'active' ? 'suspended' : 'active'); }}
                              title={t.status === 'active' ? 'Suspend' : 'Resume'} aria-label={`${t.status === 'active' ? 'Suspend' : 'Resume'} ${t.name}`}
                              className="text-ink-faint hover:text-ink cursor-pointer mr-3 align-middle">
                              {t.status === 'active' ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                            </button>
                          )}
                          <a href={tenantHome(t.id)} className="text-xs text-brand hover:underline" onClick={(e) => e.stopPropagation()}>Open</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2 mt-4 pt-3 border-t border-cohesity-border/60">
              <div className="w-40">
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="tenant-id">Id (lower case, hyphens)</label>
                <input id="tenant-id" value={newId} onChange={(e) => setNewId(e.target.value)} className={inputClass} placeholder="acme" />
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="tenant-name">Name</label>
                <input id="tenant-name" value={newName} onChange={(e) => setNewName(e.target.value)} className={inputClass} placeholder="Acme Corp" />
              </div>
            </div>
            <div className="mt-3">
              <p className="text-[11px] text-ink-faint mb-1">Platforms this tenant gets (more can be added later)</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {platforms.map((id) => (
                  <label key={id} className="inline-flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
                    <input type="checkbox" className="accent-brand cursor-pointer" checked={(newPlatforms || platforms).includes(id)} onChange={() => togglePlatform(id)} />
                    {id}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2 mt-3">
              <div className="w-44">
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="tenant-admin">First tenant admin (username)</label>
                <input id="tenant-admin" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} className={inputClass} placeholder="existing or new" autoComplete="off" />
              </div>
              <div className="w-44">
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="tenant-admin-pw">Password (new account only)</label>
                <input id="tenant-admin-pw" type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} className={inputClass} autoComplete="new-password" />
              </div>
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none pb-2">
                <input type="checkbox" className="accent-brand cursor-pointer" checked={seedDemo} onChange={(e) => setSeedDemo(e.target.checked)} />
                Seed demo data
              </label>
              <button onClick={createTenant} disabled={busy || !newId.trim() || !newName.trim()} className={buttonClass}><Plus size={13} /> {busy ? 'Creating...' : 'Create tenant'}</button>
            </div>
          </div>

          {selected && (
            <div className="panel p-4">
              <p className="text-sm font-semibold text-ink mb-1">Members of {tenants.find((t) => t.id === selected)?.name}</p>
              <p className="text-[11px] text-ink-muted mb-3">A new member starts as a Viewer. Global admins enter every tenant and are not listed here.</p>
              {members.length === 0 ? (
                <p className="text-xs text-ink-faint py-3">No members yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">User</th><th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Active</th><th className="py-2 pr-3"></th>
                  </tr></thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink">{m.username}</td>
                        <td className="py-2 pr-3 text-ink-muted">{m.displayName || '-'}</td>
                        <td className="py-2 pr-3"><Badge tone={m.isActive ? 'ok' : 'neutral'}>{m.isActive ? 'active' : 'inactive'}</Badge></td>
                        <td className="py-2 pr-3 text-right">
                          <button onClick={() => removeMember(m)} title="Remove from tenant" aria-label={`Remove ${m.username}`}
                            className="text-ink-faint hover:text-status-crit cursor-pointer"><Trash2 size={14} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="flex items-end gap-2 mt-4 pt-3 border-t border-cohesity-border/60">
                <div className="flex-1 max-w-xs">
                  <label className="block text-[11px] text-ink-faint mb-1" htmlFor="member-name">Username of an existing account</label>
                  <input id="member-name" value={newMember} onChange={(e) => setNewMember(e.target.value)} className={inputClass} placeholder="jsmith" />
                </div>
                <button onClick={addMember} disabled={busy || !newMember.trim()} className={buttonClass}><UserPlus size={13} /> Add member</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
