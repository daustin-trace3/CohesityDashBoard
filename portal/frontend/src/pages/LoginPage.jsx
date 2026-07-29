import { useEffect, useState } from 'react';
import { TowerControl, KeyRound, LogIn } from 'lucide-react';
import client from '../api/client';

export default function LoginPage({ onAuthed }) {
  const [needsSetup, setNeedsSetup] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.get('/auth/setup-status')
      .then(({ data }) => setNeedsSetup(data.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) {
        await client.post('/auth/setup', { token: token.trim(), username, password });
      } else {
        await client.post('/auth/login', { username, password });
      }
      await onAuthed();
    } catch (err) {
      setError(err.response?.data?.error || 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full bg-surface-raised border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-faint focus:border-brand/60 transition-colors';

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-brand/15 border border-brand/30 flex items-center justify-center mb-3">
            <TowerControl size={24} className="text-brand" />
          </div>
          <h1 className="text-lg font-bold text-ink text-center leading-tight">
            Infrastructure <span className="text-brand">Command Center</span>
          </h1>
          <p className="text-xs text-ink-muted mt-1">MSP Portal</p>
        </div>

        <form onSubmit={submit} className="panel p-5 flex flex-col gap-3">
          {needsSetup && (
            <>
              <p className="text-xs text-ink-muted leading-relaxed">
                First-run setup — enter the claim token printed in the portal server log to create the admin account.
              </p>
              <div className="relative">
                <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
                <input
                  className={`${input} pl-9 font-mono`}
                  placeholder="Setup claim token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoFocus
                />
              </div>
            </>
          )}
          <input
            className={input}
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus={!needsSetup}
            autoComplete="username"
          />
          <input
            className={input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
          />
          {error && <p className="text-xs text-status-crit">{error}</p>}
          <button
            type="submit"
            disabled={busy || needsSetup === null}
            className="flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-sm font-semibold rounded-lg px-4 py-2 transition-colors cursor-pointer"
          >
            <LogIn size={15} /> {needsSetup ? 'Create admin account' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
