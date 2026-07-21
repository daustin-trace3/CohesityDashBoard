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

// SOAP namespace version, negotiated from the server's own handshake document
// (GET /sdk/vimServiceVersions.xml, unauthenticated) instead of hardcoded — a
// 7.x vCenter faults on a newer urn:vim25 version. Cached per host.
const vimVersions = new Map(); // vc.host -> '8.0.3.0' etc.
async function soapVersion(vc) {
  if (vimVersions.has(vc.host)) return vimVersions.get(vc.host);
  let version = '6.5'; // safe floor: every supported vCenter accepts it
  try {
    const { data } = await baseClient(vc).get('/sdk/vimServiceVersions.xml');
    const parsed = xmlParser.parse(data);
    const namespaces = asArray(parsed?.namespaces?.namespace);
    const vim25 = namespaces.find(n => String(flat(n.name)) === 'urn:vim25');
    if (vim25?.version != null) version = String(flat(vim25.version));
  } catch (err) {
    logger.debug(`[vcenterApi] version handshake failed for ${vc.host} (using urn:vim25/${version}): ${err.message}`);
  }
  vimVersions.set(vc.host, version);
  return version;
}

// vSphere returns SOAP faults WITH HTTP 500 — parse the fault body out of the
// axios error so callers see "ServerFaultCode: ..." instead of "HTTP 500".
function soapFaultMessage(err) {
  const raw = err?.response?.data;
  if (!raw || typeof raw !== 'string') return null;
  try {
    const fault = xmlParser.parse(raw)?.Envelope?.Body?.Fault;
    if (!fault) return null;
    const code = flat(fault.faultcode);
    const str = flat(fault.faultstring);
    const detailType = fault.detail && typeof fault.detail === 'object'
      ? Object.keys(fault.detail).find(k => !k.startsWith('@_')) : null;
    return `SOAP fault${code ? ` [${code}]` : ''}: ${str || detailType || 'unknown'}`;
  } catch { return null; }
}

async function soapCall(vc, body, cookie = null) {
  const version = await soapVersion(vc);
  let data, headers;
  try {
    ({ data, headers } = await baseClient(vc, {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `urn:vim25/${version}`,
      ...(cookie ? { Cookie: cookie } : {}),
    }).post('/sdk', envelope(body)));
  } catch (err) {
    const fault = soapFaultMessage(err);
    if (fault) throw new Error(fault);
    throw err;
  }
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
  'summary.quickStats.uptime',
  'summary.hardware.cpuMhz', 'summary.hardware.numCpuCores', 'summary.hardware.memorySize',
  'config.product.version', 'config.product.build',
  'hardware.biosInfo.biosVersion', 'hardware.biosInfo.releaseDate',
  'hardware.systemInfo.vendor', 'hardware.systemInfo.model',
  // Governance + network config (drift detection, Network page)
  'config.dateTimeInfo.ntpConfig.server', 'config.network.dnsConfig.address',
  'config.service.service',
  'config.network.pnic', 'config.network.vswitch', 'config.network.portgroup', 'config.network.vnic',
];
const VM_PROPS = [
  'name', 'runtime.powerState', 'runtime.host', 'config.guestFullName', 'config.version',
  'summary.config.numCpu', 'summary.config.memorySizeMB',
  'guest.ipAddress', 'guest.toolsRunningStatus',
  'guest.toolsVersion', 'guest.toolsVersionStatus2',
  'layoutEx.file', // every file backing the VM — feeds the orphaned-VMDK diff
];
const DVS_PROPS = ['name', 'summary.portCount', 'summary.uuid'];
const DVPG_PROPS = ['name', 'config.distributedVirtualSwitch', 'config.defaultPortConfig'];

const flat = (v) => (v && typeof v === 'object' && '#text' in v) ? v['#text'] : v;

function objectsToProps(objects) {
  return objects.map(obj => {
    const props = { _moref: flat(obj.obj), _type: obj.obj?.['@_type'] };
    for (const p of asArray(obj.propSet)) props[p.name] = flat(p.val);
    return props;
  });
}

// vim25 array-of-X properties parse as { X: [...] } (or a single object).
const vimArray = (val, elementName) => asArray(val?.[elementName] ?? (elementName ? undefined : val));
// ArrayOfString parses as { string: [...] } — used by NTP/DNS server lists.
const stringList = (val) => asArray(val?.string ?? val).map(flat).filter(v => v != null).map(String);
const num = (v) => { const n = Number(flat(v)); return Number.isFinite(n) ? n : null; };

/** Host networking structures → typed rows for vcenter_networks. */
function parseHostNetworks(hostName, props) {
  const rows = [];
  for (const p of vimArray(props['config.network.pnic'], 'PhysicalNic')) {
    rows.push({
      hostName, kind: 'pnic', name: flat(p.device) ?? null, switchName: null,
      speedMbps: num(p.linkSpeed?.speedMb), mac: flat(p.mac) ?? null,
      extra: { driver: flat(p.driver) ?? null, linkUp: p.linkSpeed != null },
    });
  }
  // vswitch pnic/portgroup members are opaque keys ("key-vim.host.PhysicalNic-vmnic0");
  // strip the key prefix so uplinks read as device names.
  const keyLeaf = (k) => String(flat(k) ?? '').split('-').pop();
  for (const s of vimArray(props['config.network.vswitch'], 'HostVirtualSwitch')) {
    rows.push({
      hostName, kind: 'vswitch', name: flat(s.name) ?? null, switchName: null,
      mtu: num(s.mtu ?? s.spec?.mtu), portCount: num(s.numPorts),
      uplinks: asArray(s.pnic).map(keyLeaf).filter(Boolean),
    });
  }
  for (const g of vimArray(props['config.network.portgroup'], 'HostPortGroup')) {
    rows.push({
      hostName, kind: 'portgroup', name: flat(g.spec?.name) ?? null,
      switchName: flat(g.spec?.vswitchName) ?? null, vlanId: num(g.spec?.vlanId),
    });
  }
  for (const v of vimArray(props['config.network.vnic'], 'HostVirtualNic')) {
    rows.push({
      hostName, kind: 'vmkernel', name: flat(v.device) ?? null,
      switchName: flat(v.portgroup) ?? flat(v.spec?.portgroup) ?? null,
      ipAddress: flat(v.spec?.ip?.ipAddress) ?? null, netmask: flat(v.spec?.ip?.subnetMask) ?? null,
      mac: flat(v.spec?.mac) ?? null, mtu: num(v.spec?.mtu),
      extra: { dhcp: String(flat(v.spec?.ip?.dhcp)) === 'true' },
    });
  }
  return rows;
}

const SSH_SERVICE_KEYS = new Set(['TSM-SSH', 'ssh']);

/**
 * Orphaned-VMDK sweep: browse every accessible datastore for *.vmdk files
 * (SearchDatastoreSubFolders_Task, polled to completion) and diff against the
 * set of files referenced by any VM's layoutEx. Descriptor files that no VM
 * references are orphans; their chain size includes companion -flat/-ctk/...
 * files. Requires the Datastore.Browse privilege — wholly best-effort.
 */
async function collectOrphans(vc, cookie, sc, datastores, referencedPaths) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const allFiles = []; // { path, size, modified, datastoreName }
  for (const ds of datastores) {
    if (!ds.browser || ds.accessible === false) continue;
    try {
      const task = await soapCall(vc, `
        <vim25:SearchDatastoreSubFolders_Task>
          <vim25:_this type="HostDatastoreBrowser">${esc(ds.browser)}</vim25:_this>
          <vim25:datastorePath>[${esc(ds.name)}]</vim25:datastorePath>
          <vim25:searchSpec>
            <vim25:details>
              <vim25:fileType>true</vim25:fileType>
              <vim25:fileSize>true</vim25:fileSize>
              <vim25:modification>true</vim25:modification>
              <vim25:fileOwner>false</vim25:fileOwner>
            </vim25:details>
            <vim25:matchPattern>*.vmdk</vim25:matchPattern>
          </vim25:searchSpec>
        </vim25:SearchDatastoreSubFolders_Task>`, cookie);
      const taskMoref = flat(task.body?.SearchDatastoreSubFolders_TaskResponse?.returnval);
      if (!taskMoref) continue;

      let info = null;
      for (let tries = 0; tries < 40; tries++) {
        const poll = await soapCall(vc, `
          <vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">${esc(sc.propertyCollector)}</vim25:_this>
            <vim25:specSet>
              <vim25:propSet><vim25:type>Task</vim25:type><vim25:pathSet>info</vim25:pathSet></vim25:propSet>
              <vim25:objectSet><vim25:obj type="Task">${esc(taskMoref)}</vim25:obj></vim25:objectSet>
            </vim25:specSet>
            <vim25:options/>
          </vim25:RetrievePropertiesEx>`, cookie);
        const objs = asArray(poll.body?.RetrievePropertiesExResponse?.returnval?.objects);
        info = asArray(objs[0]?.propSet).find(p => p.name === 'info')?.val || null;
        const state = String(flat(info?.state) || '');
        if (state === 'success' || state === 'error') break;
        await sleep(1500);
      }
      if (String(flat(info?.state)) !== 'success') continue;

      for (const res of vimArray(info.result, 'HostDatastoreBrowserSearchResults')) {
        const folder = String(flat(res.folderPath) || '');
        const prefix = folder.endsWith('/') || folder.endsWith(' ') ? folder : `${folder}/`;
        for (const f of asArray(res.file)) {
          const p = flat(f.path);
          if (!p) continue;
          allFiles.push({
            path: `${prefix}${p}`, size: num(f.fileSize) || 0,
            modified: flat(f.modification) ?? null, datastoreName: ds.name,
          });
        }
      }
    } catch (err) {
      logger.debug(`[vcenterApi] datastore browse failed for ${ds.name}: ${err.message}`);
    }
  }

  const isCompanion = (p) => /-(flat|delta|ctk|sesparse|rdmp?)\.vmdk$/i.test(p);
  const orphans = [];
  for (const f of allFiles) {
    if (isCompanion(f.path) || referencedPaths.has(f.path)) continue;
    const base = f.path.replace(/\.vmdk$/i, '');
    const chain = allFiles.filter(o => o.path === f.path || (isCompanion(o.path) && o.path.startsWith(`${base}-`)));
    orphans.push({
      datastoreName: f.datastoreName, path: f.path,
      sizeBytes: chain.reduce((n, o) => n + (o.size || 0), 0),
      modifiedAt: f.modified,
    });
  }
  return orphans;
}

/**
 * Full SOAP inventory sweep: vCenter about info, per-host runtime/version/BIOS,
 * and every VM guest. One login; RetrievePropertiesEx pages are drained via
 * ContinueRetrievePropertiesEx (large VM counts return a continuation token).
 */
/**
 * ServiceContent handshake: RetrieveServiceContent needs no auth and is the
 * authoritative source for every manager moref (sessionManager, root folder,
 * property collector, view/event managers) — never hardcode those IDs.
 */
async function getServiceContent(vc) {
  const sc = await soapCall(vc, '<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>');
  const rv = sc.body?.RetrieveServiceContentResponse?.returnval;
  if (!rv) throw new Error('RetrieveServiceContent returned no service content');
  const aboutRaw = rv.about || {};
  return {
    sessionManager: flat(rv.sessionManager) != null ? String(flat(rv.sessionManager)) : 'SessionManager',
    propertyCollector: flat(rv.propertyCollector) != null ? String(flat(rv.propertyCollector)) : 'propertyCollector',
    viewManager: flat(rv.viewManager) != null ? String(flat(rv.viewManager)) : 'ViewManager',
    rootFolder: flat(rv.rootFolder) != null ? String(flat(rv.rootFolder)) : 'group-d1',
    eventManager: flat(rv.eventManager) != null ? String(flat(rv.eventManager)) : 'EventManager',
    about: { fullName: flat(aboutRaw.fullName), version: flat(aboutRaw.version), build: flat(aboutRaw.build) },
  };
}

async function soapLogin(vc, sc) {
  const { password } = creds(vc);
  const login = await soapCall(vc, `
    <vim25:Login><vim25:_this type="SessionManager">${esc(sc.sessionManager)}</vim25:_this>
      <vim25:userName>${esc(vc.username)}</vim25:userName>
      <vim25:password>${esc(password)}</vim25:password>
    </vim25:Login>`);
  if (!login.setCookie) throw new Error('SOAP login returned no session cookie');
  return login.setCookie;
}

async function fetchInventorySoap(vc) {
  const sc = await getServiceContent(vc);
  const cookie = await soapLogin(vc, sc);
  try {
    const about = sc.about;

    const cv = await soapCall(vc, `
      <vim25:CreateContainerView><vim25:_this type="ViewManager">${esc(sc.viewManager)}</vim25:_this>
        <vim25:container type="Folder">${esc(sc.rootFolder)}</vim25:container>
        <vim25:type>HostSystem</vim25:type>
        <vim25:type>VirtualMachine</vim25:type>
        <vim25:type>Datastore</vim25:type>
        <vim25:type>DistributedVirtualSwitch</vim25:type>
        <vim25:type>DistributedVirtualPortgroup</vim25:type>
        <vim25:recursive>true</vim25:recursive>
      </vim25:CreateContainerView>`, cookie);
    const viewId = flat(cv.body?.CreateContainerViewResponse?.returnval);

    const propSetXml = (type, paths) => `
          <vim25:propSet>
            <vim25:type>${type}</vim25:type>
            ${paths.map(p => `<vim25:pathSet>${p}</vim25:pathSet>`).join('')}
          </vim25:propSet>`;
    const rp = await soapCall(vc, `
      <vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">${esc(sc.propertyCollector)}</vim25:_this>
        <vim25:specSet>
          ${propSetXml('HostSystem', HOST_PROPS)}
          ${propSetXml('VirtualMachine', VM_PROPS)}
          ${propSetXml('Datastore', ['name', 'browser', 'summary.accessible'])}
          ${propSetXml('DistributedVirtualSwitch', DVS_PROPS)}
          ${propSetXml('DistributedVirtualPortgroup', DVPG_PROPS)}
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
        <vim25:ContinueRetrievePropertiesEx><vim25:_this type="PropertyCollector">${esc(sc.propertyCollector)}</vim25:_this>
          <vim25:token>${esc(flat(result.token))}</vim25:token>
        </vim25:ContinueRetrievePropertiesEx>`, cookie);
      result = cont.body?.ContinueRetrievePropertiesExResponse?.returnval;
      objects = objects.concat(asArray(result?.objects));
    }

    const rows = objectsToProps(objects);
    const hostRows = rows.filter(r => r._type === 'HostSystem' || r['runtime.inMaintenanceMode'] !== undefined);
    const vmRows = rows.filter(r => r._type === 'VirtualMachine' || r['runtime.powerState'] !== undefined);
    const dsRows = rows.filter(r => r._type === 'Datastore');
    const dvsRows = rows.filter(r => r._type === 'DistributedVirtualSwitch' || r._type === 'VmwareDistributedVirtualSwitch');
    const dvpgRows = rows.filter(r => r._type === 'DistributedVirtualPortgroup');

    const hostsByName = new Map();
    const hostNameByMoref = new Map();
    const networks = [];
    for (const props of hostRows) {
      if (props.name == null) continue;
      const cores = Number(props['summary.hardware.numCpuCores']) || 0;
      const mhz = Number(props['summary.hardware.cpuMhz']) || 0;
      const services = vimArray(props['config.service.service'], 'HostService');
      const ssh = services.find(s => SSH_SERVICE_KEYS.has(String(flat(s.key))));
      hostNameByMoref.set(String(props._moref), String(props.name));
      hostsByName.set(String(props.name), {
        inMaintenance: String(props['runtime.inMaintenanceMode']) === 'true' ? 1 : 0,
        cpuMhzCapacity: cores * mhz || null,
        cpuCores: cores || null,
        cpuMhzUsed: props['summary.quickStats.overallCpuUsage'] != null ? Number(props['summary.quickStats.overallCpuUsage']) : null,
        memBytesCapacity: props['summary.hardware.memorySize'] != null ? Number(props['summary.hardware.memorySize']) : null,
        // quickStats memory usage is MB
        memBytesUsed: props['summary.quickStats.overallMemoryUsage'] != null ? Number(props['summary.quickStats.overallMemoryUsage']) * 1024 * 1024 : null,
        uptimeSeconds: num(props['summary.quickStats.uptime']),
        esxVersion: props['config.product.version'] ?? null,
        esxBuild: props['config.product.build'] ?? null,
        biosVersion: props['hardware.biosInfo.biosVersion'] ?? null,
        biosReleaseDate: props['hardware.biosInfo.releaseDate'] ?? null,
        vendor: props['hardware.systemInfo.vendor'] ?? null,
        model: props['hardware.systemInfo.model'] ?? null,
        ntpServers: stringList(props['config.dateTimeInfo.ntpConfig.server']),
        dnsServers: stringList(props['config.network.dnsConfig.address']),
        sshEnabled: ssh ? (String(flat(ssh.running)) === 'true' ? 1 : 0) : null,
      });
      networks.push(...parseHostNetworks(String(props.name), props));
    }

    // Distributed switches + portgroups are vCenter-scope rows (host_name NULL).
    const dvsNameByMoref = new Map();
    for (const d of dvsRows) {
      if (d.name == null) continue;
      dvsNameByMoref.set(String(d._moref), String(d.name));
      networks.push({
        hostName: null, kind: 'dvswitch', name: String(d.name),
        portCount: num(d['summary.portCount']),
        extra: { uuid: flat(d['summary.uuid']) ?? null },
      });
    }
    for (const g of dvpgRows) {
      if (g.name == null) continue;
      const portCfg = g['config.defaultPortConfig'];
      networks.push({
        hostName: null, kind: 'dvportgroup', name: String(g.name),
        switchName: dvsNameByMoref.get(String(flat(g['config.distributedVirtualSwitch']))) ?? null,
        vlanId: num(portCfg?.vlan?.vlanId),
      });
    }

    const referencedPaths = new Set();
    const vms = vmRows.filter(v => v.name != null).map(v => {
      for (const f of vimArray(v['layoutEx.file'], 'VirtualMachineFileLayoutExFileInfo')) {
        const p = flat(f.name);
        if (p) referencedPaths.add(String(p));
      }
      return {
        vmId: String(v._moref || ''),
        name: String(v.name),
        hostName: hostNameByMoref.get(String(v['runtime.host'])) || null,
        powerState: v['runtime.powerState'] ?? null,
        guestOs: v['config.guestFullName'] ?? null,
        cpuCount: v['summary.config.numCpu'] != null ? Number(v['summary.config.numCpu']) : null,
        memoryMb: v['summary.config.memorySizeMB'] != null ? Number(v['summary.config.memorySizeMB']) : null,
        ipAddress: v['guest.ipAddress'] ?? null,
        toolsStatus: v['guest.toolsRunningStatus'] ?? null,
        toolsVersion: v['guest.toolsVersion'] != null ? String(flat(v['guest.toolsVersion'])) : null,
        toolsVersionStatus: v['guest.toolsVersionStatus2'] ?? null,
        hwVersion: v['config.version'] ?? null,
      };
    });

    // Orphan sweep uses the same session; failures leave orphans = null so the
    // poller can tell "sweep unavailable" apart from "no orphans found".
    let orphans = null;
    try {
      const datastores = dsRows.map(d => ({
        name: String(d.name ?? ''), browser: d.browser != null ? String(flat(d.browser)) : null,
        accessible: String(flat(d['summary.accessible'])) !== 'false',
      })).filter(d => d.name);
      orphans = await collectOrphans(vc, cookie, sc, datastores, referencedPaths);
    } catch (err) {
      logger.debug(`[vcenterApi] orphan sweep failed for ${vc.name}: ${err.message}`);
    }

    return { about, hostsByName, vms, networks, orphans };
  } finally {
    soapCall(vc, '<vim25:Logout><vim25:_this type="SessionManager">${esc(sc.sessionManager)}</vim25:_this></vim25:Logout>', cookie)
      .catch(() => {});
  }
}

// Curated info-category event classes worth keeping (the full info stream on
// a busy vCenter is thousands of task/alarm rows a day).
const INFO_EVENT_TYPES = [
  'VmMigratedEvent', 'DrsVmMigratedEvent', 'VmRelocatedEvent', 'VmClonedEvent',
  'VmCreatedEvent', 'VmRemovedEvent', 'VmPoweredOnEvent', 'VmPoweredOffEvent', 'VmSuspendedEvent',
  'HostConnectedEvent', 'HostDisconnectedEvent',
  'EnteredMaintenanceModeEvent', 'ExitMaintenanceModeEvent',
];

/**
 * Native vSphere events since `sinceIso`: everything in the error and warning
 * categories plus a curated set of info events (migrations, power ops, host
 * connectivity, maintenance). Three QueryEvents calls in one SOAP session;
 * each returns up to vCenter's ~1000-event cap for the window.
 */
async function fetchEvents(vc, sinceIso) {
  const sc = await getServiceContent(vc);
  const cookie = await soapLogin(vc, sc);
  try {
    const query = async (filterXml) => {
      const r = await soapCall(vc, `
        <vim25:QueryEvents><vim25:_this type="EventManager">${esc(sc.eventManager)}</vim25:_this>
          <vim25:filter>
            <vim25:time><vim25:beginTime>${esc(sinceIso)}</vim25:beginTime></vim25:time>
            ${filterXml}
          </vim25:filter>
        </vim25:QueryEvents>`, cookie);
      return asArray(r.body?.QueryEventsResponse?.returnval);
    };

    const batches = [
      { severity: 'error', rows: await query('<vim25:category>error</vim25:category>') },
      { severity: 'warning', rows: await query('<vim25:category>warning</vim25:category>') },
      { severity: 'info', rows: await query(INFO_EVENT_TYPES.map(t => `<vim25:eventTypeId>${t}</vim25:eventTypeId>`).join('')) },
    ];

    const events = [];
    for (const { severity, rows } of batches) {
      for (const e of rows) {
        const key = num(e.key);
        if (key == null) continue;
        events.push({
          eventKey: key,
          eventType: e['@_type'] || e['@_xsi:type'] || null,
          severity,
          message: flat(e.fullFormattedMessage) != null ? String(flat(e.fullFormattedMessage)) : null,
          username: flat(e.userName) ? String(flat(e.userName)) : null,
          entityName: flat(e.vm?.name) ?? flat(e.host?.name) ?? flat(e.computeResource?.name) ?? flat(e.datacenter?.name) ?? null,
          createdAt: flat(e.createdTime) != null ? String(flat(e.createdTime)) : null,
        });
      }
    }
    return events;
  } finally {
    soapCall(vc, '<vim25:Logout><vim25:_this type="SessionManager">${esc(sc.sessionManager)}</vim25:_this></vim25:Logout>', cookie)
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
  fetchInventorySoap, fetchEvents, testConnection,
};
