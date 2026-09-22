import { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, UserPlus, Trash2 } from 'lucide-react';
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
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newMember, setNewMember] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => client.get('/tenants', { params: { _: Date.now() } })
    .then(({ data }) => setTenants(data.tenants || []))
    .catch(() => { setTenants([]); toast({ type: 'error', title: 'Could not load tenants' }); }), [toast]);

  const loadMembers = useCallback((id) => client.get(`/tenants/${id}/members`, { params: { _: Date.now() } })
    .then(({ data }) => setMembers(data.members || []))
    .catch(() => setMembers([])), []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (selected) loadMembers(selected); }, [selected, loadMembers]);

  const createTenant = async () => {
    setBusy(true);
    try {
      await client.post('/tenants', { id: newId.trim().toLowerCase(), name: newName.trim() });
      toast({ type: 'success', title: `Tenant ${newName.trim()} created` });
      setNewId(''); setNewName('');
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not create tenant', message: err?.response?.data?.error });
    } finally { setBusy(false); }
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
                    <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Id</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3"></th>
                  </tr></thead>
                  <tbody>
                    {tenants.map((t) => (
                      <tr key={t.id} onClick={() => setSelected(t.id)}
                        className={`border-b border-cohesity-border/50 cursor-pointer transition-colors ${selected === t.id ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'}`}>
                        <td className="py-2 pr-3 text-ink font-medium">{t.name}</td>
                        <td className="py-2 pr-3 text-ink-muted font-mono text-xs">{t.id}</td>
                        <td className="py-2 pr-3"><Badge tone={t.status === 'active' ? 'ok' : 'warn'}>{t.status}</Badge></td>
                        <td className="py-2 pr-3 text-right"><a href={tenantHome(t.id)} className="text-xs text-brand hover:underline" onClick={(e) => e.stopPropagation()}>Open</a></td>
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
              <button onClick={createTenant} disabled={busy || !newId.trim() || !newName.trim()} className={buttonClass}><Plus size={13} /> Create tenant</button>
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
