// Shared bits for the Cisco pages. Cisco is a derived platform: every number comes
// from the LogicMonitor portal(s) that monitor the devices, served under /api/cisco.
// The request helpers are the F5 ones (they take any path), re-exported under Cisco names.
export {
  requestError, OLDER_VERSION, rowsOf, REFRESH_MS, SOURCE_NOTE, useF5Get as useCiscoGet,
} from '../f5/f5Shared';

export const BRAND = '#049FD9';
export const API = '/cisco';

// Kinds a Cisco or Meraki device row can carry (vendorKind), per the backend vocabulary.
export const KIND_LABEL = {
  switch: 'Switch', nexus: 'Nexus', router: 'Router', firewall: 'Firewall', wireless: 'Wireless controller',
  ap: 'Access point', ise: 'ISE', voice: 'Voice', ucs: 'UCS', esa: 'ESA',
  mx: 'Meraki MX', ms: 'Meraki MS', mr: 'Meraki MR', mv: 'Meraki MV', mg: 'Meraki MG', other: 'Other',
};
export const kindLabel = (k) => KIND_LABEL[k] || (k ? String(k) : 'Unknown');

export const familyLabel = (vendorKey) => (vendorKey === 'meraki' ? 'Meraki' : vendorKey === 'cisco' ? 'Cisco' : (vendorKey ? String(vendorKey) : 'Cisco'));
