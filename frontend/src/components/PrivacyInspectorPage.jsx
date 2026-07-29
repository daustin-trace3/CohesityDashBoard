import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, RefreshCw, Send, KeyRound } from 'lucide-react';
import client from '../api/client';
import { PageHeader } from './ui/primitives';

const TOKEN_RE = /(\b(?:CLUSTER|JOB|POLICY|SOURCE|HOST|IP|VIEW|USER|MAC|OBJECT|SERIAL|TAG)-\d+\b)/g;

function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

/** Render text with anonymization tokens highlighted. */
function Highlighted({ text }) {
  const parts = String(text || '').split(TOKEN_RE);
  return parts.map((p, i) =>
    i % 2 === 1
      ? <mark key={i} className="bg-brand/20 text-brand rounded px-0.5 font-semibold">{p}</mark>
      : <span key={i}>{p}</span>
  );
}

/**
 * Per-platform AI Privacy Inspector page — the audit trail of every AI request
 * this platform sent (anonymized payload) vs. the token map that stayed local.
 */
export default function PrivacyInspectorPage({ platform }) {
  const [exchanges, setExchanges] = useState(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [selected, setSelected] = useState(null); // full exchange detail
  const [error, setError] = useState(null);

  const loadList = useCallback(async () => {
    try {
      const { data } = await client.get('/ai-audit', { params: { platform } });
      setExchanges(data.exchanges);
      if (data.retentionDays) setRetentionDays(data.retentionDays);
      if (data.exchanges.length > 0) {
        const { data: detail } = await client.get(`/ai-audit/${data.exchanges[0].id}`);
        setSelected(detail);
      } else {
        setSelected(null);
      }
    } catch {
      setError('Failed to load the AI audit trail.');
    }
  }, [platform]);

  useEffect(() => { loadList(); }, [loadList]);

  const select = async (id) => {
    if (selected?.id === id) return;
    try {
      const { data } = await client.get(`/ai-audit/${id}`);
      setSelected(data);
    } catch {
      setError('Failed to load that exchange.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={ShieldCheck}
        title="Privacy Inspector"
        description={`Proof of anonymization — the exact payload each AI request sent vs. the name mapping that never left this server. Entries are retained for ${retentionDays} days.`}
      >
        <button
          onClick={loadList}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink rounded-lg hover:border-brand/50 hover:text-brand transition-colors cursor-pointer"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </PageHeader>

      <div className="panel flex overflow-hidden min-h-[480px]">
        {/* Exchange list */}
        <div className="w-64 border-r border-cohesity-border overflow-y-auto flex-shrink-0 max-h-[75vh]">
          {exchanges === null ? (
            <div className="flex items-center gap-2 p-4 text-ink-muted text-xs"><RefreshCw size={13} className="animate-spin" /> Loading…</div>
          ) : exchanges.length === 0 ? (
            <p className="p-4 text-xs text-ink-muted leading-relaxed">
              No AI requests recorded for this platform in the last {retentionDays} days. Run any AI report, then refresh this page.
            </p>
          ) : exchanges.map((ex) => (
            <button
              key={ex.id}
              onClick={() => select(ex.id)}
              className={`w-full text-left px-4 py-3 border-b border-cohesity-border/60 hover:bg-brand/5 transition-colors cursor-pointer ${selected?.id === ex.id ? 'bg-brand/10' : ''}`}
            >
              <p className="text-xs font-semibold text-ink truncate">{ex.feature}</p>
              <p className="text-[11px] text-ink-muted truncate">{ex.label}</p>
              <p className="text-[10px] text-ink-faint mt-0.5">{fmtTime(ex.sentAt)} · {ex.mappedCount} names masked</p>
            </button>
          ))}
        </div>

        {/* Detail */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-w-0 max-h-[75vh]">
          {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
          {!selected ? (
            exchanges?.length > 0 && <p className="text-ink-muted text-xs py-10 text-center">Select an exchange.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="text-[11px] text-ink-muted bg-brand/5 border border-brand/20 rounded-md px-3 py-2 leading-relaxed">
                Everything under <span className="font-semibold text-ink">"Sent to the AI"</span> is the verbatim payload transmitted to{' '}
                <span className="text-brand">{selected.model}</span>. Highlighted tokens like{' '}
                <mark className="bg-brand/20 text-brand rounded px-0.5 font-semibold">CLUSTER-1</mark> replaced every server, share, policy,
                hostname, and IP before the request left this machine. The mapping table below stays on this server and is
                applied to the AI's response locally.
              </div>

              {/* Sent payload */}
              <div>
                <p className="flex items-center gap-1.5 text-xs font-bold text-ink mb-1.5">
                  <Send size={13} className="text-brand" /> Sent to the AI (anonymized) · {fmtTime(selected.sentAt)}
                </p>
                {selected.messages.map((m, i) => (
                  <div key={i} className="mb-2">
                    <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">{m.role}</p>
                    <pre className="text-[11px] leading-relaxed text-ink-muted bg-cohesity-black/60 border border-cohesity-border rounded-md p-3 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                      <Highlighted text={m.content} />
                    </pre>
                  </div>
                ))}
              </div>

              {/* Local mapping */}
              <div>
                <p className="flex items-center gap-1.5 text-xs font-bold text-ink mb-1.5">
                  <KeyRound size={13} className="text-brand" /> Local token map — never sent ({selected.mappings.length})
                </p>
                {selected.mappings.length === 0 ? (
                  <p className="text-[11px] text-ink-muted">No identifiable names were present in this payload.</p>
                ) : (
                  <div className="border border-cohesity-border rounded-md max-h-64 overflow-y-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-cohesity-gray">
                        <tr className="text-left text-ink-faint border-b border-cohesity-border">
                          <th className="px-3 py-1.5 font-semibold w-36">Token (sent)</th>
                          <th className="px-3 py-1.5 font-semibold">Real name (stayed local)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.mappings.map((m) => (
                          <tr key={m.token} className="border-b border-cohesity-border/40 last:border-0">
                            <td className="px-3 py-1">
                              <mark className="bg-brand/20 text-brand rounded px-0.5 font-semibold">{m.token}</mark>
                            </td>
                            <td className="px-3 py-1 text-ink font-mono break-all">{m.real}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Raw response */}
              {selected.response && (
                <details>
                  <summary className="text-xs font-bold text-ink cursor-pointer hover:text-brand transition-colors">
                    Raw AI response, as received (still tokenized)
                  </summary>
                  <pre className="mt-1.5 text-[11px] leading-relaxed text-ink-muted bg-cohesity-black/60 border border-cohesity-border rounded-md p-3 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
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
