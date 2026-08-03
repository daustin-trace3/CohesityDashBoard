// v1.2.0/v1.2.1 Settings page — RSC / CDM connection registration. Moved
// verbatim as part of the v2.0.0 file restructure.
import { ACCENT, PANEL_BG, BORDER, TEXT, MUTED, RED, thStyle, tdStyle, panelStyle } from './_shared';

const INPUT_BG = '#1b1b1b';
const DARK_TEXT = '#0B1015';

const KIND_TABS = [
  { key: 'rsc', label: 'Rubrik Security Cloud' },
  { key: 'cdm', label: 'Local Cluster (CDM)' },
];

const EMPTY_FORM = { name: '', endpoint: '', identity: '', secret: '' };

function settingsPanelStyle(extra) {
  return {
    ...panelStyle(extra),
    borderRadius: 12,
    borderTop: `3px solid ${ACCENT}`,
  };
}

const segmentedWrapStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: '#1a1a1a',
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: 4,
  marginBottom: 16,
};

function segmentedButtonStyle(active) {
  return {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    cursor: 'pointer',
    border: 'none',
    background: active ? PANEL_BG : 'transparent',
    color: active ? ACCENT : MUTED,
  };
}

const buttonStyle = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  cursor: 'pointer',
  border: `1px solid ${ACCENT}`,
  background: ACCENT,
  color: DARK_TEXT,
};

const secondaryButtonStyle = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  cursor: 'pointer',
  border: `1px solid ${BORDER}`,
  background: PANEL_BG,
  color: TEXT,
};

const iconButtonStyle = {
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 8,
  cursor: 'pointer',
  border: `1px solid ${BORDER}`,
  background: PANEL_BG,
  color: TEXT,
  marginRight: 6,
};

const fieldLabelStyle = { display: 'block', fontSize: 11, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.03em' };

const inputStyle = {
  width: '100%',
  background: INPUT_BG,
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 13,
  color: TEXT,
  boxSizing: 'border-box',
};

function TextInput({ style, onFocus, onBlur, ...props }) {
  const [focused, setFocused] = React.useState(false);
  return (
    <input
      {...props}
      style={{ ...inputStyle, ...(focused ? { borderColor: ACCENT } : {}), ...style }}
      onFocus={(e) => {
        setFocused(true);
        if (onFocus) onFocus(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        if (onBlur) onBlur(e);
      }}
    />
  );
}

function SettingsField({ label, children }) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      {children}
    </div>
  );
}

const fieldGridStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 };

function ConnectionRow({ c, onEdit, onRemove, onTest, testing, result }) {
  const [hover, setHover] = React.useState(false);
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? '#2a2a2a' : 'transparent' }}
    >
      <td style={tdStyle}>
        <KindBadge kind={c.kind} />
      </td>
      <td style={tdStyle}>{c.name}</td>
      <td style={tdStyle}>{c.endpoint}</td>
      <td style={{ ...tdStyle, color: MUTED }}>{c.identity || '—'}</td>
      <td style={tdStyle}>
        <SecretChip hasSecret={c.hasSecret} />
      </td>
      <td style={tdStyle}>
        <button style={iconButtonStyle} onClick={() => onTest(c)} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        {result && (
          <span style={{ fontSize: 11, color: result.ok ? ACCENT : RED }}>
            {result.ok ? `reachable (${result.statusCode})` : result.error || 'unreachable'}
          </span>
        )}
      </td>
      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
        <button style={iconButtonStyle} onClick={() => onEdit(c)}>
          Edit
        </button>
        <button style={{ ...iconButtonStyle, marginRight: 0, color: RED, borderColor: RED }} onClick={() => onRemove(c)}>
          Delete
        </button>
      </td>
    </tr>
  );
}

function SecretChip({ hasSecret }) {
  const color = hasSecret ? ACCENT : MUTED;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: `${color}26`,
        color,
        border: `1px solid ${color}`,
      }}
    >
      {hasSecret ? 'stored' : 'none'}
    </span>
  );
}

function KindBadge({ kind }) {
  const color = kind === 'rsc' ? ACCENT : '#60a5fa';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: `${color}26`,
        color,
        border: `1px solid ${color}`,
      }}
    >
      {kind.toUpperCase()}
    </span>
  );
}

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
        headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`/api/rubrik/connections/${c.id}`, { method: 'DELETE', credentials: 'include' });
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
        headers: { 'Content-Type': 'application/json' },
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

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', color: TEXT, background: 'transparent' }}>
      <div style={{ maxWidth: '48rem', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              background: `${ACCENT}1a`,
              border: `1px solid ${ACCENT}33`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              marginTop: 1,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M4 12h3M17 12h3M12 4v3M12 17v3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" />
            </svg>
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, color: TEXT, margin: 0, lineHeight: 1.2 }}>Rubrik Settings</h1>
            <p style={{ fontSize: 12, color: MUTED, margin: '2px 0 0' }}>
              Register a Rubrik Security Cloud instance or local CDM clusters
            </p>
          </div>
        </div>

        {error && <p style={{ color: RED, fontSize: 13 }}>{error}</p>}

        <div style={settingsPanelStyle({ marginBottom: 16 })}>
          <div style={segmentedWrapStyle}>
            {KIND_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setKind(t.key);
                  if (!editingId) setForm(EMPTY_FORM);
                }}
                style={segmentedButtonStyle(kind === t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {kind === 'rsc' ? (
            <div style={fieldGridStyle}>
              <SettingsField label="RSC URL">
                <TextInput
                  value={form.endpoint}
                  onChange={setField('endpoint')}
                  placeholder="https://<org>.my.rubrik.com"
                />
              </SettingsField>
              <SettingsField label="Client ID">
                <TextInput value={form.identity} onChange={setField('identity')} placeholder="Service account client ID" />
              </SettingsField>
              <SettingsField label="Client Secret">
                <TextInput
                  type="password"
                  value={form.secret}
                  onChange={setField('secret')}
                  placeholder="leave blank to keep current"
                />
              </SettingsField>
              <SettingsField label="Connection Name">
                <TextInput value={form.name} onChange={setField('name')} placeholder="e.g. rbk-prd-rsc" />
              </SettingsField>
            </div>
          ) : (
            <div style={fieldGridStyle}>
              <SettingsField label="Cluster Address">
                <TextInput value={form.endpoint} onChange={setField('endpoint')} placeholder="https://rbk-cluster.corp.local" />
              </SettingsField>
              <SettingsField label="Username">
                <TextInput value={form.identity} onChange={setField('identity')} placeholder="admin" />
              </SettingsField>
              <SettingsField label="Password">
                <TextInput
                  type="password"
                  value={form.secret}
                  onChange={setField('secret')}
                  placeholder="leave blank to keep current"
                />
              </SettingsField>
              <SettingsField label="Connection Name">
                <TextInput value={form.name} onChange={setField('name')} placeholder="e.g. rbk-prd-cdm" />
              </SettingsField>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...buttonStyle, opacity: saving || !canSubmit ? 0.5 : 1 }} onClick={submit} disabled={saving || !canSubmit}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add connection'}
            </button>
            {editingId && (
              <button style={secondaryButtonStyle} onClick={resetForm}>
                Cancel
              </button>
            )}
          </div>

          <p style={{ fontSize: 12, color: MUTED, marginTop: 14, marginBottom: 0 }}>
            Demo build ships with seeded data. Registered connections are stored (secrets encrypted) and used once live polling is
            enabled.
          </p>
        </div>

        {connections && (
          <div style={settingsPanelStyle({ padding: 0, overflow: 'hidden' })}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Kind</th>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Endpoint</th>
                  <th style={thStyle}>Identity</th>
                  <th style={thStyle}>Secret</th>
                  <th style={thStyle}>Test</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {connections.length === 0 && (
                  <tr>
                    <td style={{ ...tdStyle, color: MUTED }} colSpan={7}>
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
        )}
      </div>
    </div>
  );
}
