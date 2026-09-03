import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, KeyRound, RefreshCw, LogIn, Layers, Activity, Lock } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../auth/AuthContext';
import t3Logo from '../assets/t3_logo_dark.png';

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

export default function LoginPage() {
  const { login, refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/cohesity';

  const [checkingSetup, setCheckingSetup] = useState(true);
  const [health, setHealth] = useState(null); // null = checking, true/false = result

  useEffect(() => {
    let alive = true;
    const check = () => {
      fetch('/health').then((r) => { if (alive) setHealth(r.ok); }).catch(() => { if (alive) setHealth(false); });
    };
    check();
    const t = setInterval(check, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);
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
  const [directory, setDirectory] = useState(null);

  useEffect(() => {
    client.get('/auth/setup-status')
      .then(r => {
        // Open-access mode has no login — send visitors straight in.
        if (r.data.authEnabled === false) {
          navigate('/', { replace: true });
          return;
        }
        setNeedsSetup(!!r.data.needsSetup);
        setDirectory(r.data.directory?.enabled ? r.data.directory : null);
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
    <div className="min-h-screen overflow-auto flex bg-cohesity-black">
      {/* Brand hero — hidden on small screens */}
      <div className="hidden lg:flex flex-1 flex-col justify-between px-14 xl:px-20 py-10 relative overflow-hidden">
        {/* soft glow behind the hero icon */}
        <div className="absolute -left-40 top-1/4 w-[560px] h-[560px] rounded-full bg-status-info/5 blur-3xl pointer-events-none" />
        <div className="absolute right-0 -bottom-32 w-[420px] h-[420px] rounded-full bg-brand/5 blur-3xl pointer-events-none" />

        <div className="flex flex-col gap-3">
          <img src={t3Logo} alt="Trace3" width={200} height={67} className="h-[67px] w-auto self-start select-none" draggable={false} />
          <div className="inline-flex items-center gap-2 rounded-full px-4 py-1 text-base font-medium border border-cohesity-border text-ink-muted w-fit">
            <span className={`w-2.5 h-2.5 rounded-full ${health === null ? 'bg-ink-faint animate-pulse' : health ? 'bg-status-ok animate-pulse' : 'bg-status-crit'}`} />
            {health === null ? 'Checking status…' : health ? 'Platform Online' : 'Platform Offline'}
          </div>
        </div>

        <div className="relative animate-fade-in">
          <img src="/icc-icon.png" alt="" className="w-52 h-52 rounded-3xl shadow-modal mb-10 select-none" draggable={false} />
          <h1 className="text-6xl xl:text-7xl font-extrabold text-ink tracking-tight leading-none">
            Infrastructure<br />
            <span className="text-brand">Command Center</span>
          </h1>
          <p className="text-base text-ink-muted mt-6 max-w-lg leading-relaxed">
            One pane for your entire estate — data protection, storage, virtualization, and automation platforms with live polling and alerting.
          </p>

          <div className="grid grid-cols-3 gap-3 mt-10 max-w-2xl">
            {[
              { icon: Layers, title: 'Multi-Platform', text: 'Cohesity · Pure · NetApp · Zerto · vCenter · Dell · Aria' },
              { icon: Activity, title: 'Ops Rollup', text: 'Estate health and attention items at a glance' },
              { icon: ShieldCheck, title: 'AI Insights', text: 'Analysis with on-box anonymization' },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="panel px-4 py-3.5">
                <Icon size={15} className="text-brand mb-2" />
                <p className="text-xs font-bold text-ink">{title}</p>
                <p className="text-[11px] text-ink-muted mt-0.5 leading-snug">{text}</p>
              </div>
            ))}
          </div>

          <div className="chip border-cohesity-border text-ink-muted mt-6">
            <Lock size={11} className="text-brand" /> Encrypted credentials · Role-based access · Audit trail
          </div>
        </div>

        <p className="text-[11px] text-ink-faint">© {new Date().getFullYear()} Infrastructure Command Center</p>
      </div>

      {/* Sign-in card */}
      <div className="flex-1 lg:flex-none flex items-center justify-center p-10 lg:pr-[calc(14vw+125px)]">
        <div className="w-full max-w-[39rem] min-h-[31rem] bg-surface border border-cohesity-border rounded-2xl shadow-modal p-10 flex flex-col gap-2 animate-fade-in">
        <div>
          <p className="text-3xl font-bold text-ink">{needsSetup ? 'First-run setup' : 'Welcome back'}</p>
          <p className="text-lg text-ink-muted mt-1">
            {needsSetup ? 'Create the first administrator account.' : 'Sign in to Infrastructure Command Center.'}
          </p>
        </div>

        {needsSetup ? (
          <form onSubmit={handleSetup} className="flex-1 flex flex-col gap-3 mt-4">
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
              className="mt-auto flex items-center justify-center gap-1.5 text-sm font-semibold px-3.5 py-2.5 bg-brand hover:bg-brand-dark text-white rounded-lg transition-colors disabled:opacity-40 cursor-pointer">
              <KeyRound size={13} /> {submitting ? 'Creating account…' : 'Create admin account'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="flex-1 flex flex-col gap-3 mt-2">
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Username</label>
              <input type="text" value={username} onChange={e => setUsername(e.target.value)} className={inputClass} autoComplete="username" required autoFocus />
              {directory && (
                <p className="text-[11px] text-ink-faint mt-1">Domain accounts on {directory.domain} sign in with their usual username, or as DOMAIN\user.</p>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputClass} autoComplete="current-password" required />
            </div>
            {error && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
            <button type="submit" disabled={submitting}
              className="mt-auto flex items-center justify-center gap-1.5 text-sm font-semibold px-3.5 py-2.5 bg-brand hover:bg-brand-dark text-white rounded-lg transition-colors disabled:opacity-40 cursor-pointer">
              <LogIn size={13} /> {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        </div>
      </div>
    </div>
  );
}
