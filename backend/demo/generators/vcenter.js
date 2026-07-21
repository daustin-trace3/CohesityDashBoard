// vCenter scope demo data: 8 registered vCenters with clusters, ESXi hosts
// (SOAP-enriched columns populated: maintenance, quickstats, ESX build, BIOS,
// vendor/model), VM guest inventory, datastores, TLS certs, and 30 days of
// per-vCenter snapshots. Includes deliberate trouble so the Overview issues
// panel demos every rule: an unreachable vCenter, a down host, a host in
// maintenance, datastores past 80%/90%, a tight cluster, an expiring cert.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

const SITES = ['nyc', 'lon', 'fra', 'sgp', 'syd', 'chi', 'dal', 'tor'];
const VC_VERSIONS = [
  { version: '8.0.3', build: '24322831', product: 'VMware vCenter Server' },
  { version: '8.0.2', build: '23319993', product: 'VMware vCenter Server' },
  { version: '7.0.3', build: '22837322', product: 'VMware vCenter Server' },
];
const ESX_VERSIONS = [
  { version: '8.0.3', build: '24280767' },
  { version: '8.0.2', build: '23305546' },
  { version: '7.0.3', build: '23794027' },
];
const HARDWARE = [
  { vendor: 'HPE', model: 'ProLiant DL380 Gen11', bios: 'U54 v2.16', biosDate: '2025-11-04' },
  { vendor: 'Dell Inc.', model: 'PowerEdge R760', bios: '2.4.4', biosDate: '2025-09-18' },
  { vendor: 'Cisco Systems Inc', model: 'UCSC-C240-M7SX', bios: 'C240M7.4.3.4a', biosDate: '2025-08-22' },
  { vendor: 'Lenovo', model: 'ThinkSystem SR650 V3', bios: 'ESE122N-3.22', biosDate: '2025-10-12' },
];
const GUEST_OS = [
  'Microsoft Windows Server 2022 (64-bit)',
  'Microsoft Windows Server 2019 (64-bit)',
  'Ubuntu Linux (64-bit)',
  'Red Hat Enterprise Linux 9 (64-bit)',
  'Red Hat Enterprise Linux 8 (64-bit)',
  'SUSE Linux Enterprise 15 (64-bit)',
  'CentOS 7 (64-bit)',
  'Other Linux (64-bit)',
];
const VM_ROLES = ['app', 'db', 'web', 'dc', 'file', 'mon', 'ci', 'jump'];

function seedVcenter(db, { now, encrypt }) {
  const nowIso = new Date(now).toISOString();

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_vcenter_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const insertVc = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, ssl_verify,
      polling_interval_minutes, last_poll_status, last_poll_error, last_poll_at,
      version, build, product_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 15, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHost = db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state,
      power_state, in_maintenance, vm_count, cpu_mhz_capacity, cpu_mhz_used,
      mem_bytes_capacity, mem_bytes_used, esx_version, esx_build, bios_version,
      bios_release_date, vendor, model, captured_at)
    VALUES (?, ?, ?, ?, ?, 'POWERED_ON', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCluster = db.prepare(`
    INSERT INTO vcenter_clusters (vcenter_id, cluster_id, name, drs_enabled, ha_enabled,
      host_count, vm_count, cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used, captured_at)
    VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDs = db.prepare(`
    INSERT INTO vcenter_datastores (vcenter_id, datastore_id, name, ds_type,
      capacity_bytes, free_bytes, accessible, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const insertCert = db.prepare(`
    INSERT INTO vcenter_certs (vcenter_id, cert_type, subject, issuer, valid_from, valid_to, captured_at)
    VALUES (?, 'vcenter-tls', ?, ?, ?, ?, ?)
  `);
  const insertVm = db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state,
      guest_os, cpu_count, memory_mb, ip_address, tools_status, hw_version, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSnap = db.prepare(`
    INSERT INTO vcenter_metrics_history (vcenter_id, captured_at, hosts_total, hosts_connected,
      hosts_maintenance, vms_total, datastore_capacity_bytes, datastore_free_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const GIB = 1024 ** 3;
  let hostTotal = 0, vmTotal = 0, dsTotal = 0, clusterTotal = 0;

  SITES.forEach((site, vcIdx) => {
    const vcName = `${site}-vc-prd-01`;
    const rng = rngFor(vcName);
    const vcVer = vcIdx < 5 ? VC_VERSIONS[0] : pick(rng, VC_VERSIONS);
    // tor is the demo "unreachable vCenter": poll fails, stale inventory remains.
    const unreachable = site === 'tor';
    insertVc.run(
      vcName, `vcsa.${site}.icc.demo`, 'administrator@vsphere.local',
      encrypt(JSON.stringify({ password: 'demo-not-real' })),
      unreachable ? 'error' : 'success',
      unreachable ? 'connect ETIMEDOUT 10.94.0.10:443' : null,
      new Date(now - (unreachable ? 130 : randInt(rng, 2, 14)) * 60000).toISOString(),
      vcVer.version, vcVer.build, vcVer.product, nowIso, nowIso
    );
    const vcId = db.prepare('SELECT id FROM vcenter_vcenters WHERE name = ?').get(vcName).id;

    // Certs: syd expires soon (warning); the rest are comfortably out.
    const certDays = site === 'syd' ? 21 : randInt(rng, 180, 700);
    insertCert.run(vcId,
      `CN=vcsa.${site}.icc.demo, O=ICC Demo, C=US`,
      'CN=CA, DC=vsphere, DC=local',
      new Date(now - 700 * 86400000).toISOString(),
      new Date(now + certDays * 86400000).toISOString(), nowIso);

    const clusterCount = randInt(rng, 2, 3);
    let vcVmCount = 0, vcHosts = [];
    for (let c = 1; c <= clusterCount; c++) {
      const clusterName = `${site}-cl-${String(c).padStart(2, '0')}`;
      const hw = HARDWARE[(vcIdx + c) % HARDWARE.length];
      const esx = vcVer.version.startsWith('7') ? ESX_VERSIONS[2] : ESX_VERSIONS[(vcIdx + c) % 2];
      const hostCount = randInt(rng, 4, 6);
      // fra-cl-01 runs hot on memory to trip the <20% headroom warning.
      const tight = site === 'fra' && c === 1;
      let clCpuCap = 0, clCpuUsed = 0, clMemCap = 0, clMemUsed = 0, clVms = 0;

      for (let h = 1; h <= hostCount; h++) {
        const hostName = `${site}-esx-${String(c).padStart(2, '0')}${String(h).padStart(2, '0')}.icc.demo`;
        // One down host (lon) and one maintenance host (nyc) for the issues feed.
        const down = site === 'lon' && c === 1 && h === hostCount;
        const maintenance = !down && site === 'nyc' && c === 1 && h === hostCount;
        const cpuCap = 2 * 24 * 2400; // 2 sockets × 24 cores × 2.4 GHz, in MHz
        const memCap = pick(rng, [512, 768, 1024]) * GIB;
        const usedFrac = tight ? randFloat(rng, 0.82, 0.9, 2) : randFloat(rng, 0.35, 0.7, 2);
        const cpuUsed = down ? null : Math.round(cpuCap * usedFrac * randFloat(rng, 0.7, 0.95, 2));
        const memUsed = down ? null : Math.round(memCap * usedFrac);
        const hostVms = down || maintenance ? (down ? 0 : randInt(rng, 2, 5)) : randInt(rng, 10, 22);

        insertHost.run(vcId, `host-${vcIdx}${c}${h}`, hostName, clusterName,
          down ? 'NOT_RESPONDING' : 'CONNECTED', maintenance ? 1 : 0, hostVms,
          cpuCap, cpuUsed, memCap, memUsed,
          esx.version, esx.build, hw.bios, hw.biosDate, hw.vendor, hw.model, nowIso);
        hostTotal++;
        vcHosts.push({ down, maintenance });
        clCpuCap += cpuCap; clCpuUsed += cpuUsed || 0;
        clMemCap += memCap; clMemUsed += memUsed || 0;
        clVms += hostVms;

        for (let v = 1; v <= hostVms; v++) {
          const role = pick(rng, VM_ROLES);
          const poweredOn = chance(rng, 0.9);
          const guestOs = pick(rng, GUEST_OS);
          insertVm.run(vcId, `vm-${vcIdx}${c}${h}-${v}`,
            `${site}-${role}-${String(c).padStart(2, '0')}${String(h)}${String(v).padStart(2, '0')}`,
            hostName, clusterName, poweredOn ? 'POWERED_ON' : 'POWERED_OFF',
            guestOs, pick(rng, [2, 2, 4, 4, 8, 16]), pick(rng, [4, 8, 8, 16, 32, 64]) * 1024,
            poweredOn ? `10.${100 + vcIdx}.${c * 10 + h}.${v + 10}` : null,
            poweredOn ? 'guestToolsRunning' : 'guestToolsNotRunning',
            'vmx-20', nowIso);
          vmTotal++;
        }
      }
      insertCluster.run(vcId, `domain-c${vcIdx}${c}`, clusterName, hostCount, clVms,
        clCpuCap, clCpuUsed, clMemCap, clMemUsed, nowIso);
      clusterTotal++;
      vcVmCount += clVms;
    }

    // Datastores: 5-8 per vCenter; sgp carries the 80%/90% usage offenders.
    const dsCount = randInt(rng, 5, 8);
    let dsCap = 0, dsFree = 0;
    for (let d = 1; d <= dsCount; d++) {
      const name = `${site}-ds-${d === dsCount ? 'nfs' : 'vmfs'}-${String(d).padStart(2, '0')}`;
      const capacity = pick(rng, [20, 40, 60, 100]) * 1024 * GIB; // 20–100 TiB in bytes
      let usedPct = randFloat(rng, 0.35, 0.72, 2);
      if (site === 'sgp' && d === 1) usedPct = 0.86;
      if (site === 'sgp' && d === 2) usedPct = 0.93;
      const free = Math.round(capacity * (1 - usedPct));
      insertDs.run(vcId, `datastore-${vcIdx}${d}`, name, d === dsCount ? 'NFS' : 'VMFS',
        Math.round(capacity), free, nowIso);
      dsCap += capacity; dsFree += free;
      dsTotal++;
    }

    // 30 days of daily snapshots; VM counts climb ~8% into today's total.
    const hostsConn = vcHosts.filter(x => !x.down).length;
    const hostsMaint = vcHosts.filter(x => x.maintenance).length;
    for (let i = 30; i >= 0; i--) {
      const growth = 0.92 + ((30 - i) / 30) * 0.08;
      insertSnap.run(vcId, new Date(now - i * 86400000).toISOString(),
        vcHosts.length, hostsConn, hostsMaint,
        Math.round(vcVmCount * growth) + randInt(rng, -3, 3),
        Math.round(dsCap), Math.round(dsFree * (2 - growth)));
    }
  });

  return { vcenters: SITES.length, clusters: clusterTotal, hosts: hostTotal, vms: vmTotal, datastores: dsTotal };
}

module.exports = { seedVcenter };
