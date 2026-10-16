import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RadioTower } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { DASH, arr, fmtNum, fmtPct, fmtWhen, stateTone, stateLabel, hostStatusTone, hostStatusLabel, titleCase } from './helpers';
import { Modal, SectionPanel, Fact, UtilBar, headRow } from './ui';
import { IssuesList, TrendLine, AutoTable, FactGrid } from './LmFirewall360';
import { ApTable, BAND_COLOR } from './wirelessShared';
import LmAp360 from './LmAp360';

export default function LmWlc360({ deviceId, sourceId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [ap, setAp] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    client.get(`/logicmonitor/wireless/controllers/${deviceId}`, { params: sourceId ? { sourceId } : {} })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Wireless controller not found.' : 'Failed to load the controller.'));
  }, [deviceId, sourceId]);

  const s = data?.summary || {};
  const radiusRows = arr(data?.radius?.auth).map((r) => ({ ...r, state: titleCase(r.state) }));

  return (
    <Modal icon={RadioTower} title={s.deviceName || `Controller ${deviceId}`} subtitle={[s.platform, s.model, s.version].filter(Boolean).join(' - ')} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading controller..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={stateTone(s.state)}>{stateLabel(s.state)}</Badge>
            <Badge tone={hostStatusTone(s.hostStatus)}>{hostStatusLabel(s.hostStatus)}</Badge>
            {s.haText && <Badge tone={s.haDegraded ? 'crit' : 'info'}>HA {s.haText}</Badge>}
            {s.mobility && <Badge tone={s.mobility === 'ok' ? 'ok' : 'warn'}>Mobility {s.mobility}</Badge>}
            <button onClick={() => navigate(`/logicmonitor/issues?q=${encodeURIComponent(s.deviceName || '')}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open issues page</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Fact label="Site">{s.siteName || s.siteKey}</Fact>
            <Fact label="APs up / total">{`${fmtNum(s.apsUp)} / ${fmtNum(s.apsTotal)}`}</Fact>
            <Fact label="APs down">{fmtNum(s.apsDown)}</Fact>
            <Fact label="AP availability">{fmtPct(s.apAvailablePct)}</Fact>
            <Fact label="Radios up / total">{`${fmtNum(s.radiosUp)} / ${fmtNum(s.radiosTotal)}`}</Fact>
            <Fact label="Clients">{s.clientsMax ? `${fmtNum(s.clients)} / ${fmtNum(s.clientsMax)}` : fmtNum(s.clients)}</Fact>
            <Fact label="Avg channel util">{fmtPct(s.avgChannelUtilPct)}</Fact>
            <Fact label="CPU">{fmtPct(s.cpuPct)}</Fact>
            <Fact label="Memory">{fmtPct(s.memPct)}</Fact>
            <Fact label="Temperature">{s.tempC == null ? DASH : `${s.tempC} C`}</Fact>
            <Fact label="SSIDs">{fmtNum(s.ssids)}</Fact>
            <Fact label="Sampled">{s.sampledAt ? fmtWhen(s.sampledAt) : DASH}</Fact>
          </div>

          <SectionPanel title="Open issues"><IssuesList issues={data.issues} /></SectionPanel>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Clients, 24 hours" blurb="Sum of clients across this controller's WLANs.">
              <TrendLine series={[{ label: 'Clients', points: data.clientHistory }]} />
            </SectionPanel>
            <SectionPanel title="CPU, 24 hours">
              <TrendLine pct series={[{ label: 'CPU %', points: data.cpuHistory, color: '#3FB950' }]} />
            </SectionPanel>
          </div>

          <SectionPanel title="Bands">
            {arr(data.bands).length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No radios collected.</p> : (
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <th className="py-2 pr-3">Band</th><th className="py-2 pr-3 text-right">Radios up</th><th className="py-2 pr-3 text-right">Down</th>
                  <th className="py-2 pr-3 text-right">Clients</th><th className="py-2 pr-3">Avg channel util</th><th className="py-2 pr-3 text-right">Above threshold</th>
                </tr></thead>
                <tbody>
                  {data.bands.map((b) => (
                    <tr key={b.band} className="border-b border-cohesity-border/40 text-[12px]">
                      <td className="py-1.5 pr-3 text-ink"><span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: BAND_COLOR[b.band] }} />{b.band}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{`${fmtNum(b.up)} / ${fmtNum(b.radios)}`}</td>
                      <td className={`py-1.5 pr-3 text-right tnum ${b.down ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtNum(b.down)}</td>
                      <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(b.clients)}</td>
                      <td className="py-1.5 pr-3 min-w-[140px]"><UtilBar pct={b.avgChannelUtilPct} /></td>
                      <td className={`py-1.5 pr-3 text-right tnum ${b.hot ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtNum(b.hot)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionPanel>

          <SectionPanel title="Access points" blurb="Down, missing and not-reporting APs sort first. Click an AP for its radios and uplink.">
            <ApTable rows={data.aps} showController={false} onOpen={(a) => setAp(a)} />
          </SectionPanel>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="SSIDs">
              <AutoTable rows={arr(data.ssids).map((x) => ({ ssid: x.ssid, wlan: x.wlan, clients: x.clients, enabled: x.enabled, broadcast: x.broadcast }))} empty="No WLANs collected." />
            </SectionPanel>
            <SectionPanel title="RADIUS authentication" blurb="Rates per second. Unresponsive = enabled, timing out, and no accepts, rejects or challenges.">
              <AutoTable rows={radiusRows} preferred={['server', 'state', 'enabled', 'requests', 'accepts', 'rejects', 'timeouts']} empty="No RADIUS servers collected (Catalyst 9800 does not expose this DataSource)." />
            </SectionPanel>
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <SectionPanel title="Connections"><FactGrid obj={data.connections} empty="Not collected on this controller." /></SectionPanel>
            <SectionPanel title="Mobility"><FactGrid obj={data.mobility} empty="Not collected on this controller." /></SectionPanel>
            <SectionPanel title="DHCP proxy"><FactGrid obj={data.dhcp} empty="Not collected on this controller." /></SectionPanel>
          </div>
          {arr(data?.radius?.accounting).length > 0 && (
            <SectionPanel title="RADIUS accounting"><AutoTable rows={data.radius.accounting} /></SectionPanel>
          )}
        </div>
      )}
      {ap && <LmAp360 controllerId={ap.controllerId} sourceId={ap.sourceId} apKey={ap.apKey} onClose={() => setAp(null)} />}
    </Modal>
  );
}
