// NetBackup Privacy Inspector — the host's shared PrivacyInspectorPage
// component isn't importable from a plugin bundle, so this ports a minimal
// equivalent hitting the same GET /api/ai-audit?platform=netbackup and
// GET /api/ai-audit/:id routes the host component uses. Note: these routes
// are mounted at the host's /api root (not /api/netbackup), same as the
// host original — deliberate, not a deviation.
import { injectStyles, PageHeader, RefreshIcon, ShieldIcon, SendIcon, KeyRoundIcon } from '../ui.jsx';

injectStyles();

const TOKEN_RE = /(\b(?:CLUSTER|JOB|POLICY|SOURCE|HOST|IP|VIEW|USER|MAC|OBJECT|SERIAL|TAG)-\d+\b)/g;

function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function Highlighted({ text }) {
  const parts = String(text || '').split(TOKEN_RE);
  return parts.map((p, i) => (i % 2 === 1
    ? <mark key={i} style={{ background: 'rgba(177,24,30,0.2)', color: 'var(--nb-brand)', borderRadius: 3, padding: '0 2px', fontWeight: 600 }}>{p}</mark>
    : <span key={i}>{p}</span>));
}

function apiGetHost(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

export default function NbPrivacyPage() {
  const [exchanges, setExchanges] = React.useState(null);
  const [retentionDays, setRetentionDays] = React.useState(30);
  const [selected, setSelected] = React.useState(null);
  const [error, setError] = React.useState(null);

  const loadList = React.useCallback(async () => {
    try {
      const data = await apiGetHost('/ai-audit', { platform: 'netbackup' });
      setExchanges(data.exchanges);
      if (data.retentionDays) setRetentionDays(data.retentionDays);
      if (data.exchanges.length > 0) {
        const detail = await apiGetHost(`/ai-audit/${data.exchanges[0].id}`);
        setSelected(detail);
      } else {
        setSelected(null);
      }
    } catch {
      setError('Failed to load the AI audit trail.');
    }
  }, []);

  React.useEffect(() => { loadList(); }, [loadList]);

  const select = async (id) => {
    if (selected?.id === id) return;
    try {
      const data = await apiGetHost(`/ai-audit/${id}`);
      setSelected(data);
    } catch {
      setError('Failed to load that exchange.');
    }
  };

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={ShieldIcon} title="Privacy Inspector"
        description={`Proof of anonymization — the exact payload each AI request sent vs. the name mapping that never left this server. Entries are retained for ${retentionDays} days.`}>
        <button onClick={loadList} className="nb-btn-ghost">
          <RefreshIcon size={13} /> Refresh
        </button>
      </PageHeader>

      <div className="nb-panel" style={{ display: 'flex', overflow: 'hidden', minHeight: 480 }}>
        <div className="nb-scroll" style={{ width: 260, borderRight: '1px solid var(--nb-border)', overflowY: 'auto', flexShrink: 0, maxHeight: '75vh' }}>
          {exchanges === null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: 'var(--nb-ink-muted)', fontSize: 12 }}>
              <RefreshIcon size={13} style={{ animation: 'nb-spin 0.8s linear infinite' }} /> Loading…
            </div>
          ) : exchanges.length === 0 ? (
            <p style={{ padding: 16, fontSize: 12, color: 'var(--nb-ink-muted)', lineHeight: 1.5 }}>
              No AI requests recorded for this platform in the last {retentionDays} days. Run any AI report, then refresh this page.
            </p>
          ) : exchanges.map((ex) => (
            <button key={ex.id} onClick={() => select(ex.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px', borderBottom: '1px solid var(--nb-border)',
                background: selected?.id === ex.id ? 'rgba(177,24,30,0.1)' : 'transparent', border: 'none', borderBottomWidth: 1, borderBottomStyle: 'solid', cursor: 'pointer',
              }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ex.feature}</p>
              <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ex.label}</p>
              <p style={{ fontSize: 10, color: 'var(--nb-ink-faint)', margin: '2px 0 0' }}>{fmtTime(ex.sentAt)} · {ex.mappedCount} names masked</p>
            </button>
          ))}
        </div>

        <div className="nb-scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minWidth: 0, maxHeight: '75vh' }}>
          {error && <p style={{ color: 'var(--nb-crit)', fontSize: 12, marginBottom: 12 }}>{error}</p>}
          {!selected ? (
            exchanges?.length > 0 && <p style={{ color: 'var(--nb-ink-muted)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>Select an exchange.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--nb-ink-muted)', background: 'rgba(177,24,30,0.05)', border: '1px solid rgba(177,24,30,0.2)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.6 }}>
                Everything under <span style={{ fontWeight: 600, color: 'var(--nb-ink)' }}>"Sent to the AI"</span> is the verbatim payload transmitted to{' '}
                <span style={{ color: 'var(--nb-brand)' }}>{selected.model}</span>. Highlighted tokens like{' '}
                <mark style={{ background: 'rgba(177,24,30,0.2)', color: 'var(--nb-brand)', borderRadius: 3, padding: '0 2px', fontWeight: 600 }}>CLUSTER-1</mark> replaced every server, share, policy,
                hostname, and IP before the request left this machine. The mapping table below stays on this server and is applied to the AI's response locally.
              </div>

              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--nb-ink)', marginBottom: 6 }}>
                  <SendIcon size={13} style={{ color: 'var(--nb-brand)' }} /> Sent to the AI (anonymized) · {fmtTime(selected.sentAt)}
                </p>
                {selected.messages.map((m, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--nb-ink-faint)', marginBottom: 2 }}>{m.role}</p>
                    <pre style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--nb-ink-muted)', background: 'var(--nb-surface-base)', border: '1px solid var(--nb-border)', borderRadius: 8, padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflowY: 'auto' }}>
                      <Highlighted text={m.content} />
                    </pre>
                  </div>
                ))}
              </div>

              <div>
                <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--nb-ink)', marginBottom: 6 }}>
                  <KeyRoundIcon size={13} style={{ color: 'var(--nb-brand)' }} /> Local token map — never sent ({selected.mappings.length})
                </p>
                {selected.mappings.length === 0 ? (
                  <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)' }}>No identifiable names were present in this payload.</p>
                ) : (
                  <div style={{ border: '1px solid var(--nb-border)', borderRadius: 8, maxHeight: 256, overflowY: 'auto' }}>
                    <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                      <thead style={{ position: 'sticky', top: 0, background: 'var(--nb-surface)' }}>
                        <tr style={{ textAlign: 'left', color: 'var(--nb-ink-faint)', borderBottom: '1px solid var(--nb-border)' }}>
                          <th style={{ padding: '6px 12px', fontWeight: 600, width: 144 }}>Token (sent)</th>
                          <th style={{ padding: '6px 12px', fontWeight: 600 }}>Real name (stayed local)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.mappings.map((m) => (
                          <tr key={m.token} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                            <td style={{ padding: '4px 12px' }}><mark style={{ background: 'rgba(177,24,30,0.2)', color: 'var(--nb-brand)', borderRadius: 3, padding: '0 2px', fontWeight: 600 }}>{m.token}</mark></td>
                            <td style={{ padding: '4px 12px', color: 'var(--nb-ink)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{m.real}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {selected.response && (
                <details>
                  <summary style={{ fontSize: 12, fontWeight: 700, color: 'var(--nb-ink)', cursor: 'pointer' }}>Raw AI response, as received (still tokenized)</summary>
                  <pre style={{ marginTop: 6, fontSize: 11, lineHeight: 1.6, color: 'var(--nb-ink-muted)', background: 'var(--nb-surface-base)', border: '1px solid var(--nb-border)', borderRadius: 8, padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 280, overflowY: 'auto' }}>
                    <Highlighted text={selected.response} />
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
