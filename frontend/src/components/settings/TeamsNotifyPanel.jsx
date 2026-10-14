import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Save, Send, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { Badge } from '../ui/primitives';
import { useToast } from '../ui/Toaster';

// Global Settings > Operations Agent: the Teams channel. The agent posts each
// incident it would email (and, if asked, its resolution) as an Adaptive Card
// to a Power Automate workflow URL. The URL is write-only: the page only
// learns whether one is stored.
export default function TeamsNotifyPanel() {
  const [form, setForm] = useState(null);
  const [webhook, setWebhook] = useState('');
  const [stored, setStored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [failed, setFailed] = useState(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const { data } = await client.get('/settings');
      const a = data.opsAgent || {};
      setForm({ teamsEnabled: !!a.teamsEnabled, teamsOnResolve: a.teamsOnResolve !== false, iccBaseUrl: data.iccBaseUrl ?? a.iccBaseUrl ?? '' });
      setStored(!!a.teamsWebhookSet);
      setWebhook('');
      setFailed(null);
    } catch (e) {
      setFailed(e?.response?.data?.error || 'Could not load the Teams settings.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const put = async (opsAgent, extra = {}) => client.put('/settings', { opsAgent, ...extra });

  const save = async () => {
    setSaving(true);
    try {
      await put({ teamsEnabled: form.teamsEnabled, teamsOnResolve: form.teamsOnResolve, teamsWebhook: webhook.trim() }, { iccBaseUrl: form.iccBaseUrl.trim() });
      toast({ type: 'success', title: 'Teams settings saved' });
      await load();
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      await put({ teamsWebhook: null });
      toast({ type: 'success', title: 'Workflow URL cleared' });
      await load();
    } catch (e) {
      toast({ type: 'error', title: 'Clear failed', message: e?.response?.data?.error || 'Could not clear. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await client.post('/ops-agent/test-teams');
      toast({ type: 'success', title: 'Test card sent', message: 'Check the Teams chat or channel the workflow posts to.' });
    } catch (e) {
      toast({ type: 'error', title: 'Test card failed', message: e?.response?.data?.error || 'Could not send. Try again.' });
    } finally {
      setTesting(false);
    }
  };

  const input = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
          <MessageSquare size={14} className="text-brand" />
        </div>
        <div>
          <p className="text-sm font-bold text-ink">Microsoft Teams</p>
          <p className="text-[11px] text-ink-muted">Posts each incident as a card to a Teams workflow, beside email and without SMTP.</p>
        </div>
      </div>
      {failed && <p className="mt-3 text-[11px] text-red-400 bg-red-400/10 border border-red-400/30 rounded-md px-2.5 py-1.5">{failed}</p>}
      {!form ? (
        <p className="text-gray-400 text-sm mt-4">Loading...</p>
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={form.teamsEnabled} onChange={(e) => setForm((f) => ({ ...f, teamsEnabled: e.target.checked }))} className="accent-brand cursor-pointer mt-0.5" />
            <span>
              <span className="block text-sm text-ink font-medium">Post incidents to Teams</span>
              <span className="block text-[11px] text-ink-muted">Same rules as email: never baseline incidents, re-posts follow the renotify window.</span>
            </span>
          </label>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-ink">Workflow URL</span>
              {stored ? <Badge tone="ok">stored</Badge> : <Badge tone="neutral">not set</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <input type="password" autoComplete="off" value={webhook} onChange={(e) => setWebhook(e.target.value)}
                placeholder={stored ? 'Leave blank to keep the stored URL' : 'https://...'} className={input} />
              {stored && (
                <button onClick={clear} disabled={saving}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap">
                  <Trash2 size={12} /> Clear
                </button>
              )}
            </div>
            <p className="text-[10px] text-ink-faint mt-1">From the Teams Workflows app: "When a Teams webhook request is received". Stored encrypted, never shown again.</p>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={form.teamsOnResolve} onChange={(e) => setForm((f) => ({ ...f, teamsOnResolve: e.target.checked }))} className="accent-brand cursor-pointer mt-0.5" />
            <span>
              <span className="block text-sm text-ink font-medium">Also post when resolved</span>
              <span className="block text-[11px] text-ink-muted">A short closing card for incidents already posted.</span>
            </span>
          </label>

          <div>
            <span className="block text-xs font-medium text-ink mb-1">ICC address</span>
            <input type="url" value={form.iccBaseUrl} onChange={(e) => setForm((f) => ({ ...f, iccBaseUrl: e.target.value }))}
              placeholder="https://icc.example.com" className={input} />
            <p className="text-[10px] text-ink-faint mt-1">Used for the Open in ICC link on each card. Blank means no link.</p>
          </div>

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
              <Save size={13} /> {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={test} disabled={testing || !stored}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
              <Send size={12} /> {testing ? 'Sending...' : 'Send test card'}
            </button>
            {!stored && <span className="text-[11px] text-ink-faint">Save a workflow URL to send a test card.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
