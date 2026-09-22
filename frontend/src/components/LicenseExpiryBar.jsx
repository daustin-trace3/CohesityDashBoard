import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import client from '../api/client';

/**
 * A bar every user of the tenant sees when its licence is close to expiry:
 * yellow from 90 days out, red from 30 days out and during grace
 * (docs/MULTI-TENANT-DESIGN.md, decision 15). Nothing renders otherwise.
 */
export default function LicenseExpiryBar() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => client.get('/license/status').then((r) => { if (alive) setStatus(r.data); }).catch(() => {});
    load();
    const t = setInterval(load, 30 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!status) return null;
  const grace = status.state === 'grace';
  const days = status.daysLeft;
  if (!grace && (status.state !== 'valid' || days == null || days > 90)) return null;

  const red = grace || days <= 30;
  const text = grace
    ? `The license expired on ${status.effectiveExpiry}. ${status.graceDaysLeft} day${status.graceDaysLeft === 1 ? '' : 's'} of grace left before pages lock.`
    : `The license expires in ${days} day${days === 1 ? '' : 's'} (${status.effectiveExpiry}).`;

  return (
    <div
      role="status"
      className={`flex items-center gap-2 px-4 py-1.5 text-xs border-b ${red ? 'bg-status-crit/10 border-status-crit/30 text-status-crit' : 'bg-status-warn/10 border-status-warn/30 text-status-warn'}`}
    >
      <KeyRound size={13} className="shrink-0" />
      <span>{text}</span>
      <Link to="/admin/license" className="underline underline-offset-2 ml-1">Renew</Link>
    </div>
  );
}
