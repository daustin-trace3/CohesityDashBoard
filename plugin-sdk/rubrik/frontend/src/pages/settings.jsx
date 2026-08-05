// v2.1.0 Settings page — cloned from host frontend/src/pages/SettingsPage.jsx
// layout (icon-chip header, pill tab bar, constrained-width card panels,
// status chips, host-styled buttons) with RSC / CDM connection CRUD
// preserved from v1.2.x. Chrome credential-autofill defenses applied to the
// identity/secret fields (see GlobalSearch.jsx for the proven pattern).
import { injectStyles, PageHeader, Badge, ServerIcon, GearIcon, ShieldIcon, RefreshIcon, PencilIcon, TrashIcon } from '../ui.jsx';

injectStyles();

const KIND_TABS = [
  { key: 'rsc', label: 'Rubrik Security Cloud', icon: ShieldIcon },
  { key: 'cdm', label: 'Local Cluster (CDM)', icon: ServerIcon },
];

// Session mutations must carry the host's CSRF token (middleware/csrf.js) or
// they come back as a bare 403 — surfaced here as "Save failed (403)".
const iccCsrf = () => (typeof window !== 'undefined' ? window.__ICC_CSRF_TOKEN__ : null);

const EMPTY_FORM = { name: '', endpoint: '', identity: '', secret: '' };

const KIND_COPY = {
  rsc: {
    title: 'Rubrik Security Cloud',
    desc: 'Connects to a Rubrik Security Cloud organization over its OAuth2 service-account API. Used to poll clusters, objects, jobs, SLA domains, and security signal across every CDM cluster registered to the org.',
  },
  cdm: {
    title: 'Local Cluster (CDM)',
    desc: 'Connects directly to an on-prem Rubrik CDM cluster over its local user/pass API. Use this when a cluster is not (or not yet) registered to Rubrik Security Cloud.',
  },
};

function inputBaseStyle() {
  return {
    width: '100%',
    background: 'var(--rbk-surface-overlay)',
    border: '1px solid var(--rbk-border)',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 13,
    color: 'var(--rbk-ink)',
    outline: 'none',
    boxSizing: 'border-box',
  };
}

/**
 * Text input hardened against Chrome's credential autofill: starts readOnly
 * (Chrome decides whether to offer autofill at focus time, so a field that's
 * still readOnly when focus lands gets skipped) and unlocks on focus; carries
 * autoComplete="one-time-code" (the one hint Chrome actually honors) and no
 * name attribute so saved-credential heuristics can't match it by field name.
 */
function GuardedInput({ style, onFocus, onBlur, ...props }) {
  const [locked, setLocked] = React.useState(true);
  const [focused, setFocused] = React.useState(false);
  return (
    <input
      {...props}
      autoComplete="one-time-code"
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      data-lpignore="true"
      data-1p-ignore="true"
      data-form-type="other"
      readOnly={locked}
      style={{
        ...inputBaseStyle(),
        ...(focused ? { borderColor: 'var(--rbk-brand)' } : {}),
        ...style,
      }}
      onFocus={(e) => {
        setLocked(false);
        setFocused(true);
        if (onFocus) onFocus(e);
      }}
      onBlur={(e) => {
        setLocked(true);
        setFocused(false);
        if (onBlur) onBlur(e);
      }}
    />
  );
}

function PlainInput({ style, ...props }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <input
      {...props}
      style={{ ...inputBaseStyle(), ...(focused ? { borderColor: 'var(--rbk-brand)' } : {}), ...style }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    />
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--rbk-ink-faint)', marginBottom: 4 }}>
        {label}
      </label>
      {children}
      {hint && <p style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', margin: '4px 0 0' }}>{hint}</p>}
    </div>
  );
}

const fieldGridStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 };

const btnAccentStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  fontWeight: 600,
  padding: '8px 14px',
  background: 'rgba(0,179,136,0.1)',
  border: '1px solid rgba(0,179,136,0.3)',
  color: 'var(--rbk-brand)',
  borderRadius: 8,
  cursor: 'pointer',
};

const btnGhostStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  fontWeight: 600,
  padding: '8px 14px',
  background: 'transparent',
  border: '1px solid var(--rbk-border)',
  color: 'var(--rbk-ink)',
  borderRadius: 8,
  cursor: 'pointer',
};

const iconBtnStyle = {
  fontSize: 11,
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 8,
  border: '1px solid var(--rbk-border)',
  background: 'transparent',
  color: 'var(--rbk-ink)',
  cursor: 'pointer',
  marginRight: 6,
};

function KindBadge({ kind }) {
  return <Badge tone={kind === 'rsc' ? 'brand' : 'info'}>{kind.toUpperCase()}</Badge>;
}

function StatusRow({ hasSecret }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, padding: '8px 12px', borderRadius: 8, background: 'var(--rbk-surface-overlay)', border: '1px solid var(--rbk-border)' }}>
      <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--rbk-ink-faint)' }}>Status</span>
      {hasSecret ? (
        <Badge tone="ok">Stored encrypted</Badge>
      ) : (
        <Badge tone="neutral">No credential stored</Badge>
      )}
    </div>
  );
}

// 28px square icon button, matching the host's AWS Registered Accounts row.
const squareBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 28,
  width: 28,
  borderRadius: 6,
  border: '1px solid var(--rbk-border)',
  background: 'transparent',
  color: 'var(--rbk-ink-muted)',
  cursor: 'pointer',
  padding: 0,
};

function fmtWhen(ts) {
  if (!ts) return 'Never';
  const d = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function ConnectionRow({ c, onEdit, onRemove, onTest, testing, result }) {
  // A just-run test wins over the stored one so the badge reacts immediately.
  const status = result ? (result.ok ? 'success' : 'error') : c.lastTestStatus;
  const error = result ? (result.ok ? null : result.error || 'unreachable') : c.lastTestError;
  return (
    <tr className="rbk-row">
      <td style={tdStyle}><KindBadge kind={c.kind} /></td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{c.name}</td>
      <td style={{ ...tdStyle, color: 'var(--rbk-ink-muted)' }}>{c.endpoint}</td>
      <td style={tdStyle}>{c.hasSecret ? <Badge tone="ok">Stored</Badge> : <Badge tone="neutral">None</Badge>}</td>
      <td style={tdStyle}>
        <Badge tone={status === 'error' ? 'crit' : status === 'success' ? 'ok' : 'neutral'}>
          {testing ? 'Testing…' : status === 'error' ? 'Error' : status === 'success' ? 'Up' : 'Pending'}
        </Badge>
        {status === 'error' && error && (
          <p style={{ fontSize: 10, color: 'var(--rbk-crit)', marginTop: 2, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={error}>{error}</p>
        )}
      </td>
      <td style={{ ...tdStyle, fontSize: 11, color: 'var(--rbk-ink-faint)', whiteSpace: 'nowrap' }}>
        {result ? 'just now' : fmtWhen(c.lastTestAt)}
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
          <button style={squareBtnStyle} onClick={() => onTest(c)} disabled={testing}
            title="Test connection" aria-label={`Test ${c.name}`}>
            <RefreshIcon size={13} />
          </button>
          <button style={squareBtnStyle} onClick={() => onEdit(c)}
            title="Edit connection / update credentials" aria-label={`Edit ${c.name}`}>
            <PencilIcon size={13} />
          </button>
          <button style={{ ...squareBtnStyle, color: 'var(--rbk-crit)', borderColor: 'rgba(248,113,113,0.4)' }}
            onClick={() => onRemove(c)} title="Remove" aria-label={`Remove ${c.name}`}>
            <TrashIcon size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
}

const thStyle = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  color: 'var(--rbk-ink-faint)',
  borderBottom: '1px solid var(--rbk-border)',
};

const tdStyle = {
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--rbk-ink)',
  borderBottom: '1px solid var(--rbk-border)',
};

export default function RbkSettingsPage() {
  const [kind, setKind] = React.useState('rsc');
  const [connections, setConnections] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [editingId, setEditingId] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [testResults, setTestResults] = React.useState({});
  const [testingId, setTestingId] = React.useState(null);

  const load = React.useCallback(() => {
    fetch('/api/rubrik/connections', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => setConnections(json))
      .catch((err) => setError(err.message));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const startEdit = (c) => {
    setKind(c.kind);
    setEditingId(c.id);
    setForm({ name: c.name, endpoint: c.endpoint, identity: c.identity || '', secret: '' });
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        kind,
        endpoint: form.endpoint.trim(),
        identity: form.identity.trim() || undefined,
      };
      if (form.secret) body.secret = form.secret;

      const url = editingId ? `/api/rubrik/connections/${editingId}` : '/api/rubrik/connections';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(iccCsrf() ? { 'x-csrf-token': iccCsrf() } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error === 'duplicate' ? 'A connection with that name already exists.' : `Save failed (${res.status})`);
      }
      resetForm();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`Remove connection "${c.name}"?`)) return;
    try {
      const res = await fetch(`/api/rubrik/connections/${c.id}`, { method: 'DELETE', credentials: 'include', headers: { ...(iccCsrf() ? { 'x-csrf-token': iccCsrf() } : {}) } });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const test = async (c) => {
    setTestingId(c.id);
    try {
      const res = await fetch('/api/rubrik/connections/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(iccCsrf() ? { 'x-csrf-token': iccCsrf() } : {}) },
        body: JSON.stringify({ id: c.id }),
      });
      const result = await res.json();
      setTestResults((r) => ({ ...r, [c.id]: result }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [c.id]: { ok: false, error: err.message } }));
    } finally {
      setTestingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.endpoint.trim();
  const editingHasSecret = editingId ? connections?.find((c) => c.id === editingId)?.hasSecret : false;
  const copy = KIND_COPY[kind];
  const ActiveIcon = KIND_TABS.find((t) => t.key === kind)?.icon;

  return (
    // The form column keeps the host's 768px settings width; the connections
    // table below is full-width because 7 columns and an endpoint URL do not
    // fit in 768 (the Actions column was being clipped).
    <div className="rbk-root">
      <div style={{ maxWidth: 768 }}>
      <PageHeader icon={GearIcon} title="Rubrik Settings" description="Rubrik-specific connections. Register a Rubrik Security Cloud organization or local CDM clusters to poll." />

      {error && <p style={{ color: 'var(--rbk-crit)', fontSize: 13, marginBottom: 12 }}>{error}</p>}

      {/* Section pill tabs */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--rbk-surface)', border: '1px solid var(--rbk-border)', borderRadius: 8, padding: 4, marginBottom: 16 }}>
        {KIND_TABS.map((t) => {
          const Icon = t.icon;
          const active = kind === t.key;
          return (
            <button
              key={t.key}
              onClick={() => {
                setKind(t.key);
                if (!editingId) setForm(EMPTY_FORM);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                cursor: 'pointer',
                border: 'none',
                background: active ? 'var(--rbk-surface-overlay)' : 'transparent',
                color: active ? 'var(--rbk-ink)' : 'var(--rbk-ink-muted)',
              }}
            >
              <Icon size={13} style={{ color: active ? 'var(--rbk-brand)' : undefined }} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Connection card */}
      <div className="rbk-panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 4 }}>
          <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(0,179,136,0.1)', border: '1px solid rgba(0,179,136,0.2)', flexShrink: 0 }}>
            {ActiveIcon && <ActiveIcon size={14} style={{ color: 'var(--rbk-brand)' }} />}
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--rbk-ink)', margin: 0 }}>{copy.title}</p>
            <p style={{ fontSize: 11, color: 'var(--rbk-ink-muted)', margin: '2px 0 0', maxWidth: 620, lineHeight: 1.5 }}>{copy.desc}</p>
          </div>
        </div>

        {editingId && <div style={{ marginTop: 14 }}><StatusRow hasSecret={editingHasSecret} /></div>}

        <div style={{ marginTop: 14 }}>
          {kind === 'rsc' ? (
            <div style={fieldGridStyle}>
              <Field label="RSC URL">
                <PlainInput value={form.endpoint} onChange={setField('endpoint')} placeholder="https://<org>.my.rubrik.com" />
              </Field>
              <Field label="Client ID">
                <GuardedInput value={form.identity} onChange={setField('identity')} placeholder="Service account client ID" />
              </Field>
              <Field
                label="Client Secret"
                hint={editingId ? 'Stored AES-256-GCM encrypted — never displayed again. Leave blank to keep the current secret.' : 'Stored AES-256-GCM encrypted — never displayed again.'}
              >
                <GuardedInput
                  type="password"
                  value={form.secret}
                  onChange={setField('secret')}
                  placeholder={editingId ? '•••••••• (stored — leave blank to keep)' : ''}
                  style={{ fontFamily: 'monospace' }}
                />
              </Field>
              <Field label="Connection Name">
                <PlainInput value={form.name} onChange={setField('name')} placeholder="e.g. rbk-prd-rsc" />
              </Field>
            </div>
          ) : (
            <div style={fieldGridStyle}>
              <Field label="Cluster Address">
                <PlainInput value={form.endpoint} onChange={setField('endpoint')} placeholder="https://rbk-cluster.corp.local" />
              </Field>
              <Field label="Username">
                <GuardedInput value={form.identity} onChange={setField('identity')} placeholder="admin" />
              </Field>
              <Field
                label="Password"
                hint={editingId ? 'Stored AES-256-GCM encrypted — never displayed again. Leave blank to keep the current password.' : 'Stored AES-256-GCM encrypted — never displayed again.'}
              >
                <GuardedInput
                  type="password"
                  value={form.secret}
                  onChange={setField('secret')}
                  placeholder={editingId ? '•••••••• (stored — leave blank to keep)' : ''}
                  style={{ fontFamily: 'monospace' }}
                />
              </Field>
              <Field label="Connection Name">
                <PlainInput value={form.name} onChange={setField('name')} placeholder="e.g. rbk-prd-cdm" />
              </Field>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button style={{ ...btnAccentStyle, opacity: saving || !canSubmit ? 0.5 : 1, cursor: saving || !canSubmit ? 'default' : 'pointer' }} onClick={submit} disabled={saving || !canSubmit}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add connection'}
            </button>
            {editingId && (
              <button style={btnGhostStyle} onClick={resetForm}>Cancel</button>
            )}
          </div>

          <p style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginTop: 14, marginBottom: 0 }}>
            Demo build ships with seeded data. Registered connections are stored (secrets encrypted) and used once live polling is enabled.
          </p>
        </div>
      </div>

      </div>

      {/* Registered connections — full width, and scrolls rather than clips
          on a narrow viewport. */}
      {connections && (
        <div className="rbk-panel" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px 0' }}>
            <p className="rbk-panel-title" style={{ margin: 0 }}>Registered Connections</p>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Endpoint</th>
                <th style={thStyle}>Credentials</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Last Test</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {connections.length === 0 && (
                <tr>
                  <td style={{ ...tdStyle, color: 'var(--rbk-ink-muted)' }} colSpan={7}>
                    No connections registered yet.
                  </td>
                </tr>
              )}
              {connections.map((c) => (
                <ConnectionRow
                  key={c.id}
                  c={c}
                  onEdit={startEdit}
                  onRemove={remove}
                  onTest={test}
                  testing={testingId === c.id}
                  result={testResults[c.id]}
                />
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
