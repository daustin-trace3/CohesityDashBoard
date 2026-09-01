// Broadcom FOS release lifecycle (docs.broadcom.com/doc/Brocade-SW-Support-RM).
// SANnav only reports its own eosStatus flag on 2.3.1+ (and even then sparsely),
// so switch-level EOS is derived here from the firmware train and merged with
// SANnav's flag wherever switch data is served (switch list/detail, issues,
// governance). eos = End of Support date; lsa = Legacy Support & Availability.
const FOS_LIFECYCLE = {
  '7.4': { eos: '2020-02-22' },
  '8.0': { eos: '2020-11-30' },
  '8.1': { eos: '2022-02-28' },
  '8.2': { lsa: '2023-07-28' },
  '9.0': { eos: '2025-04-30' },
  '9.1': { eos: '2025-12-30' },
  '9.2': {},
};

function fosTrain(firmwareVersion) {
  const m = String(firmwareVersion || '').match(/v?(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Lifecycle verdict for one firmware version, merged with SANnav's own flag.
 *  status: eos | lsa | nearing | supported | unknown */
function lifecycleFor(firmwareVersion, sannavEosFlag) {
  const nowMs = Date.now();
  const train = fosTrain(firmwareVersion);
  const lc = train ? FOS_LIFECYCLE[train] : null;
  const eosMs = lc?.eos ? Date.parse(lc.eos) : null;
  const lsaMs = lc?.lsa ? Date.parse(lc.lsa) : null;
  let status = 'unknown';
  if (eosMs != null) status = eosMs <= nowMs ? 'eos' : (eosMs - nowMs) <= 365 * 86400000 ? 'nearing' : 'supported';
  else if (lsaMs != null) status = 'lsa';
  else if (lc) status = 'supported';
  if (status !== 'eos' && Number(sannavEosFlag) === 1) status = 'eos';
  return {
    train, status,
    eosDate: lc?.eos || null, lsaDate: lc?.lsa || null,
    eosDays: eosMs != null ? Math.round((eosMs - nowMs) / 86400000) : null,
    isEos: status === 'eos',
  };
}

module.exports = { FOS_LIFECYCLE, fosTrain, lifecycleFor };
