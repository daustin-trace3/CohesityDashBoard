import { Link } from 'react-router-dom';
import { Panel, Badge } from '../../../components/ui/primitives';
import { CAP_LABELS } from './shared';

const TONE = { ok: 'ok', denied: 'crit', not_enabled: 'warn', error: 'crit', unknown: 'neutral' };
const STATUS_TEXT = { ok: 'ok', denied: 'denied', not_enabled: 'not enabled', error: 'error', unknown: 'unknown' };

export const SETTINGS_LINK = '/aws/settings?section=finops';

function tip(c) {
  const parts = [`${CAP_LABELS[c.capability] || c.capability}: ${STATUS_TEXT[c.status] || c.status || 'unknown'}`];
  const actions = c.iamActions || [];
  if (c.status === 'denied' && actions.length) parts.push(`IAM: ${actions.join(', ')}`);
  if (c.error) parts.push(c.error);
  if (c.requests != null) parts.push(`${c.requests} request(s)`);
  return parts.join('\n');
}

/** One chip per capability; denied chips name the IAM action in the tooltip. */
export default function CapabilityStrip({ capabilities = [] }) {
  const rows = Array.isArray(capabilities) ? capabilities : [];
  if (rows.length === 0) return null;
  const bad = rows.filter((c) => c.status && c.status !== 'ok' && c.status !== 'unknown').length;
  return (
    <Panel title="Data sources" className="mb-4"
      actions={<Link to={SETTINGS_LINK} className="text-[11px] text-brand hover:underline">{bad ? 'Fix in Settings' : 'Settings'}</Link>}>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((c) => (
          <span key={c.capability} title={tip(c)}>
            <Badge tone={TONE[c.status] || 'neutral'}>{CAP_LABELS[c.capability] || c.capability}{c.status && c.status !== 'ok' ? `: ${STATUS_TEXT[c.status] || c.status}` : ''}</Badge>
          </span>
        ))}
      </div>
    </Panel>
  );
}

/** Inline notice for pages whose data needs a capability that is denied or not enabled. */
export function CapabilityNotice({ caps = [] }) {
  if (!caps.length) return null;
  return (
    <div className="panel p-3 mb-4 border border-status-warn/40 text-xs text-ink-muted">
      <p className="text-ink font-semibold mb-1">Some Cost Explorer data is not available yet</p>
      <ul className="list-disc pl-5 space-y-0.5">
        {caps.map((c) => (
          <li key={c.capability}>
            {CAP_LABELS[c.capability] || c.capability}: {STATUS_TEXT[c.status] || c.status}
            {c.status === 'denied' && (c.iamActions || []).length > 0 && <span className="text-ink-faint"> (needs {(c.iamActions || []).join(', ')})</span>}
            {c.status !== 'denied' && c.error && <span className="text-ink-faint"> ({String(c.error).slice(0, 160)})</span>}
          </li>
        ))}
      </ul>
      <Link to={SETTINGS_LINK} className="text-brand hover:underline mt-1.5 inline-block">Open FinOps settings</Link>
    </div>
  );
}
