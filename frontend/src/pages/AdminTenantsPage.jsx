import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, Plus, UserPlus, Trash2, PauseCircle, PlayCircle, Download, Archive, ArchiveRestore, KeyRound, Pencil, X } from 'lucide-react';
import client from '../api/client';
import { PageHeader, Badge, LoadingPanel } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import AdminNav from '../components/AdminNav';
import { useAuth } from '../auth/AuthContext';
import { tenantHome } from '../tenant';

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
const buttonClass = 'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer';

function Dialog({ title, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-lg flex flex-col">
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <button onClick={onClose} aria-label="Close" className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer">
            <X size={15} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

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
  const [licenseKey, setLicenseKey] = useState('');
  const [newMember, setNewMember] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editMember, setEditMember] = useState(null);
  const [editName, setEditName] = useState('');
  const [editActive, setEditActive] = useState(true);

  const load = useCallback(() => client.get('/tenants/manage', { params: { _: Date.now() } })
    .then(({ data }) => { setTenants(data.tenants || []); setPlatforms(data.platforms || []); })
    .catch(() => { setTenants([]); toast({ type: 'error', title: 'Could not load tenants' }); }), [toast]);

  const loadMembers = useCallback((id) => client.get(`/tenants/${id}/members`, { params: { _: Date.now() } })
    .then(({ data }) => setMembers(data.members || []))
    .catch(() => setMembers([])), []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (selected) loadMembers(selected); }, [selected, loadMembers]);

  const createTenant = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const body = { id: newId.trim().toLowerCase(), name: newName.trim(), seedDemo };
      if (newPlatforms) body.platforms = newPlatforms;
      if (licenseKey.trim()) body.licenseKey = licenseKey.trim();
      if (adminUser.trim()) body.admin = { username: adminUser.trim(), password: adminPassword || undefined };
      const { data } = await client.post('/tenants', body);
      toast({ type: 'success', title: `Tenant ${data.name} created`, message: data.seeded === false ? 'Demo data seeding failed; see the server log.' : undefined });
      setNewId(''); setNewName(''); setNewPlatforms(null); setAdminUser(''); setAdminPassword(''); setSeedDemo(false); setLicenseKey('');
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not create tenant', message: err?.response?.data?.error });
    } finally { setBusy(false); }
  };

  const togglePlatform = (id) => setNewPlatforms((cur) => {
    const base = cur || platforms;
    return base.includes(id) ? base.filter((p) => p !== id) : [...base, id];
  });

  const exportTenant = async (t) => {
    try {
      const res = await client.post(`/tenants/${t.id}/export`, null, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `${t.id}-export.zip`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ type: 'error', title: 'Export failed', message: err?.response?.data?.error });
    }
  };

  const closeTenant = async (t) => {
    if (!window.confirm(`Close ${t.name}? Its database is sealed into the archive and removed from the live pool. It can be restored while the archive is kept.`)) return;
    try {
      await client.post(`/tenants/${t.id}/close`);
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not close tenant', message: err?.response?.data?.error });
    }
  };

  const restoreTenant = async (t) => {
    try {
      await client.post(`/tenants/${t.id}/restore`);
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not restore tenant', message: err?.response?.data?.error });
    }
  };

  const setLicense = async (t) => {
    const v = window.prompt(`License key for ${t.name} (CDBL-...)`, '');
    if (!v || !v.trim()) return;
    try {
      await client.put(`/tenants/${t.id}`, { licenseKey: v.trim() });
      toast({ type: 'success', title: `License saved for ${t.name}` });
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not save license', message: err?.response?.data?.error });
    }
  };

  const setRetention = async (t) => {
    const v = window.prompt(`History retention for ${t.name}, in days (0 = each platform's own default)`, String(t.retentionDays ?? 0));
    if (v == null) return;
    try {
      await client.put(`/tenants/${t.id}`, { retentionDays: Number(v) });
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not set retention', message: err?.response?.data?.error });
    }
  };

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

  const openEdit = (m) => { setEditMember(m); setEditName(m.displayName || ''); setEditActive(!!m.isActive); };

  const saveMember = async () => {
    if (!editMember) return;
    setBusy(true);
    try {
      await client.put(`/tenants/${selected}/members/${editMember.id}`, { displayName: editName, isActive: editActive });
      setEditMember(null);
      await loadMembers(selected);
    } catch (err) {
      toast({ type: 'error', title: 'Could not save', message: err?.response?.data?.error });
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
                    <th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Id</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">License</th><th className="py-2 pr-3">Platforms / retention</th><th className="py-2 pr-3">Members</th><th className="py-2 pr-3"></th>
                  </tr></thead>
                  <tbody>
                    {tenants.map((t) => (
                      <tr key={t.id} onClick={() => setSelected(t.id)}
                        className={`border-b border-cohesity-border/50 cursor-pointer transition-colors ${selected === t.id ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'}`}>
                        <td className="py-2 pr-3 text-ink font-medium">{t.name}</td>
                        <td className="py-2 pr-3 text-ink-muted font-mono text-xs">{t.id}</td>
                        <td className="py-2 pr-3"><Badge tone={t.status === 'active' ? 'ok' : t.status === 'closed' ? 'neutral' : 'warn'}>{t.status}</Badge></td>
                        <td className="py-2 pr-3 text-xs text-ink-muted whitespace-nowrap">
                          {t.license?.state}{t.license?.expiry ? ` to ${t.license.expiry}` : ''}
                          {t.id !== 'default' && t.status !== 'closed' && (
                            <button onClick={(e) => { e.stopPropagation(); setLicense(t); }} title="Enter or replace this tenant's license key" aria-label={`License key for ${t.name}`}
                              className="ml-2 text-ink-faint hover:text-ink cursor-pointer align-middle"><KeyRound size={13} /></button>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-xs text-ink-muted" title="Click to set history retention" onClick={(e) => { e.stopPropagation(); if (t.status !== 'closed') setRetention(t); }}>
                          {(t.platforms || []).length}{t.status !== 'closed' && <span className="text-ink-faint"> / {t.retentionDays ? `${t.retentionDays}d` : 'default'}</span>}
                        </td>
                        <td className="py-2 pr-3 text-xs text-ink-muted tnum">{t.members}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">
                          {t.status === 'closed' ? (
                            <button onClick={(e) => { e.stopPropagation(); restoreTenant(t); }} title="Restore from archive" aria-label={`Restore ${t.name}`}
                              className="text-ink-faint hover:text-ink cursor-pointer align-middle"><ArchiveRestore size={14} /></button>
                          ) : (
                            <>
                              <button onClick={(e) => { e.stopPropagation(); exportTenant(t); }} title="Export (database without secrets, plus CSVs)" aria-label={`Export ${t.name}`}
                                className="text-ink-faint hover:text-ink cursor-pointer mr-3 align-middle"><Download size={14} /></button>
                              {t.id !== 'default' && (
                                <>
                                  <button onClick={(e) => { e.stopPropagation(); setStatus(t, t.status === 'active' ? 'suspended' : 'active'); }}
                                    title={t.status === 'active' ? 'Suspend' : 'Resume'} aria-label={`${t.status === 'active' ? 'Suspend' : 'Resume'} ${t.name}`}
                                    className="text-ink-faint hover:text-ink cursor-pointer mr-3 align-middle">
                                    {t.status === 'active' ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); closeTenant(t); }} title="Close into archive" aria-label={`Close ${t.name}`}
                                    className="text-ink-faint hover:text-status-crit cursor-pointer mr-3 align-middle"><Archive size={14} /></button>
                                </>
                              )}
                              <a href={tenantHome(t.id)} className="text-xs text-brand hover:underline" onClick={(e) => e.stopPropagation()}>Open</a>
                            </>
                          )}
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
            </div>
            <div className="flex flex-wrap items-end gap-2 mt-3">
              <div className="flex-1 min-w-[280px]">
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="tenant-license">License key (CDBL-...); the tenant is locked to its licence page until one is set</label>
                <input id="tenant-license" value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} className={inputClass} placeholder="CDBL-..." autoComplete="off" spellCheck={false} />
              </div>
              <button onClick={() => setConfirming(true)} disabled={busy || !newId.trim() || !newName.trim()} className={buttonClass}><Plus size={13} /> {busy ? 'Creating...' : 'Create tenant'}</button>
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
                        <td className="py-2 pr-3 text-right whitespace-nowrap">
                          <button onClick={() => openEdit(m)} title="Edit name, enable or disable" aria-label={`Edit ${m.username}`}
                            className="text-ink-faint hover:text-brand cursor-pointer mr-3"><Pencil size={14} /></button>
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

      {confirming && (
        <Dialog title={`Create tenant ${newName.trim()}?`} onClose={() => setConfirming(false)}>
          <div className="text-xs text-ink-muted leading-relaxed flex flex-col gap-2">
            <p>The tenant id <span className="font-mono text-ink">{newId.trim().toLowerCase()}</span> is permanent. It is part of the tenant's address and of its encryption key, so it cannot be renamed later. Check it now.</p>
            <p>Everything else can be changed after creation: the display name, the platforms, the license key, the members and the retention window.</p>
            {seedDemo && <p>Demo data will be seeded; that takes a little while.</p>}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setConfirming(false)} className="text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink cursor-pointer">Go back and edit</button>
            <button onClick={createTenant} className={buttonClass}><Plus size={13} /> Create {newName.trim()}</button>
          </div>
        </Dialog>
      )}

      {editMember && (
        <Dialog title={`Edit ${editMember.username}`} onClose={() => setEditMember(null)}>
          <div className="flex flex-col gap-3">
            <div>
              <label className="block text-[11px] text-ink-faint mb-1" htmlFor="member-display">Display name</label>
              <input id="member-display" value={editName} onChange={(e) => setEditName(e.target.value)} className={inputClass} />
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
              <input type="checkbox" className="accent-brand cursor-pointer" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
              Account enabled
            </label>
            <p className="text-[11px] text-ink-faint">The account is shared across tenants: disabling it here disables it everywhere. Roles inside this tenant are set on its Users &amp; Access page.</p>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setEditMember(null)} className="text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink cursor-pointer">Cancel</button>
            <button onClick={saveMember} disabled={busy} className={buttonClass}>Save</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
