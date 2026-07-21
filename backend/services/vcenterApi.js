// vCenter API client. Inventory comes from the vSphere Automation REST API
// (vCenter 7.0U2+ /api paths, JSON). Two things the REST API still does not
// expose — host maintenance mode and host/cluster CPU+memory usage — are
// enriched best-effort from the classic SOAP API (/sdk) via a fixed
// ContainerView + RetrievePropertiesEx flow; when SOAP fails the REST
// inventory still lands and those columns stay NULL.
const axios = require('axios');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const SESSION_TTL_MS = 25 * 60 * 1000;
const sessions = new Map(); // vcenter.id -> { token, fetchedAt }

function creds(vc) {
  // Unsaved candidates (test connection) carry a plaintext password;
  // registered rows carry the encrypted blob.
  if (vc.password) return { username: vc.username, password: vc.password };
  const c = JSON.parse(decrypt(vc.encrypted_credentials));
  return { username: vc.username, password: c.password };
}

function baseClient(vc, headers = {}) {
  return axios.create({
    baseURL: `https://${vc.host}`,
    timeout: 60000,
    headers,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!vc.ssl_verify }),
  });
}

/** REST session token (vmware-api-session-id), cached ~25 min per vCenter. */
async function getSession(vc, force = false) {
  const cached = sessions.get(vc.id);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.token;
  const { password } = creds(vc);
  const { data } = await baseClient(vc).post('/api/session', null, {
    auth: { username: vc.username, password },
  });
  const token = typeof data === 'string' ? data : data?.value;
  if (!token) throw new Error('vCenter session login returned no token');
  sessions.set(vc.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateSession(vcId) {
  sessions.delete(vcId);
}

async function vGet(vc, path, params = {}) {
  let token = await getSession(vc);
  const doGet = (t) => baseClient(vc, { 'vmware-api-session-id': t }).get(path, { params });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getSession(vc, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

// Older vCenters wrap list responses in { value: [...] }.
const unwrap = (d) => (Array.isArray(d) ? d : (d?.value ?? []));

// ── REST inventory ───────────────────────────────────────────────────────────

const fetchClusters = async (vc) => unwrap(await vGet(vc, '/api/vcenter/cluster'));
const fetchHosts = async (vc, clusterId = null) =>
  unwrap(await vGet(vc, '/api/vcenter/host', clusterId ? { clusters: clusterId } : {}));
const fetchDatastores = async (vc) => unwrap(await vGet(vc, '/api/vcenter/datastore'));
const fetchVmsForHost = async (vc, hostId) => unwrap(await vGet(vc, '/api/vcenter/vm', { hosts: hostId }));

/** vCenter machine TLS certificate (needs cert-management privilege; best-effort). */
async function fetchTlsCert(vc) {
  const d = await vGet(vc, '/api/vcenter/certificate-management/vcenter/tls');
  return d?.value ?? d ?? null;
}

// ── SOAP enrichment (maintenance mode + CPU/memory quickstats) ───────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function envelope(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25">
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
}

async function soapCall(vc, body, cookie = null) {
  const { data, headers } = await baseClient(vc, {
    'Content-Type': 'text/xml; charset=utf-8',
    SOAPAction: 'urn:vim25/8.0.0.0',
    ...(cookie ? { Cookie: cookie } : {}),
  }).post('/sdk', envelope(body));
  const parsed = xmlParser.parse(data);
  const respBody = parsed?.Envelope?.Body;
  if (respBody?.Fault) {
    throw new Error(`SOAP fault: ${respBody.Fault.faultstring || 'unknown'}`);
  }
  return { body: respBody, setCookie: headers['set-cookie']?.[0]?.split(';')[0] || null };
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

const HOST_PROPS = [
  'name', 'runtime.inMaintenanceMode', 'runtime.connectionState',
  'summary.quickStats.overallCpuUsage', 'summary.quickStats.overallMemoryUsage',
  'summary.hardware.cpuMhz', 'summary.hardware.numCpuCores', 'summary.hardware.memorySize',
  'config.product.version', 'config.product.build',
  'hardware.biosInfo.biosVersion', 'hardware.biosInfo.releaseDate',
  'hardware.systemInfo.vendor', 'hardware.systemInfo.model',
];
const VM_PROPS = [
  'name', 'runtime.powerState', 'runtime.host', 'config.guestFullName', 'config.version',
  'summary.config.numCpu', 'summary.config.memorySizeMB',
  'guest.ipAddress', 'guest.toolsRunningStatus',
];

const flat = (v) => (v && typeof v === 'object' && '#text' in v) ? v['#text'] : v;

function objectsToProps(objects) {
  return objects.map(obj => {
    const props = { _moref: flat(obj.obj), _type: obj.obj?.['@_type'] };
    for (const p of asArray(obj.propSet)) props[p.name] = flat(p.val);
    return props;
  });
}

/**
 * Full SOAP inventory sweep: vCenter about info, per-host runtime/version/BIOS,
 * and every VM guest. One login; RetrievePropertiesEx pages are drained via
 * ContinueRetrievePropertiesEx (large VM counts return a continuation token).
 */
async function fetchInventorySoap(vc) {
  const { password } = creds(vc);
  const login = await soapCall(vc, `
    <vim25:Login><vim25:_this type="SessionManager">SessionManager</vim25:_this>
      <vim25:userName>${esc(vc.username)}</vim25:userName>
      <vim25:password>${esc(password)}</vim25:password>
    </vim25:Login>`);
  const cookie = login.setCookie;
  if (!cookie) throw new Error('SOAP login returned no session cookie');
  try {
    const sc = await soapCall(vc, '<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>', cookie);
    const aboutRaw = sc.body?.RetrieveServiceContentResponse?.returnval?.about || {};
    const about = { fullName: flat(aboutRaw.fullName), version: flat(aboutRaw.version), build: flat(aboutRaw.build) };

    const cv = await soapCall(vc, `
      <vim25:CreateContainerView><vim25:_this type="ViewManager">ViewManager</vim25:_this>
        <vim25:container type="Folder">group-d1</vim25:container>
        <vim25:type>HostSystem</vim25:type>
        <vim25:type>VirtualMachine</vim25:type>
        <vim25:recursive>true</vim25:recursive>
      </vim25:CreateContainerView>`, cookie);
    const viewId = flat(cv.body?.CreateContainerViewResponse?.returnval);

    const propSetXml = (type, paths) => `
          <vim25:propSet>
            <vim25:type>${type}</vim25:type>
            ${paths.map(p => `<vim25:pathSet>${p}</vim25:pathSet>`).join('')}
          </vim25:propSet>`;
    const rp = await soapCall(vc, `
      <vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
        <vim25:specSet>
          ${propSetXml('HostSystem', HOST_PROPS)}
          ${propSetXml('VirtualMachine', VM_PROPS)}
          <vim25:objectSet>
            <vim25:obj type="ContainerView">${esc(viewId)}</vim25:obj>
            <vim25:skip>true</vim25:skip>
            <vim25:selectSet xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="vim25:TraversalSpec">
              <vim25:name>view</vim25:name>
              <vim25:type>ContainerView</vim25:type>
              <vim25:path>view</vim25:path>
              <vim25:skip>false</vim25:skip>
            </vim25:selectSet>
          </vim25:objectSet>
        </vim25:specSet>
        <vim25:options/>
      </vim25:RetrievePropertiesEx>`, cookie);

    let result = rp.body?.RetrievePropertiesExResponse?.returnval;
    let objects = asArray(result?.objects);
    while (result?.token != null && String(result.token) !== '') {
      const cont = await soapCall(vc, `
        <vim25:ContinueRetrievePropertiesEx><vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>
          <vim25:token>${esc(flat(result.token))}</vim25:token>
        </vim25:ContinueRetrievePropertiesEx>`, cookie);
      result = cont.body?.ContinueRetrievePropertiesExResponse?.returnval;
      objects = objects.concat(asArray(result?.objects));
    }

    const rows = objectsToProps(objects);
    const hostRows = rows.filter(r => r._type === 'HostSystem' || r['runtime.inMaintenanceMode'] !== undefined);
    const vmRows = rows.filter(r => r._type === 'VirtualMachine' || r['runtime.powerState'] !== undefined);

    const hostsByName = new Map();
    const hostNameByMoref = new Map();
    for (const props of hostRows) {
      if (props.name == null) continue;
      const cores = Number(props['summary.hardware.numCpuCores']) || 0;
      const mhz = Number(props['summary.hardware.cpuMhz']) || 0;
      hostNameByMoref.set(String(props._moref), String(props.name));
      hostsByName.set(String(props.name), {
        inMaintenance: String(props['runtime.inMaintenanceMode']) === 'true' ? 1 : 0,
        cpuMhzCapacity: cores * mhz || null,
        cpuMhzUsed: props['summary.quickStats.overallCpuUsage'] != null ? Number(props['summary.quickStats.overallCpuUsage']) : null,
        memBytesCapacity: props['summary.hardware.memorySize'] != null ? Number(props['summary.hardware.memorySize']) : null,
        // quickStats memory usage is MB
        memBytesUsed: props['summary.quickStats.overallMemoryUsage'] != null ? Number(props['summary.quickStats.overallMemoryUsage']) * 1024 * 1024 : null,
        esxVersion: props['config.product.version'] ?? null,
        esxBuild: props['config.product.build'] ?? null,
        biosVersion: props['hardware.biosInfo.biosVersion'] ?? null,
        biosReleaseDate: props['hardware.biosInfo.releaseDate'] ?? null,
        vendor: props['hardware.systemInfo.vendor'] ?? null,
        model: props['hardware.systemInfo.model'] ?? null,
      });
    }

    const vms = vmRows.filter(v => v.name != null).map(v => ({
      vmId: String(v._moref || ''),
      name: String(v.name),
      hostName: hostNameByMoref.get(String(v['runtime.host'])) || null,
      powerState: v['runtime.powerState'] ?? null,
      guestOs: v['config.guestFullName'] ?? null,
      cpuCount: v['summary.config.numCpu'] != null ? Number(v['summary.config.numCpu']) : null,
      memoryMb: v['summary.config.memorySizeMB'] != null ? Number(v['summary.config.memorySizeMB']) : null,
      ipAddress: v['guest.ipAddress'] ?? null,
      toolsStatus: v['guest.toolsRunningStatus'] ?? null,
      hwVersion: v['config.version'] ?? null,
    }));

    return { about, hostsByName, vms };
  } finally {
    soapCall(vc, '<vim25:Logout><vim25:_this type="SessionManager">SessionManager</vim25:_this></vim25:Logout>', cookie)
      .catch(() => {});
  }
}

/** Validate a vCenter (saved row or unsaved candidate). Never throws. */
async function testConnection(vcLike) {
  try {
    const token = await getSession({ id: `test-${vcLike.host}`, ...vcLike }, true);
    const hosts = unwrap(await (async () => {
      const { data } = await baseClient(vcLike, { 'vmware-api-session-id': token }).get('/api/vcenter/host');
      return data;
    })());
    sessions.delete(`test-${vcLike.host}`);
    return { ok: true, hosts: hosts.length };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the vCenter username and password.'
        : (err.response?.data?.messages?.[0]?.default_message || err.message),
    };
  }
}

module.exports = {
  getSession, invalidateSession, vGet, unwrap,
  fetchClusters, fetchHosts, fetchDatastores, fetchVmsForHost, fetchTlsCert,
  fetchInventorySoap, testConnection,
};
