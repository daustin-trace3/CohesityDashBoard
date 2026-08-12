import { useEffect, useState, useCallback, useRef } from 'react';
import { Cctv, Mic, MicOff, Bell, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, parseJsonArr } from './helpers';

const SNAP_REFRESH_MS = 60000;

// Snapshot <img> can't carry the x-api-key header, so frames are fetched as
// blobs through the authenticated client and swapped in as object URLs.
// Exported for the Overview camera strip.
export function CameraSnapshot({ cameraId, state }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const urlRef = useRef(null);

  const load = useCallback(() => {
    if (state !== 'CONNECTED') return;
    setLoading(true);
    client.get(`/unifi/protect/cameras/${encodeURIComponent(cameraId)}/snapshot`, { responseType: 'blob' })
      .then(({ data }) => {
        const next = URL.createObjectURL(data);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setUrl(next);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [cameraId, state]);

  useEffect(() => {
    load();
    const t = setInterval(load, SNAP_REFRESH_MS);
    return () => {
      clearInterval(t);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [load]);

  if (state !== 'CONNECTED') {
    return <div className="aspect-video bg-surface-overlay rounded-lg flex items-center justify-center text-xs text-ink-faint">Offline</div>;
  }
  if (failed && !url) {
    return <div className="aspect-video bg-surface-overlay rounded-lg flex items-center justify-center text-xs text-ink-faint">Snapshot unavailable</div>;
  }
  return (
    <div className="relative aspect-video bg-black/40 rounded-lg overflow-hidden">
      {url && <img src={url} alt="camera snapshot" className="w-full h-full object-cover" />}
      <button onClick={load} title="Refresh snapshot"
        className="absolute top-1.5 right-1.5 flex items-center justify-center h-6 w-6 rounded-md bg-black/50 text-white/80 hover:text-white cursor-pointer">
        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}

export default function UnifiProtectPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/unifi/protect')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ cameras: [], nvrs: [] }); toast({ type: 'error', title: 'Failed to load Protect data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const cameras = (data?.cameras || []).filter((c) => c.model_key !== 'chime');
  const chimes = (data?.cameras || []).filter((c) => c.model_key === 'chime');
  const nvrs = data?.nvrs || [];

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cctv} title="Protect" description="UniFi Protect cameras, doorbells and alarm state">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading Protect data…" height={160} />
      ) : cameras.length === 0 && nvrs.length === 0 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No Protect application detected on any connected controller.
        </div>
      ) : (
        <>
          {nvrs.length > 0 && (
            <div className="grid sm:grid-cols-2 gap-3 mb-4">
              {nvrs.map((n) => {
                const arm = n.nvr?.armMode || null;
                const armed = arm?.status && arm.status !== 'disabled';
                const breach = arm && (arm.breachDetectedAt || (arm.breachEventCount || 0) > 0);
                return (
                  <div key={n.sourceId} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{n.nvr?.name || n.sourceName}</p>
                        <p className="text-[11px] text-ink-faint">Protect {n.applicationVersion || '—'} · {n.sourceName}</p>
                      </div>
                      {breach ? (
                        <Badge tone="crit"><ShieldAlert size={11} className="inline mr-1" />Breach</Badge>
                      ) : (
                        <Badge tone={armed ? 'info' : 'neutral'}><ShieldCheck size={11} className="inline mr-1" />{armed ? `Armed (${arm.status})` : 'Alarm off'}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted">
                      {cameras.filter((c) => String(c.source_name) === String(n.sourceName)).length} camera(s)
                      {chimes.length ? ` · ${chimes.length} chime(s)` : ''}
                      {n.nvr?.doorbell?.defaultMessage ? ` · Doorbell: "${n.nvr.doorbell.defaultMessage}"` : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {cameras.map((c) => {
              const detect = parseJsonArr(c.smart_detect_json);
              return (
                <div key={c.id} className="panel p-3" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <CameraSnapshot cameraId={c.camera_id} state={c.state} />
                  <div className="flex items-start justify-between gap-2 mt-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink truncate">{c.name || c.mac}</p>
                      <p className="text-[11px] text-ink-faint truncate">{c.client_ip || '—'}{c.video_mode && c.video_mode !== 'default' ? ` · ${c.video_mode}` : ''}{c.hdr_type ? ` · HDR ${c.hdr_type}` : ''}</p>
                    </div>
                    <Badge tone={c.state === 'CONNECTED' ? 'ok' : 'crit'}>{c.state === 'CONNECTED' ? 'Online' : (c.state || 'Unknown')}</Badge>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {c.is_mic_enabled != null && (
                      <span className="text-[10px] text-ink-faint inline-flex items-center gap-1">
                        {c.is_mic_enabled ? <Mic size={10} /> : <MicOff size={10} />}{c.is_mic_enabled ? 'Mic' : 'Mic off'}
                      </span>
                    )}
                    {detect.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}
                    {c.has_package_camera ? <Badge tone="info">Package cam</Badge> : null}
                  </div>
                </div>
              );
            })}
            {chimes.map((c) => (
              <div key={c.id} className="panel p-3 flex flex-col justify-between" style={{ borderTop: `3px solid ${BRAND}` }}>
                <div className="aspect-video bg-surface-overlay rounded-lg flex items-center justify-center">
                  <Bell size={28} className="text-ink-faint" />
                </div>
                <div className="flex items-start justify-between gap-2 mt-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink truncate">{c.name || c.mac}</p>
                    <p className="text-[11px] text-ink-faint">Doorbell chime</p>
                  </div>
                  <Badge tone={c.state === 'CONNECTED' ? 'ok' : 'crit'}>{c.state === 'CONNECTED' ? 'Online' : (c.state || 'Unknown')}</Badge>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
