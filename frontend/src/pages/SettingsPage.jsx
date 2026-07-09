import { useEffect, useState } from 'react';
import { Save, BadgeCheck, Cloud, Server } from 'lucide-react';
import client from '../api/client';
import { useToast } from '../components/ui/Toaster';
import HeliosConnectTab from '../components/cohesity/HeliosConnectTab';
import DirectClustersTab from '../components/cohesity/DirectClustersTab';

const TABS = [
  { key: 'helios', label: 'Helios (SaaS)', icon: Cloud },
  { key: 'direct', label: 'Direct Clusters', icon: Server },
  { key: 'entitlement', label: 'Licensing', icon: BadgeCheck },
];

export default function SettingsPage() {
  const [tab, setTab] = useState('helios');
  const [dpTib, setDpTib] = useState('');
  const [replicaTib, setReplicaTib] = useState('');
  const [smartFilesTib, setSmartFilesTib] = useState('');
  const [licenseExpiry, setLicenseExpiry] = useState('');
  const [licenseEdition, setLicenseEdition] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    client.get('/settings').then(({ data: d }) => {
      const e = d.entitled || {};
      setDpTib(e.dataProtect ? String(e.dataProtect) : '');
      setReplicaTib(e.replica ? String(e.replica) : '');
      setSmartFilesTib(e.smartFiles ? String(e.smartFiles) : '');
      setLicenseExpiry(d.licenseExpiry || '');
      setLicenseEdition(d.licenseEdition || '');
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await client.put('/settings', {
        licenseEntitledDataProtectTb: Number(dpTib) || 0,
        licenseEntitledReplicaTb: Number(replicaTib) || 0,
        licenseEntitledSmartFilesTb: Number(smartFilesTib) || 0,
        licenseExpiry,
        licenseEdition,
      });
      toast({ type: 'success', title: 'Settings saved', message: 'Cohesity licensing entitlement updated.' });
    } catch {
      toast({ type: 'error', title: 'Save failed', message: 'Could not save settings. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
          <Server size={16} className="text-brand" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-ink">Cohesity Settings</h1>
          <p className="text-xs text-ink-muted mt-0.5">Cohesity-specific configuration. Global settings (AI keys, platforms, product license) are under the gear icon in the top bar.</p>
        </div>
      </div>

      {/* Section tabs */}
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

      {/* Helios (SaaS) */}
      {tab === 'helios' && <HeliosConnectTab />}

      {/* Direct Clusters */}
      {tab === 'direct' && <DirectClustersTab />}

      {/* Licensing entitlement */}
      {tab === 'entitlement' && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <BadgeCheck size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Licensing Entitlement</p>
            <p className="text-[11px] text-ink-muted">
              Your purchased capacity (decimal TB, as on the Cohesity license report) per license type. Consumed usage is
              pulled live from Helios; these are the baselines the <span className="text-ink">Licensing</span> page compares
              each type against.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-5 mt-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="dp-tib" className="block text-xs font-semibold text-ink mb-1">DataProtect (TB)</label>
                <input id="dp-tib" type="number" min="0" step="1" value={dpTib} onChange={e => setDpTib(e.target.value)}
                  placeholder="e.g. 15000"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
                <p className="text-[10px] text-ink-faint mt-1">All backed-up workloads (VMs, DBs, physical, M365, NAS backups).</p>
              </div>
              <div>
                <label htmlFor="replica-tib" className="block text-xs font-semibold text-ink mb-1">Replica (TB)</label>
                <input id="replica-tib" type="number" min="0" step="1" value={replicaTib} onChange={e => setReplicaTib(e.target.value)}
                  placeholder="e.g. 5000"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
                <p className="text-[10px] text-ink-faint mt-1">Replicated data on Cohesity clusters.</p>
              </div>
              <div>
                <label htmlFor="sf-tib" className="block text-xs font-semibold text-ink mb-1">SmartFiles (TB)</label>
                <input id="sf-tib" type="number" min="0" step="1" value={smartFilesTib} onChange={e => setSmartFilesTib(e.target.value)}
                  placeholder="e.g. 8000"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
                <p className="text-[10px] text-ink-faint mt-1">Data in Cohesity Views / NAS shares.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="license-edition" className="block text-xs font-semibold text-ink mb-1">Edition <span className="text-ink-faint font-normal">(optional)</span></label>
                <input id="license-edition" type="text" value={licenseEdition} onChange={e => setLicenseEdition(e.target.value)}
                  placeholder="e.g. DataProtect Enterprise"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
              </div>
              <div>
                <label htmlFor="license-expiry" className="block text-xs font-semibold text-ink mb-1">Expiry <span className="text-ink-faint font-normal">(optional)</span></label>
                <input id="license-expiry" type="date" value={licenseExpiry} onChange={e => setLicenseExpiry(e.target.value)}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
