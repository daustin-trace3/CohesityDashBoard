import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Hexagon, ShieldCheck, KeyRound, RefreshCw, LogIn } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../auth/AuthContext';

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

export default function LoginPage() {
  const { login, refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/cohesity';

  const [checkingSetup, setCheckingSetup] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Setup wizard state
  const [token, setToken] = useState('');
  const [setupUsername, setSetupUsername] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    client.get('/auth/setup-status')
      .then(r => {
        // Open-access mode has no login — send visitors straight in.
        if (r.data.authEnabled === false) {
          navigate('/', { replace: true });
          return;
        }
        setNeedsSetup(!!r.data.needsSetup);
      })
      .catch(() => setNeedsSetup(false))
      .finally(() => setCheckingSetup(false));
  }, [navigate]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      if (err?.response?.status === 401) {
        setError('Invalid username or password.');
      } else {
        setError(err?.response?.data?.error || 'Could not sign in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetup = async (e) => {
    e.preventDefault();
    setError(null);
    if (setupPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await client.post('/auth/setup', { token: token.trim(), username: setupUsername, password: setupPassword });
      await refresh();
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not complete setup. Check the claim token and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (checkingSetup) {
    return (
      <div className="h-screen flex items-center justify-center bg-cohesity-black">
        <RefreshCw size={20} className="animate-spin text-ink-faint" />
      </div>
    );
  }

  return (
    <div className="h-screen overflow-auto flex items-center justify-center bg-cohesity-black px-4">
      <div className="w-full max-w-md bg-surface border border-cohesity-border rounded-xl p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center flex-shrink-0">
            <Hexagon size={34} className="text-brand" strokeWidth={1.75} />
            <ShieldCheck size={16} className="text-brand absolute" strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Infrastructure Command Center</p>
            <p className="text-[11px] text-ink-muted">{needsSetup ? 'First-run setup' : 'Sign in'}</p>
          </div>
        </div>

        {needsSetup ? (
          <form onSubmit={handleSetup} className="flex flex-col gap-3">
            <p className="text-xs text-ink-muted leading-relaxed">
              No administrator account exists yet. Enter the claim token printed in the server console/log,
              then choose a username and password for the first admin account.
            </p>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Claim token</label>
              <input type="text" value={token} onChange={e => setToken(e.target.value)} className={`${inputClass} font-mono`} required />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Username</label>
              <input type="text" value={setupUsername} onChange={e => setSetupUsername(e.target.value)} className={inputClass} autoComplete="username" required />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Password</label>
              <input type="password" value={setupPassword} onChange={e => setSetupPassword(e.target.value)} className={inputClass} autoComplete="new-password" required />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Confirm password</label>
              <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className={inputClass} autoComplete="new-password" required />
            </div>
            {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
            <button type="submit" disabled={submitting}
              className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
              <KeyRound size={13} /> {submitting ? 'Creating account…' : 'Create admin account'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Username</label>
              <input type="text" value={username} onChange={e => setUsername(e.target.value)} className={inputClass} autoComplete="username" required autoFocus />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputClass} autoComplete="current-password" required />
            </div>
            {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
            <button type="submit" disabled={submitting}
              className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
              <LogIn size={13} /> {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
