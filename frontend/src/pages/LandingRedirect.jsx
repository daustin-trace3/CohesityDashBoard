import { Navigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Where a sign-in lands when nothing asked for a page: the Ops Monitor for a
// caller who can see every platform, otherwise the first platform the caller
// holds a view grant on (rail order). Waits until the session and the
// enabled-platform list are known, or a Cohesity-only default would win the
// race (Doug, 2026-11-10).
export default function LandingRedirect() {
  const { hasPermission, loading } = useAuth();
  const ctx = useOutletContext() || {};
  const { visiblePlatforms = [], platformsLoaded = false } = ctx;
  if (loading || !platformsLoaded) return null;
  if (hasPermission('*:*:view')) return <Navigate to="/ops" replace />;
  const first = visiblePlatforms.find((p) => p.id !== 'ops');
  return <Navigate to={first ? `/${first.id}` : '/ops'} replace />;
}
