import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Puzzle, Upload, Trash2, Power, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import AdminNav from '../components/AdminNav';
import client from '../api/client';
import { PageHeader, Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import { useAuth } from '../auth/AuthContext';

function errorMessage(err, fallback) {
  return err?.response?.data?.error || fallback;
}

function SourceBadge({ source }) {
  return <Badge tone={source === 'builtin' ? 'neutral' : 'brand'}>{source === 'builtin' ? 'Built-in' : 'Installed'}</Badge>;
}

function StatusBadge({ status }) {
  if (status === 'active') return <Badge tone="ok">Active</Badge>;
  if (status === 'error') return <Badge tone="crit">Error</Badge>;
  return <Badge tone="neutral">{status || 'Inactive'}</Badge>;
}

function PendingBadge({ pendingAction }) {
  if (!pendingAction || pendingAction === 'none') return null;
  const label = pendingAction === 'restart-upgrade' ? 'Upgrade pending restart' : 'Removal pending restart';
  return <Badge tone="warn">{label}</Badge>;
}

function UninstallModal({ plugin, onClose, onConfirm }) {
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(purge);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative bg-cohesity-gray border border-cohesity-border rounded-lg w-full max-w-md shadow-xl animate-fade-in">
        <div className="px-5 py-3.5 border-b border-cohesity-border">
          <p className="text-sm font-bold text-ink">Uninstall {plugin.name}</p>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <p className="text-xs text-ink-muted">
            The plugin will be removed on the next restart. This cannot be undone.
          </p>
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={purge} onChange={e => setPurge(e.target.checked)} className="accent-brand mt-0.5 cursor-pointer" />
            <span className="text-xs text-ink-muted leading-relaxed">
              <span className="font-semibold text-ink">Also delete its data</span><br />
              Permanently drops this plugin's database tables on restart.
            </span>
          </label>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="text-xs font-medium px-3.5 py-2 text-ink-muted hover:text-ink transition-colors cursor-pointer">
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={busy}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-status-crit/10 border border-status-crit/30 text-status-crit rounded-lg hover:bg-status-crit/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Trash2 size={13} /> {busy ? 'Removing…' : 'Uninstall'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminPluginsPage() {
  const { hasPermission, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [plugins, setPlugins] = useState(null);
  const [error, setError] = useState(null);
  const [expandedError, setExpandedError] = useState(null);
  const [uninstallTarget, setUninstallTarget] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const canManage = authLoading || hasPermission('admin:plugins:manage');

  const load = useCallback(() => {
    setError(null);
    client.get('/plugins')
      .then(({ data }) => setPlugins(data))
      .catch(err => setError(errorMessage(err, 'Could not load plugins.')));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleEnabled = async (p) => {
    try {
      await client.post(`/plugins/${p.id}/enabled`, { enabled: !p.enabled });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not update plugin', message: errorMessage(err, '') });
    }
  };

  const uninstall = async (p, purgeData) => {
    try {
      await client.delete(`/plugins/${p.id}`, { data: { purgeData } });
      toast({ type: 'success', title: 'Plugin queued for removal', message: 'Restart the server to complete removal.' });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not uninstall plugin', message: errorMessage(err, '') });
      throw err;
    }
  };

  const uploadFile = async (file) => {
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('plugin', file);
      const { data } = await client.post('/plugins/install', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      window.dispatchEvent(new Event('platforms-changed'));
      toast({
        type: 'success',
        title: data.hotAdded ? 'Installed and live' : 'Installed — restart to apply',
        message: data.hotAdded ? `${data.id} is active now.` : `${data.id} will apply after the next restart.`,
      });
      load();
    } catch (err) {
      setUploadError(errorMessage(err, 'Could not install the plugin.'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  };

  if (authLoading) return <p className="text-xs text-ink-faint">Loading…</p>;

  if (!hasPermission('admin:plugins:view')) {
    return (
      <div className="panel p-4 max-w-lg">
        <p className="text-sm font-bold text-ink">Access denied</p>
        <p className="text-xs text-ink-muted mt-1">You don't have permission to view Plugins.</p>
      </div>
    );
  }

  const restartNeeded = (plugins || []).some(p => p.pendingAction && p.pendingAction !== 'none');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={Puzzle}
        title="Plugins"
        description="Built-in and installed platform plugins. Installed plugins add data protection platforms without a code deploy."
      />

      <div className="flex flex-col md:flex-row gap-5 items-start">
        <AdminNav />
        <div className="flex flex-col gap-4 flex-1 min-w-0">

      {restartNeeded && (
        <p className="text-xs text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-lg px-3 py-2">
          A restart is required to apply one or more pending plugin changes.
        </p>
      )}

      {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}

      {canManage && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`panel p-6 flex flex-col items-center justify-center gap-2 border-dashed cursor-pointer transition-colors ${
            dragOver ? 'border-brand/60 bg-brand/5' : 'border-cohesity-border hover:border-brand/40'
          }`}
        >
          <Upload size={20} className="text-brand" />
          <p className="text-xs font-medium text-ink">Drop a .iccplugin / .zip here, or click to browse</p>
          <p className="text-[11px] text-ink-faint">Signed plugin packages only.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".iccplugin,.zip"
            className="hidden"
            onChange={(e) => uploadFile(e.target.files?.[0])}
          />
          {uploading && <p className="text-[11px] text-ink-muted">Installing…</p>}
          {uploadError && (
            <p className="text-[11px] text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-2.5 py-1.5 mt-1">
              {uploadError}
            </p>
          )}
        </div>
      )}

      {!plugins ? (
        <p className="text-xs text-ink-faint">Loading…</p>
      ) : (
        <div className="panel p-0 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-cohesity-border text-ink-faint text-[10px] uppercase tracking-wider">
                <th className="text-left px-3 py-2 font-semibold">Name</th>
                <th className="text-left px-3 py-2 font-semibold">ID</th>
                <th className="text-left px-3 py-2 font-semibold">Version</th>
                <th className="text-left px-3 py-2 font-semibold">Source</th>
                <th className="text-left px-3 py-2 font-semibold">Status</th>
                <th className="text-left px-3 py-2 font-semibold">Enabled</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {plugins.map(p => (
                <Fragment key={p.id}>
                  <tr className="border-b border-cohesity-border/50 last:border-0 hover:bg-surface-overlay/50">
                    <td className="px-3 py-2 text-ink font-medium">{p.name}</td>
                    <td className="px-3 py-2 text-ink-muted font-mono">{p.id}</td>
                    <td className="px-3 py-2 text-ink-muted tnum">{p.version || '—'}</td>
                    <td className="px-3 py-2"><SourceBadge source={p.source} /></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {p.entitled === false ? <Badge tone="warn">Not licensed</Badge> : <StatusBadge status={p.status} />}
                        <PendingBadge pendingAction={p.pendingAction} />
                        {p.status === 'error' && p.error && (
                          <button
                            onClick={() => setExpandedError(expandedError === p.id ? null : p.id)}
                            aria-label="Toggle error details"
                            className="text-ink-faint hover:text-ink cursor-pointer"
                          >
                            {expandedError === p.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {canManage ? (
                        <button
                          onClick={() => toggleEnabled(p)}
                          disabled={p.entitled === false}
                          className={`inline-flex items-center gap-1 chip cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                            p.enabled ? 'bg-status-ok/10 text-status-ok border-status-ok/25' : 'bg-surface-overlay text-ink-muted border-cohesity-border'
                          }`}
                        >
                          <Power size={10} /> {p.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                      ) : (
                        <Badge tone={p.enabled ? 'ok' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canManage && p.source === 'installed' && (
                        <button
                          onClick={() => setUninstallTarget(p)}
                          aria-label={`Uninstall ${p.name}`}
                          className="text-ink-faint hover:text-status-crit cursor-pointer"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedError === p.id && p.error && (
                    <tr className="border-b border-cohesity-border/50 last:border-0">
                      <td colSpan={7} className="px-3 py-2 bg-status-crit/5">
                        <div className="flex items-start gap-2 text-[11px] text-status-crit">
                          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                          <code className="whitespace-pre-wrap break-all">{p.error}</code>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {plugins.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-faint">No plugins found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {uninstallTarget && (
        <UninstallModal
          plugin={uninstallTarget}
          onClose={() => setUninstallTarget(null)}
          onConfirm={(purgeData) => uninstall(uninstallTarget, purgeData)}
        />
      )}
        </div>
      </div>
    </div>
  );
}
