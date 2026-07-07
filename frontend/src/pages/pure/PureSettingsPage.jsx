import { useEffect, useState, useCallback } from 'react';
import { Settings, RefreshCw, Save, Clock, HardDrive, Play } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, Badge } from '../../components/ui/primitives';
import { BRAND } from './helpers';

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 1440;

export default function PureSettingsPage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [intervals, setIntervals] = useState({}); // id -> string value being edited
  const [savingId, setSavingId] = useState(null);
  const [pollingId, setPollingId] = useState(null);

  const load = useCallback(() => {
    return client
      .get('/pure/arrays')
      .then(({ data }) => {
        setArrays(data);
        setIntervals(Object.fromEntries(data.map((a) => [a.id, String(a.polling_interval_minutes ?? 15)])));
      })
      .catch(() => {
        setArrays([]);
        toast({ type: 'error', title: 'Failed to load Pure arrays' });
      });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const save = async (array) => {
    const raw = Number(intervals[array.id]);
    if (!Number.isFinite(raw) || raw < MIN_INTERVAL || raw > MAX_INTERVAL) {
      toast({ type: 'error', title: 'Invalid interval', message: `Enter a value between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes.` });
      return;
    }
    setSavingId(array.id);
    try {
      // Re-send the array's existing fields; secrets left blank are preserved server-side.
      await client.put(`/pure/arrays/${array.id}`, {
        name: array.name,
        mgmt_host: array.mgmt_host,
        auth_method: array.auth_method || 'client',
        client_id: array.client_id || '',
        key_id: array.key_id || '',
        username: array.username || '',
        issuer: array.issuer || '',
        ssl_verify: !!array.ssl_verify,
        polling_interval_minutes: raw,
      });
      toast({ type: 'success', title: 'Polling interval updated', message: `${array.name} now polls every ${raw} min.` });
      load();
    } catch (err) {
      const msg = err?.response?.data?.error || 'Could not update the array.';
      toast({ type: 'error', title: 'Update failed', message: msg });
    } finally {
      setSavingId(null);
    }
  };

  const pollNow = async (array) => {
    setPollingId(array.id);
    try {
      await client.post(`/pure/arrays/${array.id}/poll`);
      toast({ type: 'success', title: 'Poll triggered', message: `Collecting fresh data from ${array.name}.` });
    } catch (err) {
      const msg = err?.response?.data?.error || 'Poll failed.';
      toast({ type: 'error', title: 'Poll failed', message: msg });
    } finally {
      setPollingId(null);
    }
  };

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="Pure Settings" description="Configure polling and connection details for each FlashArray">
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      {arrays == null ? (
        <LoadingPanel label="Loading Pure arrays…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No Pure arrays registered yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {arrays.map((a) => {
            const edited = String(a.polling_interval_minutes ?? 15) !== String(intervals[a.id] ?? '');
            return (
              <div key={a.id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border flex-shrink-0" style={{ backgroundColor: `${BRAND}15`, borderColor: `${BRAND}40` }}>
                      <HardDrive size={16} style={{ color: BRAND }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-ink truncate">{a.name}</p>
                      <p className="text-[11px] text-ink-faint truncate">{a.mgmt_host}</p>
                    </div>
                  </div>
                  <Badge tone="neutral">{a.auth_method === 'token' ? 'API token' : 'API client'}</Badge>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label htmlFor={`interval-${a.id}`} className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
                      <Clock size={11} className="inline mr-1 -mt-0.5" />Polling interval (minutes)
                    </label>
                    <input
                      id={`interval-${a.id}`}
                      type="number"
                      min={MIN_INTERVAL}
                      max={MAX_INTERVAL}
                      step="5"
                      value={intervals[a.id] ?? ''}
                      onChange={(e) => setIntervals((m) => ({ ...m, [a.id]: e.target.value }))}
                      className="w-32 bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none tnum"
                    />
                  </div>
                  <button
                    onClick={() => save(a)}
                    disabled={savingId === a.id || !edited}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Save size={13} /> {savingId === a.id ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => pollNow(a)}
                    disabled={pollingId === a.id}
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <Play size={13} /> {pollingId === a.id ? 'Polling…' : 'Poll now'}
                  </button>
                </div>

                <p className="text-[11px] text-ink-faint mt-2">
                  Allowed range {MIN_INTERVAL}–{MAX_INTERVAL} minutes. Changes reschedule polling immediately; the next sample lands at the following interval tick.
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
