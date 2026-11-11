import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../auth/AuthContext';

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

/**
 * Voluntary password change for local accounts, opened from the header user menu.
 */
export default function ChangePasswordPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = location.state?.returnTo || '/';
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate('/login?returnTo=%2Fchange-password', { replace: true });
  }, [loading, user, navigate]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) return setError('The new password must be at least 8 characters.');
    if (newPassword !== confirm) return setError('The new password and its confirmation do not match.');
    if (newPassword === currentPassword) return setError('The new password must differ from the current one.');
    setSubmitting(true);
    try {
      await client.post('/auth/change-password', { currentPassword, newPassword });
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not change the password. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-screen overflow-auto flex items-center justify-center bg-cohesity-black px-4">
      <form onSubmit={submit} className="w-full max-w-md bg-surface border border-cohesity-border rounded-xl p-6 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <KeyRound size={22} className="text-brand" />
          <div>
            <p className="text-lg font-bold text-ink">Choose a new password</p>
            <p className="text-xs text-ink-muted">
              {user ? `Signed in as ${user.username}. ` : ''}Enter your current password, then a new one.
            </p>
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block" htmlFor="cp-current">Current password</label>
          <input id="cp-current" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputClass} required />
        </div>
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block" htmlFor="cp-new">New password</label>
          <input id="cp-new" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputClass} minLength={8} required />
        </div>
        <div>
          <label className="text-xs font-semibold text-ink mb-1 block" htmlFor="cp-confirm">Confirm new password</label>
          <input id="cp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} minLength={8} required />
        </div>
        {error && <p role="alert" className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{error}</p>}
        <button type="submit" disabled={submitting}
          className="text-sm font-medium px-4 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
          {submitting ? 'Saving...' : 'Change password'}
        </button>
        <button type="button" onClick={() => navigate(returnTo)}
          className="text-sm font-medium px-4 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
          Cancel
        </button>
      </form>
    </div>
  );
}
