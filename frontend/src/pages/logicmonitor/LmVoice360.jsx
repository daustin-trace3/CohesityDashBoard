import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import {
  DASH, arr, fmtNum, fmtPct, fmtWhen, stateTone, stateLabel, hostStatusTone, hostStatusLabel,
} from './helpers';
import { Modal, SectionPanel, Fact } from './ui';
import { TrendLine, AutoTable, IssuesList, pointsOf } from './LmFirewall360';
import { RawDatapointsSection, RawState } from './servicesShared';

export default function LmVoice360({ deviceId, sourceId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    client.get(`/logicmonitor/voice/${deviceId}`, { params: sourceId ? { sourceId } : {} })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Voice device not found. It may have been removed.' : 'Failed to load the voice device.'));
  }, [deviceId, sourceId]);

  const s = data?.summary || {};
  const d = data?.device || {};
  const kind = s.kind;
  const KIND_LABEL = { sbc: 'Session border controller', cube: 'CUBE router', ganc: 'GANC' };

  return (
    <Modal icon={Phone} title={s.deviceName || d.displayName || `Voice device ${deviceId}`} subtitle={[KIND_LABEL[kind], s.vendor, s.model, s.version].filter(Boolean).join(' - ')} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading voice device..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={stateTone(s.state)}>{stateLabel(s.state)}</Badge>
            <Badge tone={hostStatusTone(s.hostStatus)}>{hostStatusLabel(s.hostStatus)}</Badge>
            <button onClick={() => navigate(`/logicmonitor/issues?q=${encodeURIComponent(s.deviceName || '')}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open issues page</button>
          </div>

          {kind === 'sbc' && (
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
              <Fact label="Site">{s.siteName || s.siteKey}</Fact>
              <Fact label="Health"><RawState raw={s.healthRaw} ok={s.healthBad == null ? null : !s.healthBad} label={s.healthBad ? 'Not healthy' : 'Healthy'} /></Fact>
              <Fact label="CPU">{fmtPct(s.cpuPct)}</Fact>
              <Fact label="Memory">{fmtPct(s.memPct)}</Fact>
              <Fact label="Temperature max">{s.tempMaxC == null ? DASH : `${s.tempMaxC} C`}</Fact>
              <Fact label="Retransmissions">{fmtNum(s.retransmissions)}</Fact>
              <Fact label="Fans">{s.fans == null ? DASH : `${fmtNum(s.fans)} (${fmtNum(s.fansBad)} bad)`}</Fact>
              <Fact label="Power supplies">{s.psus == null ? DASH : `${fmtNum(s.psus)} (${fmtNum(s.psusBad)} bad)`}</Fact>
              <Fact label="Steering pools">{fmtNum(s.pools)}</Fact>
              <Fact label="Pool sessions">{fmtNum(s.poolSessions)}</Fact>
              <Fact label="Pool failures">{fmtNum(s.poolFailures)}</Fact>
              <Fact label="Sampled">{s.sampledAt ? fmtWhen(s.sampledAt) : DASH}</Fact>
            </div>
          )}
          {kind === 'cube' && (
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
              <Fact label="Site">{s.siteName || s.siteKey}</Fact>
              <Fact label="SIP connections">{fmtNum(s.sipConnections)}</Fact>
              <Fact label="Server errors per second">{s.sipServerErrPerSec == null ? DASH : s.sipServerErrPerSec}</Fact>
              <Fact label="Client errors per second">{s.sipClientErrPerSec == null ? DASH : s.sipClientErrPerSec}</Fact>
              <Fact label="Invite retries">{fmtNum(s.sipRetries)}</Fact>
              <Fact label="ISDN busy channels">{fmtNum(s.isdnBusy)}</Fact>
            </div>
          )}
          {kind === 'ganc' && (
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
              <Fact label="Site">{s.siteName || s.siteKey}</Fact>
              <Fact label="Mobility check"><RawState raw={s.mobilityRaw} ok={s.mobilityRaw == null ? null : Number(s.mobilityRaw) === 0} label={Number(s.mobilityRaw) === 0 ? 'OK' : undefined} /></Fact>
              <Fact label="ISE RADIUS check"><RawState raw={s.radiusCheckRaw} ok={s.radiusCheckRaw == null ? null : Number(s.radiusCheckRaw) === 0} label={Number(s.radiusCheckRaw) === 0 ? 'OK' : undefined} /></Fact>
              <Fact label="SSIDs">{fmtNum(s.ssids)}</Fact>
              <Fact label="Clients">{fmtNum(s.clients)}</Fact>
              <Fact label="RADIUS servers">{s.radiusServers == null ? DASH : `${fmtNum(s.radiusServers)} (${fmtNum(s.radiusServersDown)} down)`}</Fact>
            </div>
          )}

          <SectionPanel title="Open issues"><IssuesList issues={data.issues} /></SectionPanel>

          {kind === 'sbc' && (
            <>
              <div className="grid lg:grid-cols-2 gap-4">
                <SectionPanel title="CPU, 24 hours"><TrendLine pct series={[{ label: 'CPU %', points: pointsOf(data.history, ['cpuPct']) }]} /></SectionPanel>
                <SectionPanel title="Memory, 24 hours"><TrendLine pct series={[{ label: 'Memory %', points: pointsOf(data.history, ['memPct']), color: '#3FB950' }]} /></SectionPanel>
              </div>
              <div className="grid lg:grid-cols-2 gap-4">
                <SectionPanel title="Fans" blurb="Raw state value; 3 or more counts as not healthy (unverified).">
                  <AutoTable rows={arr(data.fans)} empty="No fans collected." pageSize={5} />
                </SectionPanel>
                <SectionPanel title="Power supplies"><AutoTable rows={arr(data.psus)} empty="No power supplies collected." pageSize={5} /></SectionPanel>
              </div>
              <div className="grid lg:grid-cols-2 gap-4">
                <SectionPanel title="Temperatures"><AutoTable rows={arr(data.temps)} empty="No temperature sensors collected." pageSize={6} /></SectionPanel>
                <SectionPanel title="Steering pools"><AutoTable rows={arr(data.pools)} empty="No steering pool statistics collected." pageSize={6} /></SectionPanel>
              </div>
            </>
          )}
          {kind === 'cube' && (
            <SectionPanel title="SIP counters" blurb="Latest value of every SIP and ISDN datapoint the catalog labels. Counters only grow; the rate on the list comes from their history.">
              <AutoTable rows={arr(data.sip)} empty="No SIP counters collected." pageSize={10} preferred={['datasource', 'instance', 'label', 'value', 'unit']} />
            </SectionPanel>
          )}
          {kind === 'ganc' && (
            <div className="grid lg:grid-cols-2 gap-4">
              <SectionPanel title="SSIDs"><AutoTable rows={arr(data.ssids)} empty="No WLAN rows on this device." pageSize={6} /></SectionPanel>
              <SectionPanel title="RADIUS servers"><AutoTable rows={arr(data.radius)} empty="No RADIUS server rows on this device." pageSize={6} /></SectionPanel>
            </div>
          )}

          <RawDatapointsSection deviceId={deviceId} sourceId={sourceId || s.sourceId} />
        </div>
      )}
    </Modal>
  );
}
