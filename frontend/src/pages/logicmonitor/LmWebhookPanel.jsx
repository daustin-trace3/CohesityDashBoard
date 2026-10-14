// Settings > Portals > Webhook sub-panel: push LogicMonitor alerts to ICC the
// moment they fire (Custom HTTP Delivery integration) instead of waiting for
// the next poll. The token is shown once, right after it is generated.
import { useCallback, useEffect, useState } from 'react';
import { Webhook, Copy, KeyRound, Ban } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { fmtWhen, fmtNum } from './helpers';
import { SectionPanel, sel, btnPrimary, btnGhost } from './ui';

async function copyText(text, toast, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ type: 'success', title: `${what} copied` });
  } catch {
    toast({ type: 'error', title: 'Copy failed', message: 'Select the text and copy it by hand.' });
  }
}

function WebhookBody({ source }) {
  const { toast } = useToast();
  const [info, setInfo] = useState(null);
  const [missing, setMissing] = useState(false);
  const [token, setToken] = useState(null); // plain token, shown once
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => client.get(`/logicmonitor/sources/${source.id}/webhook`)
    .then(({ data }) => { setInfo(data || {}); setMissing(false); })
    .catch(() => { setInfo({}); setMissing(true); }), [source.id]);

  useEffect(() => { setInfo(null); setToken(null); load(); }, [load]);

  const generate = async () => {
    if (info?.enabled && !window.confirm('Generating a new token replaces the current one. LogicMonitor stops delivering until you paste the new token. Continue?')) return;
    setBusy(true);
    try {
      const { data } = await client.post(`/logicmonitor/sources/${source.id}/webhook-token`);
      setToken(data?.token || data?.plainToken || null);
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Could not generate a token', message: err?.response?.data?.error });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!window.confirm(`Disable the webhook for ${source.name}? Deliveries from LogicMonitor will be refused.`)) return;
    setBusy(true);
    try {
      await client.delete(`/logicmonitor/sources/${source.id}/webhook-token`);
      setToken(null);
      await load();
      toast({ type: 'success', title: 'Webhook disabled' });
    } catch (err) {
      toast({ type: 'error', title: 'Disable failed', message: err?.response?.data?.error });
    } finally {
      setBusy(false);
    }
  };

  if (info == null) return <LoadingPanel label="Loading webhook..." height={80} />;
  if (missing) return <p className="text-sm text-ink-muted py-3">Webhook settings are not available on this server.</p>;

  const template = typeof info.template === 'string' ? info.template : (info.template ? JSON.stringify(info.template, null, 2) : '');

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <Badge tone={info.enabled ? 'ok' : 'neutral'}>{info.enabled ? 'Enabled' : 'Disabled'}</Badge>
        <span className="text-[11px] text-ink-faint tnum">Last received: {info.lastAt ? fmtWhen(info.lastAt) : 'never'}</span>
        <span className="text-[11px] text-ink-faint tnum">Received: {fmtNum(info.count || 0)}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={generate} disabled={busy} className={`${btnPrimary} inline-flex items-center gap-1.5`}><KeyRound size={13} /> {info.enabled ? 'Regenerate token' : 'Generate token'}</button>
          {info.enabled && <button onClick={disable} disabled={busy} className={`${btnGhost} inline-flex items-center gap-1.5`}><Ban size={13} /> Disable</button>}
        </div>
      </div>

      {token && (
        <div className="rounded-lg border border-status-warn/50 bg-status-warn/10 p-3 mb-3">
          <p className="text-xs font-semibold text-ink mb-1">Webhook token</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 font-mono text-[12px] text-ink break-all select-all">{token}</code>
            <button onClick={() => copyText(token, toast, 'Token')} className={`${btnGhost} inline-flex items-center gap-1.5 !px-3 !py-1.5`}><Copy size={13} /> Copy</button>
          </div>
          <p className="text-[11px] text-status-warn mt-1.5">This token is not shown again. Paste it into the integration now; ICC keeps only a hash.</p>
        </div>
      )}

      {info.lastError && <p className="text-[11px] text-status-crit mb-3 break-words">Last error: {info.lastError}</p>}

      <div className="mb-3">
        <label className="block text-xs font-semibold text-ink mb-1">URL</label>
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 font-mono text-[12px] text-ink-muted bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 break-all">{info.url || '-'}</code>
          {info.url && <button onClick={() => copyText(info.url, toast, 'URL')} className={`${btnGhost} inline-flex items-center gap-1.5 !px-3 !py-1.5`}><Copy size={13} /> Copy</button>}
        </div>
        <p className="text-[10px] text-ink-faint mt-1">Send the token in the x-icc-webhook-token header.</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-ink">Payload template for LogicMonitor Custom HTTP Delivery</label>
          {template && <button onClick={() => copyText(template, toast, 'Template')} className="text-[11px] text-brand hover:underline cursor-pointer inline-flex items-center gap-1"><Copy size={11} /> Copy</button>}
        </div>
        <pre className="font-mono text-[11px] text-ink-muted bg-surface-overlay border border-cohesity-border rounded-lg p-3 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">{template || '(template unavailable)'}</pre>
      </div>
    </>
  );
}

export default function LmWebhookPanel({ sources }) {
  const [sourceId, setSourceId] = useState('');
  const list = Array.isArray(sources) ? sources : [];
  const source = list.find((s) => String(s.id) === String(sourceId)) || list[0];

  if (!source) return null;
  return (
    <SectionPanel icon={Webhook} title="Webhook"
      blurb="LogicMonitor can push alerts to ICC the moment they fire. Create a Custom HTTP Delivery integration in LogicMonitor with the URL and payload below, add the token as the x-icc-webhook-token header, and attach it to an escalation chain. Polling keeps running as the safety net.">
      {list.length > 1 && (
        <div className="mb-3">
          <select value={String(source.id)} onChange={(e) => setSourceId(e.target.value)} className={sel}>
            {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}
      <WebhookBody key={source.id} source={source} />
    </SectionPanel>
  );
}
