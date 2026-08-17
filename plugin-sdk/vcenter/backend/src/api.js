// vCenter API client. Inventory comes from the vSphere Automation REST API
// (vCenter 7.0U2+ /api paths, JSON). Two things the REST API still does not
// expose — host maintenance mode and host/cluster CPU+memory usage — are
// enriched best-effort from the classic SOAP API (/sdk) via a fixed
// ContainerView + RetrievePropertiesEx flow; when SOAP fails the REST
// inventory still lands and those columns stay NULL.
//
// DEVIATION FROM THE BUILT-IN (backend/services/vcenterApi.js): axios and
// fast-xml-parser are not available to a bundled plugin (esbuild resolves
// from plugin-sdk/, whose node_modules carries neither — see the conversion
// skill's sandbox-limits section). REST calls are re-implemented on Node's
// built-in `https` (dell/unifi backend/src/api.js's rawRequest pattern) and
// XML parsing on ./xml.js, a hand-rolled parser reproducing fast-xml-parser's
// default shape closely enough for every SOAP body this client touches.
// Every function threads `coreApi` through for decrypt/logging instead of
// requiring host modules directly. Behavior preserved verbatim: REST session
// tokens with a 25-min TTL, the SOAP ContainerView + RetrievePropertiesEx +
// ContinueRetrievePropertiesEx paging flow, per-type isolation so one bad
// property path can't blank the rest, the vim25 namespace-version handshake,
// SOAP fault parsing, the orphaned-VMDK datastore browse sweep, and
// ssl_verify -> rejectUnauthorized.
const https = require('https');
const { parseXml } = require('./xml');

const SESSION_TTL_MS = 25 * 60 * 1000;
const sessions = new Map(); // vc.id -> { token, fetchedAt }

function creds(vc, coreApi) {
  if (vc.password) return { username: vc.username, password: vc.password };
  const c = JSON.parse(coreApi.encryption.decrypt(vc.encrypted_credentials));
  return { username: vc.username, password: c.password };
}

/** Raw HTTPS call. Resolves { status, data, headers } where data is parsed
 *  JSON when the response looks like JSON, else the raw text body. Rejects
 *  with an Error carrying `.response = { status, data, headers }`. */
function rawRequest(vc, { method = 'GET', path, data, headers = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = data !== undefined ? (typeof data === 'string' ? data : JSON.stringify(data)) : undefined;
    const reqHeaders = { ...headers };
    if (body !== undefined) reqHeaders['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(
      {
        hostname: vc.host,
        port: vc.port || 443,
        path,
        method,
        timeout,
        rejectUnauthorized: !!vc.ssl_verify,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode;
          const str = raw.toString('utf8');
          const ct = String(res.headers['content-type'] || '');
          let payload = str;
          if (ct.includes('json') || (!ct && str.trim().startsWith('{')) || (!ct && str.trim().startsWith('['))) {
            try { payload = str ? JSON.parse(str) : null; } catch { payload = str || null; }
          }
          if (status >= 200 && status < 300) {
            resolve({ status, data: payload, headers: res.headers });
            return;
          }
          const e = new Error(`HTTP ${status}`);
          e.response = { status, data: payload, headers: res.headers };
          reject(e);
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function errMsg(err) {
  return err?.response?.data?.messages?.[0]?.default_message || err?.message || String(err);
}

// ── REST session ─────────────────────────────────────────────────────────────

/** REST session token (vmware-api-session-id), cached ~25 min per vCenter. */
async function getSession(vc, coreApi, force = false) {
  const cached = sessions.get(vc.id);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.token;
  const { username, password } = creds(vc, coreApi);
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  const { data } = await rawRequest(vc, {
    method: 'POST', path: '/api/session', headers: { Authorization: `Basic ${basic}` },
  });
  const token = typeof data === 'string' ? data : data?.value;
  if (!token) throw new Error('vCenter session login returned no token');
  sessions.set(vc.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateSession(vcId) {
  sessions.delete(vcId);
}

async function vGet(vc, coreApi, path, params = {}) {
  let token = await getSession(vc, coreApi);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const query = qs.toString();
  const reqPath = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
  const doGet = (t) => rawRequest(vc, { method: 'GET', path: reqPath, headers: { 'vmware-api-session-id': t } });
  try {
    const { data } = await doGet(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getSession(vc, coreApi, true);
      const { data } = await doGet(token);
      return data;
    }
    throw err;
  }
}

async function vPost(vc, coreApi, path, body, params = {}) {
  let token = await getSession(vc, coreApi);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const query = qs.toString();
  const reqPath = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
  const doPost = (t) => rawRequest(vc, {
    method: 'POST', path: reqPath, data: body,
    headers: { 'vmware-api-session-id': t, 'Content-Type': 'application/json' },
  });
  try {
    const { data } = await doPost(token);
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getSession(vc, coreApi, true);
      const { data } = await doPost(token);
      return data;
    }
    throw err;
  }
}

// Older vCenters wrap list responses in { value: [...] }.
const unwrap = (d) => (Array.isArray(d) ? d : (d?.value ?? []));

// ── REST inventory ───────────────────────────────────────────────────────────

const fetchClusters = async (vc, coreApi) => unwrap(await vGet(vc, coreApi, '/api/vcenter/cluster'));
const fetchHosts = async (vc, coreApi, clusterId = null) =>
  unwrap(await vGet(vc, coreApi, '/api/vcenter/host', clusterId ? { clusters: clusterId } : {}));
const fetchDatastores = async (vc, coreApi) => unwrap(await vGet(vc, coreApi, '/api/vcenter/datastore'));
const fetchVmsForHost = async (vc, coreApi, hostId) => unwrap(await vGet(vc, coreApi, '/api/vcenter/vm', { hosts: hostId }));

/**
 * vSphere Tags per VM via the cis tagging API: one batched
 * list-attached-tags-on-objects call per 500 VMs, tag ids resolved to
 * "Category: Name" once each. Returns Map(vmId -> [tagName...]). Best-effort —
 * callers treat a throw as "tags unavailable".
 */
async function fetchVmTags(vc, coreApi, vmIds) {
  const byVm = new Map();
  const tagIds = new Set();
  for (let i = 0; i < vmIds.length; i += 500) {
    const chunk = vmIds.slice(i, i + 500);
    const data = await vPost(vc, coreApi, '/api/cis/tagging/tag-association', {
      object_ids: chunk.map((id) => ({ id, type: 'VirtualMachine' })),
    }, { action: 'list-attached-tags-on-objects' });
    for (const row of unwrap(data)) {
      const vmId = row.object_id?.id;
      const ids = row.tag_ids || [];
      if (!vmId || !ids.length) continue;
      byVm.set(vmId, ids);
      for (const t of ids) tagIds.add(t);
    }
  }
  const tagNames = new Map();
  const catNames = new Map();
  for (const id of tagIds) {
    try {
      const tag = await vGet(vc, coreApi, `/api/cis/tagging/tag/${encodeURIComponent(id)}`);
      const t = tag?.value ?? tag;
      let cat = null;
      if (t?.category_id && !catNames.has(t.category_id)) {
        try {
          const c = await vGet(vc, coreApi, `/api/cis/tagging/category/${encodeURIComponent(t.category_id)}`);
          catNames.set(t.category_id, (c?.value ?? c)?.name ?? null);
        } catch { catNames.set(t.category_id, null); }
      }
      cat = t?.category_id ? catNames.get(t.category_id) : null;
      tagNames.set(id, t?.name ? (cat ? `${cat}: ${t.name}` : t.name) : null);
    } catch { tagNames.set(id, null); }
  }
  const out = new Map();
  for (const [vmId, ids] of byVm) {
    out.set(vmId, ids.map((id) => tagNames.get(id)).filter(Boolean));
  }
  return out;
}

/** vCenter machine TLS certificate (needs cert-management privilege; best-effort). */
async function fetchTlsCert(vc, coreApi) {
  const d = await vGet(vc, coreApi, '/api/vcenter/certificate-management/vcenter/tls');
  return d?.value ?? d ?? null;
}

// ── SOAP enrichment (maintenance mode + CPU/memory quickstats) ───────────────

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
async function soapVersion(vc, coreApi) {
  if (vimVersions.has(vc.host)) return vimVersions.get(vc.host);
  let version = '6.5'; // safe floor: every supported vCenter accepts it
  try {
    const { data } = await rawRequest(vc, { method: 'GET', path: '/sdk/vimServiceVersions.xml' });
    const parsed = parseXml(typeof data === 'string' ? data : '');
    const namespaces = asArray(parsed?.namespaces?.namespace);
    const vim25 = namespaces.find((n) => String(flat(n.name)) === 'urn:vim25');
    if (vim25?.version != null) version = String(flat(vim25.version));
  } catch (err) {
    coreApi.logger.debug(`[vcenterApi] version handshake failed for ${vc.host} (using urn:vim25/${version}): ${err.message}`);
  }
  vimVersions.set(vc.host, version);
  return version;
}

// vSphere returns SOAP faults WITH HTTP 500 — parse the fault body out of the
// error so callers see "ServerFaultCode: ..." instead of "HTTP 500".
function soapFaultMessage(err) {
  const raw = err?.response?.data;
  if (!raw || typeof raw !== 'string') return null;
  try {
    const fault = parseXml(raw)?.Envelope?.Body?.Fault;
    if (!fault) return null;
    const code = flat(fault.faultcode);
    const str = flat(fault.faultstring);
    let detailType = null;
    let detailName = null;
    if (fault.detail && typeof fault.detail === 'object') {
      detailType = Object.keys(fault.detail).find((k) => !k.startsWith('@_')) || null;
      const inner = detailType ? fault.detail[detailType] : null;
      if (inner && typeof inner === 'object') {
        detailName = flat(inner.name) ?? flat(inner.property) ?? flat(inner.argument) ?? null;
      }
    }
    const parts = [str || detailType || 'unknown'];
    if (detailName) parts.push(`(${detailName})`);
    return `SOAP fault${code ? ` [${code}]` : ''}: ${parts.join(' ')}`;
  } catch { return null; }
}

async function soapCall(vc, coreApi, body, cookie = null) {
  const version = await soapVersion(vc, coreApi);
  let data, headers;
  try {
    ({ data, headers } = await rawRequest(vc, {
      method: 'POST', path: '/sdk', data: envelope(body),
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `urn:vim25/${version}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }));
  } catch (err) {
    const fault = soapFaultMessage(err);
    if (fault) throw new Error(fault);
    throw err;
  }
  const parsed = parseXml(typeof data === 'string' ? data : '');
  const respBody = parsed?.Envelope?.Body;
  if (respBody?.Fault) {
    throw new Error(`SOAP fault: ${flat(respBody.Fault.faultstring) || 'unknown'}`);
  }
  const setCookieHeader = headers['set-cookie'];
  return { body: respBody, setCookie: Array.isArray(setCookieHeader) ? setCookieHeader[0]?.split(';')[0] || null : null };
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
  // Associations + detail (VM detail modal, portgroup/datastore VM counts)
  'network', 'datastore', 'guest.net',
  'summary.quickStats.uptimeSeconds', 'summary.storage.committed', 'config.annotation',
  // Performance/health quickstats + guest hostname (Aria appliance matching)
  'summary.quickStats.overallCpuUsage', 'summary.quickStats.guestMemoryUsage',
  'overallStatus', 'guest.hostName',
];
// NB: DVSSummary's port total is `numPorts` — requesting `summary.portCount`
// faults the WHOLE RetrievePropertiesEx call with InvalidProperty.
const DVS_PROPS = ['name', 'summary.numPorts', 'summary.uuid'];
const DVPG_PROPS = ['name', 'config.distributedVirtualSwitch', 'config.defaultPortConfig'];

const flat = (v) => ((v && typeof v === 'object' && '#text' in v) ? v['#text'] : v);

// SOAP reports vim25 enums (poweredOn); REST reports POWERED_ON. Store the
// REST style so SQL aggregations (overview power split, overcommit) match.
const POWER_STATES = { poweredOn: 'POWERED_ON', poweredOff: 'POWERED_OFF', suspended: 'SUSPENDED' };
const normalizePowerState = (v) => {
  const s = flat(v);
  return s == null ? null : (POWER_STATES[String(s)] || String(s));
};

function objectsToProps(objects) {
  return objects.map((obj) => {
    const props = { _moref: flat(obj.obj), _type: obj.obj?.['@_type'] };
    for (const p of asArray(obj.propSet)) props[p.name] = flat(p.val);
    return props;
  });
}

// vim25 array-of-X properties parse as { X: [...] } (or a single object).
const vimArray = (val, elementName) => asArray(val?.[elementName] ?? (elementName ? undefined : val));
// ArrayOfString parses as { string: [...] } — used by NTP/DNS server lists.
const stringList = (val) => asArray(val?.string ?? val).map(flat).filter((v) => v != null).map(String);
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
async function collectOrphans(vc, coreApi, cookie, sc, datastores, referencedPaths) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const allFiles = []; // { path, size, modified, datastoreName }
  for (const ds of datastores) {
    if (!ds.browser || ds.accessible === false) continue;
    try {
      const task = await soapCall(vc, coreApi, `
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
        const poll = await soapCall(vc, coreApi, `
          <vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">${esc(sc.propertyCollector)}</vim25:_this>
            <vim25:specSet>
              <vim25:propSet><vim25:type>Task</vim25:type><vim25:pathSet>info</vim25:pathSet></vim25:propSet>
              <vim25:objectSet><vim25:obj type="Task">${esc(taskMoref)}</vim25:obj></vim25:objectSet>
            </vim25:specSet>
            <vim25:options/>
          </vim25:RetrievePropertiesEx>`, cookie);
        const objs = asArray(poll.body?.RetrievePropertiesExResponse?.returnval?.objects);
        info = asArray(objs[0]?.propSet).find((p) => p.name === 'info')?.val || null;
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
      coreApi.logger.debug(`[vcenterApi] datastore browse failed for ${ds.name}: ${err.message}`);
    }
  }

  const isCompanion = (p) => /-(flat|delta|ctk|sesparse|rdmp?)\.vmdk$/i.test(p);
  const orphans = [];
  for (const f of allFiles) {
    if (isCompanion(f.path) || referencedPaths.has(f.path)) continue;
    const base = f.path.replace(/\.vmdk$/i, '');
    const chain = allFiles.filter((o) => o.path === f.path || (isCompanion(o.path) && o.path.startsWith(`${base}-`)));
    orphans.push({
      datastoreName: f.datastoreName, path: f.path,
      sizeBytes: chain.reduce((n, o) => n + (o.size || 0), 0),
      modifiedAt: f.modified,
    });
  }
  return orphans;
}

/**
 * ServiceContent handshake: RetrieveServiceContent needs no auth and is the
 * authoritative source for every manager moref (sessionManager, root folder,
 * property collector, view/event managers) — never hardcode those IDs.
 */
async function getServiceContent(vc, coreApi) {
  const sc = await soapCall(vc, coreApi, '<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>');
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

async function soapLogin(vc, coreApi, sc) {
  const { password } = creds(vc, coreApi);
  const login = await soapCall(vc, coreApi, `
    <vim25:Login><vim25:_this type="SessionManager">${esc(sc.sessionManager)}</vim25:_this>
      <vim25:userName>${esc(vc.username)}</vim25:userName>
      <vim25:password>${esc(password)}</vim25:password>
    </vim25:Login>`);
  if (!login.setCookie) throw new Error('SOAP login returned no session cookie');
  return login.setCookie;
}

async function fetchInventorySoap(vc, coreApi) {
  const sc = await getServiceContent(vc, coreApi);
  const cookie = await soapLogin(vc, coreApi, sc);
  try {
    const about = sc.about;

    const cv = await soapCall(vc, coreApi, `
      <vim25:CreateContainerView><vim25:_this type="ViewManager">${esc(sc.viewManager)}</vim25:_this>
        <vim25:container type="Folder">${esc(sc.rootFolder)}</vim25:container>
        <vim25:type>HostSystem</vim25:type>
        <vim25:type>VirtualMachine</vim25:type>
        <vim25:type>Datastore</vim25:type>
        <vim25:type>Network</vim25:type>
        <vim25:type>DistributedVirtualSwitch</vim25:type>
        <vim25:type>DistributedVirtualPortgroup</vim25:type>
        <vim25:recursive>true</vim25:recursive>
      </vim25:CreateContainerView>`, cookie);
    const viewId = flat(cv.body?.CreateContainerViewResponse?.returnval);

    // One RetrievePropertiesEx PER TYPE: an InvalidProperty fault aborts the
    // whole request it is in, so isolating the types means a bad path in the
    // DVS/portgroup/datastore extras can never blank hosts, VMs, CPU/memory
    // or guest detail. Hosts + VMs are required; the rest degrade gracefully.
    const retrieveType = async (type, paths) => {
      const rp = await soapCall(vc, coreApi, `
        <vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">${esc(sc.propertyCollector)}</vim25:_this>
          <vim25:specSet>
            <vim25:propSet>
              <vim25:type>${type}</vim25:type>
              ${paths.map((p) => `<vim25:pathSet>${p}</vim25:pathSet>`).join('')}
            </vim25:propSet>
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
      while (result?.token != null && String(flat(result.token)) !== '') {
        const cont = await soapCall(vc, coreApi, `
          <vim25:ContinueRetrievePropertiesEx><vim25:_this type="PropertyCollector">${esc(sc.propertyCollector)}</vim25:_this>
            <vim25:token>${esc(flat(result.token))}</vim25:token>
          </vim25:ContinueRetrievePropertiesEx>`, cookie);
        result = cont.body?.ContinueRetrievePropertiesExResponse?.returnval;
        objects = objects.concat(asArray(result?.objects));
      }
      return objectsToProps(objects);
    };
    const retrieveOptional = async (type, paths) => {
      try {
        return await retrieveType(type, paths);
      } catch (err) {
        coreApi.logger.warn(`[vcenterApi] ${vc.name}: ${type} retrieval failed (skipping): ${err.message}`);
        return [];
      }
    };

    const hostRows = await retrieveType('HostSystem', HOST_PROPS);
    const vmRows = await retrieveType('VirtualMachine', VM_PROPS);
    const dsRows = await retrieveOptional('Datastore', ['name', 'browser', 'summary.accessible']);
    // The Network container type covers DVPortgroups too — the name map below
    // resolves VM `network` morefs of either flavor.
    const netRows = await retrieveOptional('Network', ['name']);
    const dvsRows = await retrieveOptional('DistributedVirtualSwitch', DVS_PROPS);
    const dvpgRows = await retrieveOptional('DistributedVirtualPortgroup', DVPG_PROPS);

    const networkNameByMoref = new Map();
    for (const r of [...netRows, ...dvpgRows]) {
      if (r.name != null) networkNameByMoref.set(String(r._moref), String(r.name));
    }
    const dsNameByMoref = new Map();
    for (const r of dsRows) {
      if (r.name != null) dsNameByMoref.set(String(r._moref), String(r.name));
    }
    const morefList = (val) => vimArray(val, 'ManagedObjectReference').map(flat).filter((v) => v != null).map(String);

    const hostsByName = new Map();
    const hostNameByMoref = new Map();
    const networks = [];
    for (const props of hostRows) {
      if (props.name == null) continue;
      const cores = Number(props['summary.hardware.numCpuCores']) || 0;
      const mhz = Number(props['summary.hardware.cpuMhz']) || 0;
      const services = vimArray(props['config.service.service'], 'HostService');
      const ssh = services.find((s) => SSH_SERVICE_KEYS.has(String(flat(s.key))));
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
        portCount: num(d['summary.numPorts']),
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
    const vms = vmRows.filter((v) => v.name != null).map((v) => {
      for (const f of vimArray(v['layoutEx.file'], 'VirtualMachineFileLayoutExFileInfo')) {
        const p = flat(f.name);
        if (p) referencedPaths.add(String(p));
      }
      const networkMorefs = morefList(v.network);
      const guestNics = vimArray(v['guest.net'], 'GuestNicInfo').map((n) => ({
        network: flat(n.network) != null ? String(flat(n.network)) : null,
        mac: flat(n.macAddress) != null ? String(flat(n.macAddress)) : null,
        connected: String(flat(n.connected)) === 'true',
        ips: stringList(n.ipAddress),
      }));
      return {
        vmId: String(v._moref || ''),
        name: String(v.name),
        hostName: hostNameByMoref.get(String(v['runtime.host'])) || null,
        powerState: normalizePowerState(v['runtime.powerState']),
        guestOs: v['config.guestFullName'] ?? null,
        cpuCount: v['summary.config.numCpu'] != null ? Number(v['summary.config.numCpu']) : null,
        memoryMb: v['summary.config.memorySizeMB'] != null ? Number(v['summary.config.memorySizeMB']) : null,
        ipAddress: v['guest.ipAddress'] ?? null,
        toolsStatus: v['guest.toolsRunningStatus'] ?? null,
        toolsVersion: v['guest.toolsVersion'] != null ? String(flat(v['guest.toolsVersion'])) : null,
        toolsVersionStatus: v['guest.toolsVersionStatus2'] ?? null,
        hwVersion: v['config.version'] ?? null,
        networks: [...new Set(networkMorefs.map((m) => networkNameByMoref.get(m)).filter(Boolean))],
        datastores: [...new Set(morefList(v.datastore).map((m) => dsNameByMoref.get(m)).filter(Boolean))],
        guestNics,
        uptimeSeconds: num(v['summary.quickStats.uptimeSeconds']),
        storageCommittedBytes: num(v['summary.storage.committed']),
        annotation: flat(v['config.annotation']) != null ? String(flat(v['config.annotation'])).slice(0, 2000) : null,
        cpuUsageMhz: num(v['summary.quickStats.overallCpuUsage']),
        memUsageMb: num(v['summary.quickStats.guestMemoryUsage']),
        overallStatus: v.overallStatus != null ? String(flat(v.overallStatus)) : null,
        guestHostname: v['guest.hostName'] != null ? String(flat(v['guest.hostName'])) : null,
      };
    });

    // Orphan sweep uses the same session; failures leave orphans = null so the
    // poller can tell "sweep unavailable" apart from "no orphans found".
    let orphans = null;
    try {
      const datastores = dsRows.map((d) => ({
        name: String(d.name ?? ''), browser: d.browser != null ? String(flat(d.browser)) : null,
        accessible: String(flat(d['summary.accessible'])) !== 'false',
      })).filter((d) => d.name);
      orphans = await collectOrphans(vc, coreApi, cookie, sc, datastores, referencedPaths);
    } catch (err) {
      coreApi.logger.debug(`[vcenterApi] orphan sweep failed for ${vc.name}: ${err.message}`);
    }

    return { about, hostsByName, vms, networks, orphans };
  } finally {
    soapCall(vc, coreApi, `<vim25:Logout><vim25:_this type="SessionManager">${esc(sc.sessionManager)}</vim25:_this></vim25:Logout>`, cookie)
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
async function fetchEvents(vc, coreApi, sinceIso) {
  const sc = await getServiceContent(vc, coreApi);
  const cookie = await soapLogin(vc, coreApi, sc);
  try {
    const query = async (filterXml) => {
      const r = await soapCall(vc, coreApi, `
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
      { severity: 'info', rows: await query(INFO_EVENT_TYPES.map((t) => `<vim25:eventTypeId>${t}</vim25:eventTypeId>`).join('')) },
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
    soapCall(vc, coreApi, `<vim25:Logout><vim25:_this type="SessionManager">${esc(sc.sessionManager)}</vim25:_this></vim25:Logout>`, cookie)
      .catch(() => {});
  }
}

/** Validate a vCenter (saved row or unsaved candidate). Never throws. */
async function testConnection(vcLike, coreApi) {
  try {
    const probe = { id: `test-${vcLike.host}`, ...vcLike };
    const token = await getSession(probe, coreApi, true);
    const hosts = unwrap(await (async () => {
      const { data } = await rawRequest(probe, { method: 'GET', path: '/api/vcenter/host', headers: { 'vmware-api-session-id': token } });
      return data;
    })());
    sessions.delete(probe.id);
    return { ok: true, hosts: hosts.length };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the vCenter username and password.' : errMsg(err),
    };
  }
}

module.exports = {
  getSession, invalidateSession, vGet, unwrap,
  fetchClusters, fetchHosts, fetchDatastores, fetchVmsForHost, fetchTlsCert,
  fetchInventorySoap, fetchEvents, fetchVmTags, testConnection, errMsg,
};
