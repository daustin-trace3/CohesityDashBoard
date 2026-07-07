import { useEffect, useState, useCallback } from 'react';
import { Hexagon, ShieldCheck, KeyRound, RefreshCw, AlertTriangle } from 'lucide-react';
import client from '../api/client';

/**
 * Product license gate. Wraps the whole app:
 *  - missing/invalid/blocked → full-screen license page, app unreachable
 *  - grace (expired < 14d)   → app usable with a persistent red banner
 *  - valid                   → children as-is
 */
export default function LicenseGate({ children }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [cert, setCert] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [applyingKey, setApplyingKey] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);

  const load = useCallback(() => {
    client.get('/license/status')
      .then(r => setStatus(r.data))
      .catch(() => setStatus({ state: 'unreachable' }));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, [load]);

  const checkRenewal = async () => {
    setChecking(true);
    setActionMsg(null);
    try {
      const { data } = await client.post('/license/renew');
      setActionMsg(data.renewed ? 'License renewed — thank you!' : `No renewal available: ${data.reason || 'not found'}.`);
      load();
    } catch {
      setActionMsg('Could not reach the dashboard API.');
    } finally {
      setChecking(false);
    }
  };

  const activateKey = async () => {
    setApplyingKey(true);
    setActionMsg(null);
    try {
      const { data } = await client.post('/license/activate', { key: keyInput.trim() });
      if (data.state === 'valid' || data.state === 'grace') {
        setActionMsg(`License activated for ${data.customer || 'this installation'} — expires ${data.effectiveExpiry}.`);
        setKeyInput('');
      } else {
        setActionMsg(`Key accepted but it expired ${data.effectiveExpiry} — renew to restore access.`);
      }
      load();
    } catch (e) {
      setActionMsg(e?.response?.data?.error || 'Could not activate the key.');
    } finally {
      setApplyingKey(false);
    }
  };

  const applyCert = async () => {
    setActionMsg(null);
    try {
      await client.post('/license/extension', { cert: cert.trim() });
      setActionMsg('Extension applied — license renewed.');
      setCert('');
      load();
    } catch (e) {
      setActionMsg(e?.response?.data?.error || 'Extension was rejected.');
    }
  };

  if (status == null) {
    return (
      <div className="h-screen flex items-center justify-center bg-cohesity-black">
        <RefreshCw size={20} className="animate-spin text-ink-faint" />
      </div>
    );
  }

  // API itself unreachable — let the app render; its own error handling applies.
  const blocked = ['missing', 'invalid', 'blocked'].includes(status.state);

  if (blocked) {
    const headline = status.state === 'missing'
      ? 'License key required'
      : status.state === 'invalid'
        ? 'License key is invalid'
        : 'License expired';
    const detail = status.state === 'missing'
      ? 'This installation has no license key. Paste the key from your welcome email below — it is saved automatically and the app unlocks immediately.'
      : status.state === 'invalid'
        ? 'The configured license key failed validation. Paste a correct key below, or contact support for a replacement.'
        : `The license for ${status.customer || 'this installation'} expired on ${status.effectiveExpiry} and the grace period has ended. Renew to restore access — the same key keeps working once payment is processed.`;

    return (
      <div className="h-screen overflow-auto flex items-center justify-center bg-cohesity-black px-4">
        <div className="w-full max-w-lg bg-surface border border-cohesity-border rounded-xl p-6 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center flex-shrink-0">
              <Hexagon size={34} className="text-brand" strokeWidth={1.75} />
              <ShieldCheck size={16} className="text-brand absolute" strokeWidth={2.5} />
            </div>
            <div>
              <p className="text-sm font-bold text-ink">Cohesity Command Center</p>
              <p className="text-[11px] text-ink-muted">Product licensing</p>
            </div>
          </div>

          <div className="flex items-start gap-2.5 bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2.5">
            <KeyRound size={16} className="text-status-crit mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-ink">{headline}</p>
              <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">{detail}</p>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-ink mb-1">{status.state === 'blocked' ? 'Have a new license key?' : 'Enter your license key'}</p>
            <textarea value={keyInput} onChange={e => setKeyInput(e.target.value)} rows={3}
              placeholder="CDBL-…"
              className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink font-mono focus:border-brand/60 outline-none resize-y" />
            <button onClick={activateKey} disabled={!keyInput.trim() || applyingKey}
              className="mt-2 flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
              <KeyRound size={13} /> {applyingKey ? 'Activating…' : 'Activate license'}
            </button>
            <p className="text-[10px] text-ink-faint mt-1.5">The key is saved to the platform configuration (.env) — no restart needed.</p>
          </div>

          {status.state === 'blocked' && (
            <>
              <button onClick={checkRenewal} disabled={checking}
                className="flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
                <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> {checking ? 'Checking…' : 'Check for renewal now'}
              </button>
              <div>
                <p className="text-xs font-semibold text-ink mb-1">Air-gapped renewal</p>
                <p className="text-[11px] text-ink-muted mb-2">Paste the extension certificate (CDBX-…) from your renewal email:</p>
                <textarea value={cert} onChange={e => setCert(e.target.value)} rows={3}
                  placeholder="CDBX-…"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink font-mono focus:border-brand/60 outline-none resize-y" />
                <button onClick={applyCert} disabled={!cert.trim()}
                  className="mt-2 text-xs font-medium px-3.5 py-2 border border-cohesity-border rounded-lg text-ink-muted hover:border-brand/50 hover:text-brand transition-colors disabled:opacity-40 cursor-pointer">
                  Apply extension
                </button>
              </div>
            </>
          )}

          {actionMsg && <p className="text-xs text-ink-muted bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2">{actionMsg}</p>}

          {status.licenseId && (
            <p className="text-[10px] text-ink-faint">License {status.licenseId}{status.customer ? ` · ${status.customer}` : ''}{status.effectiveExpiry ? ` · expired ${status.effectiveExpiry}` : ''}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {status.state === 'grace' && (
        <div className="flex items-center justify-center gap-2.5 bg-status-crit/15 border-b border-status-crit/40 px-4 py-1.5 text-xs">
          <AlertTriangle size={13} className="text-status-crit flex-shrink-0" />
          <span className="text-ink">
            License expired {status.effectiveExpiry} — the dashboard locks in{' '}
            <span className="font-bold text-status-crit">{status.graceDaysLeft} day{status.graceDaysLeft === 1 ? '' : 's'}</span>.
            Renewal is automatic once payment is processed.
          </span>
          <button onClick={checkRenewal} disabled={checking}
            className="text-status-crit font-semibold hover:underline cursor-pointer disabled:opacity-50">
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      )}
      {children}
    </>
  );
}
