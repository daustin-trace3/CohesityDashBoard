import { useEffect, useState } from 'react';
import { Save, Lock, Cloud, RefreshCw, Plus } from 'lucide-react';
import client from '../../api/client';
import { Badge } from '../ui/primitives';
import { useToast } from '../ui/Toaster';

function SourceBadge({ source }) {
  if (source === 'settings') return <Badge tone="ok">Stored encrypted</Badge>;
  if (source === 'env') return <Badge tone="warn">From .env (plain text)</Badge>;
  return <Badge tone="crit">Not set</Badge>;
}

export default function HeliosConnectTab() {
  const { toast } = useToast();

  const [credSources, setCredSources] = useState({});
  const [credsLoading, setCredsLoading] = useState(true);
  const [heliosKeyInput, setHeliosKeyInput] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);

  const [registeredClusters, setRegisteredClusters] = useState([]);
  const [clustersLoading, setClustersLoading] = useState(true);
  const [heliosClusters, setHeliosClusters] = useState([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState(null);
  const [selected, setSelected] = useState([]);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [adding, setAdding] = useState(false);

  const loadCreds = () => {
    setCredsLoading(true);
    client.get('/settings/credentials')
      .then(({ data }) => setCredSources(data))
      .catch(() => {})
      .finally(() => setCredsLoading(false));
  };

  const loadClusters = () => {
    setClustersLoading(true);
    client.get('/clusters')
      .then(({ data }) => setRegisteredClusters(data.filter(c => c.connection_type === 'helios')))
      .catch(() => {})
      .finally(() => setClustersLoading(false));
  };

  useEffect(() => { loadCreds(); loadClusters(); }, []);

  const saveHeliosKey = async () => {
    const v = heliosKeyInput.trim();
    if (!v) return;
    setSavingCreds(true);
    try {
      const { data } = await client.put('/settings/credentials', { heliosApiKey: v });
      setCredSources(data);
      setHeliosKeyInput('');
      toast({ type: 'success', title: 'Helios API key saved', message: 'Stored encrypted. Applied immediately — no restart needed.' });
    } catch {
      toast({ type: 'error', title: 'Save failed', message: 'Could not save the key. Try again.' });
    } finally {
      setSavingCreds(false);
    }
  };

  const clearHeliosKey = async () => {
    setSavingCreds(true);
    try {
      const { data } = await client.put('/settings/credentials', { heliosApiKey: '' });
      setCredSources(data);
      toast({ type: 'success', title: 'Stored key cleared', message: 'The .env value (if any) applies again.' });
    } catch {
      toast({ type: 'error', title: 'Clear failed', message: 'Could not clear the key. Try again.' });
    } finally {
      setSavingCreds(false);
    }
  };

  const handleDiscover = async () => {
    setDiscoverLoading(true);
    setDiscoverError(null);
    try {
      const { data } = await client.get('/helios/clusters');
      setHeliosClusters(data);
      setSelected([]);
    } catch (err) {
      setDiscoverError(err.response?.data?.error || 'Could not fetch Helios clusters.');
    } finally {
      setDiscoverLoading(false);
    }
  };

  const registeredClusterIds = new Set(registeredClusters.map(c => String(c.vip)));

  const toggleSelected = (clusterId) => {
    setSelected(prev => prev.includes(clusterId) ? prev.filter(id => id !== clusterId) : [...prev, clusterId]);
  };

  const handleAddSelected = async () => {
    setAdding(true);
    const credentials = apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {};
    let added = 0;
    const skipped = [];
    for (const clusterId of selected) {
      const info = heliosClusters.find(c => String(c.clusterId) === clusterId);
      const name = info?.name || clusterId;
      try {
        await client.post('/clusters', {
          name,
          connection_type: 'helios',
          vip: String(clusterId),
          auth_type: 'apikey',
          credentials,
          polling_interval_minutes: 60
        });
        added++;
      } catch (err) {
        const msg = err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'failed';
        skipped.push(`${name} — ${msg}`);
      }
    }
    const message = skipped.length
      ? `Added ${added}, skipped ${skipped.length}: ${skipped.join('; ')}`
      : `Added ${added} cluster(s)`;
    toast({ type: skipped.length ? 'error' : 'success', title: skipped.length ? 'Some clusters were skipped' : 'Clusters added', message });
    setSelected([]);
    setAdding(false);
    loadClusters();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Helios API key */}
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Lock size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Helios API key</p>
            <p className="text-[11px] text-ink-muted">
              Used for Helios cluster discovery, licensing reports, and any Helios-connected cluster without its own key.
              Stored <span className="text-ink">AES-256-GCM encrypted</span> in the local database, never displayed again,
              and applied immediately. A stored key overrides <code>.env</code>.
            </p>
            <p className="text-[11px] text-ink-faint mt-1">
              Connecting a cluster directly (no Helios)? Use the <span className="text-ink">Direct Clusters</span> tab instead.
            </p>
          </div>
        </div>

        {credsLoading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3 mt-4">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-xs font-semibold text-ink">Status</span>
              <SourceBadge source={credSources.heliosApiKey || 'none'} />
              {credSources.heliosApiKey === 'settings' && (
                <button
                  onClick={clearHeliosKey}
                  disabled={savingCreds}
                  className="text-[10px] text-ink-faint hover:text-status-crit underline underline-offset-2 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Clear stored value
                </button>
              )}
            </div>
            <input
              type="password"
              autoComplete="off"
              value={heliosKeyInput}
              onChange={e => setHeliosKeyInput(e.target.value)}
              placeholder={credSources.heliosApiKey === 'settings' ? '•••••••• (stored — enter a new value to replace)' : 'Paste Helios API key to store encrypted'}
              className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs font-mono text-ink focus:border-brand/60 outline-none"
            />
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={saveHeliosKey}
                disabled={savingCreds || !heliosKeyInput.trim()}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save size={13} /> {savingCreds ? 'Saving…' : 'Save key'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Helios-connected clusters */}
      <div className="panel p-4">
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
              <Cloud size={14} className="text-brand" />
            </div>
            <div>
              <p className="text-sm font-bold text-ink">Helios-connected clusters</p>
              <p className="text-[11px] text-ink-muted">{clustersLoading ? 'Loading…' : `${registeredClusters.length} cluster(s) registered via Helios`}</p>
            </div>
          </div>
          <button
            onClick={handleDiscover}
            disabled={discoverLoading}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={13} className={discoverLoading ? 'animate-spin' : ''} /> {discoverLoading ? 'Discovering…' : 'Discover clusters'}
          </button>
        </div>

        {discoverError && <p className="text-[12px] text-status-crit mb-2">{discoverError}</p>}

        {heliosClusters.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="border border-cohesity-border rounded-lg max-h-64 overflow-y-auto divide-y divide-cohesity-border">
              {heliosClusters.map(c => {
                const clusterId = String(c.clusterId);
                const alreadyRegistered = registeredClusterIds.has(clusterId);
                const isSelected = selected.includes(clusterId);
                return (
                  <label
                    key={clusterId}
                    className={`flex items-center gap-3 px-3 py-2 text-sm ${alreadyRegistered ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-overlay'}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={alreadyRegistered}
                      onChange={() => toggleSelected(clusterId)}
                      className="accent-brand"
                    />
                    <span className="font-medium text-ink">{c.name}</span>
                    <span className="text-ink-faint text-xs">ID: {clusterId}</span>
                    <span className="text-ink-faint text-xs">{c.softwareVersion || '—'}</span>
                    {alreadyRegistered && <Badge tone="neutral" className="ml-auto">Already registered</Badge>}
                  </label>
                );
              })}
            </div>

            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[220px]">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">API key (optional)</label>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  placeholder="Leave blank to use the Helios key above"
                  autoComplete="new-password"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                />
              </div>
              <button
                onClick={handleAddSelected}
                disabled={adding || selected.length === 0}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Plus size={13} /> {adding ? 'Adding…' : `Add selected (${selected.length})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
