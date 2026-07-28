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
const NTP_BASELINE = ['0.pool.ntp.icc.demo', '1.pool.ntp.icc.demo'];
const DNS_BASELINE = ['10.0.10.53', '10.0.11.53'];
const TOOLS_VERSIONS = { current: '12352', old: ['11365', '11269', '10346'] };
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
      bios_release_date, vendor, model, cpu_cores, ntp_servers, dns_servers,
      ssh_enabled, uptime_seconds, captured_at)
    VALUES (?, ?, ?, ?, ?, 'POWERED_ON', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertNetwork = db.prepare(`
    INSERT INTO vcenter_networks (vcenter_id, host_name, kind, name, switch_name, vlan_id,
      speed_mbps, mac, ip_address, netmask, mtu, uplinks, port_count, extra, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrphan = db.prepare(`
    INSERT INTO vcenter_orphaned_vmdks (vcenter_id, datastore_name, path, size_bytes, modified_at, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
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
      guest_os, cpu_count, memory_mb, ip_address, tools_status, hw_version,
      tools_version, tools_version_status, networks, datastores, tags, guest_nics,
      uptime_seconds, storage_committed_bytes, annotation,
      cpu_usage_mhz, mem_usage_mb, overall_status, guest_hostname, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSnap = db.prepare(`
    INSERT INTO vcenter_metrics_history (vcenter_id, captured_at, hosts_total, hosts_connected,
      hosts_maintenance, vms_total, datastore_capacity_bytes, datastore_free_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const GIB = 1024 ** 3;
  const role4 = (rng) => pick(rng, VM_ROLES);
  let hostTotal = 0, vmTotal = 0, dsTotal = 0, clusterTotal = 0, orphanTotal = 0;

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

        // Deliberate cluster drift (Governance page): one dal host on stale
        // NTP, one chi host on an older ESX build + BIOS, one fra host with
        // SSH left enabled against a disabled baseline.
        const ntpDrift = site === 'dal' && c === 1 && h === 2;
        const buildDrift = site === 'chi' && c === 1 && h === 3;
        const sshDrift = site === 'fra' && c === 2 && h === 1;
        const hostEsx = buildDrift ? ESX_VERSIONS[2] : esx;
        insertHost.run(vcId, `host-${vcIdx}${c}${h}`, hostName, clusterName,
          down ? 'NOT_RESPONDING' : 'CONNECTED', maintenance ? 1 : 0, hostVms,
          cpuCap, cpuUsed, memCap, memUsed,
          hostEsx.version, hostEsx.build,
          buildDrift ? '2.1.8' : hw.bios, hw.biosDate, hw.vendor, hw.model,
          48, JSON.stringify(ntpDrift ? ['10.9.9.9'] : NTP_BASELINE), JSON.stringify(DNS_BASELINE),
          sshDrift ? 1 : 0, down ? null : randInt(rng, 5, 400) * 86400, nowIso);
        hostTotal++;

        // Host networking: 4 pnics, vSwitch0, standard portgroups, vmk0/vmk1.
        for (let p = 0; p < 4; p++) {
          insertNetwork.run(vcId, hostName, 'pnic', `vmnic${p}`, null, null,
            p < 2 ? 25000 : 10000, `00:50:56:${String(vcIdx).padStart(2, '0')}:${String(c * 10 + h).padStart(2, '0')}:${String(p).padStart(2, '0')}`,
            null, null, null, null, null,
            JSON.stringify({ driver: p < 2 ? 'i40en' : 'ixgben', linkUp: !down }), nowIso);
        }
        insertNetwork.run(vcId, hostName, 'vswitch', 'vSwitch0', null, null, null, null, null, null,
          1500, JSON.stringify(['vmnic2', 'vmnic3']), 128, null, nowIso);
        insertNetwork.run(vcId, hostName, 'portgroup', 'Management Network', 'vSwitch0', 0, null, null, null, null, null, null, null, null, nowIso);
        insertNetwork.run(vcId, hostName, 'portgroup', 'vMotion', 'vSwitch0', 1160 + vcIdx, null, null, null, null, null, null, null, null, nowIso);
        insertNetwork.run(vcId, hostName, 'vmkernel', 'vmk0', 'Management Network', null, null, null,
          `10.${100 + vcIdx}.${c * 10 + h}.5`, '255.255.255.0', 1500, null, null, JSON.stringify({ dhcp: false }), nowIso);
        insertNetwork.run(vcId, hostName, 'vmkernel', 'vmk1', 'vMotion', null, null, null,
          `10.${140 + vcIdx}.${c * 10 + h}.5`, '255.255.255.0', 9000, null, null, JSON.stringify({ dhcp: false }), nowIso);
        vcHosts.push({ down, maintenance });
        clCpuCap += cpuCap; clCpuUsed += cpuUsed || 0;
        clMemCap += memCap; clMemUsed += memUsed || 0;
        clVms += hostVms;

        for (let v = 1; v <= hostVms; v++) {
          const role = pick(rng, VM_ROLES);
          const poweredOn = chance(rng, 0.9);
          const guestOs = pick(rng, GUEST_OS);
          // ~8% of VMs run outdated Tools so Governance has action items.
          const outdated = chance(rng, 0.08);
          const ip = poweredOn ? `10.${100 + vcIdx}.${c * 10 + h}.${v + 10}` : null;
          // Role-based portgroup membership (names match the seeded dvportgroups)
          // + 1-2 vmfs datastores that always exist for this vCenter.
          const vmNetworks = [role === 'db' ? 'dvpg-db-110' : role === 'web' ? 'dvpg-web-120' : 'dvpg-prod-100'];
          if (chance(rng, 0.25)) vmNetworks.push('dvpg-backup-310');
          const vmDatastores = [`${site}-ds-vmfs-${String(1 + (v % 3)).padStart(2, '0')}`];
          if (chance(rng, 0.3)) vmDatastores.push(`${site}-ds-vmfs-${String(1 + ((v + 1) % 3)).padStart(2, '0')}`);
          const vmTags = [
            chance(rng, 0.8) ? 'Environment: Production' : 'Environment: Dev',
            `App: ${role.toUpperCase()}`,
          ];
          if (chance(rng, 0.5)) vmTags.push('Backup: Protected');
          const mac = `00:50:56:${String(80 + vcIdx).padStart(2, '0')}:${String(c * 10 + h).padStart(2, '0')}:${String(v).padStart(2, '0')}`;
          const vmName = `${site}-${role}-${String(c).padStart(2, '0')}${String(h)}${String(v).padStart(2, '0')}`;
          const vmCpus = pick(rng, [2, 2, 4, 4, 8, 16]);
          const vmMemMb = pick(rng, [4, 8, 8, 16, 32, 64]) * 1024;
          // quickstats: mostly moderate load, ~4% hot VMs; per-core = 2400 MHz (host cpuCap/48)
          const hot = poweredOn && chance(rng, 0.04);
          const cpuPct = poweredOn ? (hot ? randInt(rng, 88, 98) : randInt(rng, 2, 60)) : null;
          const memPct = poweredOn ? (hot ? randInt(rng, 85, 97) : randInt(rng, 20, 75)) : null;
          insertVm.run(vcId, `vm-${vcIdx}${c}${h}-${v}`,
            vmName,
            hostName, clusterName, poweredOn ? 'POWERED_ON' : 'POWERED_OFF',
            guestOs, vmCpus, vmMemMb,
            ip,
            poweredOn ? 'guestToolsRunning' : 'guestToolsNotRunning',
            'vmx-20',
            outdated ? pick(rng, TOOLS_VERSIONS.old) : TOOLS_VERSIONS.current,
            outdated ? 'guestToolsNeedUpgrade' : (chance(rng, 0.05) ? 'guestToolsUnmanaged' : 'guestToolsCurrent'),
            JSON.stringify(vmNetworks), JSON.stringify(vmDatastores), JSON.stringify(vmTags),
            JSON.stringify([{ network: vmNetworks[0], mac, connected: poweredOn, ips: ip ? [ip] : [] }]),
            poweredOn ? randInt(rng, 3600, 300 * 86400) : null,
            randInt(rng, 20, 800) * GIB,
            chance(rng, 0.15) ? 'Provisioned by the ICC pipeline — contact platform-eng before resizing.' : null,
            cpuPct != null ? Math.round((cpuPct / 100) * 2400 * vmCpus) : null,
            memPct != null ? Math.round((memPct / 100) * vmMemMb) : null,
            poweredOn ? (down ? 'gray' : hot ? 'yellow' : chance(rng, 0.02) ? 'yellow' : 'green') : 'gray',
            poweredOn ? `${vmName}.icc.demo` : null,
            nowIso);
          vmTotal++;
          // Server 360 demo coherence: the first three nyc VMs (whose IPs are
          // seeded as NetApp NFS/SMB clients and vRA resource IPs) also get a
          // protected Cohesity object so every panel of the view lights up.
          if (site === 'nyc' && c === 1 && h === 1 && v <= 3) {
            const cohesityCluster = db.prepare("SELECT id FROM clusters WHERE name LIKE 'nyc%' ORDER BY id LIMIT 1").get()
              || db.prepare('SELECT id FROM clusters ORDER BY id LIMIT 1').get();
            if (cohesityCluster) {
              db.prepare(`
                INSERT INTO cohesity_objects (cluster_id, object_id, global_id, name, source_name,
                  environment, object_type, os_type, logical_bytes, is_protected,
                  protection_groups, policy_names, last_backup_status, sla_violated, last_backup_ms, captured_at)
                VALUES (?, ?, ?, ?, 'vc-nyc.icc.demo', 'VMware', 'VirtualMachine', ?, ?, 1, ?, ?, 'Succeeded', 0, ?, ?)
              `).run(cohesityCluster.id, 90000 + v, `demo:s360:${v}`, vmName,
                guestOs?.includes('Windows') ? 'Windows' : 'Linux',
                randInt(rng, 40, 400) * 1e9,
                JSON.stringify(['VMware_Protect_1']), JSON.stringify(['nyc-vmware-daily']),
                now - randInt(rng, 4, 20) * 3600000, nowIso);
            }
          }
        }
      }
      insertCluster.run(vcId, `domain-c${vcIdx}${c}`, clusterName, hostCount, clVms,
        clCpuCap, clCpuUsed, clMemCap, clMemUsed, nowIso);
      clusterTotal++;
      vcVmCount += clVms;
    }

    // Aria suite appliance VMs on nyc — feed the Aria "Appliances" page:
    // vra-prod/vra-dr match the seeded aria_instances hosts by guest hostname,
    // the rest are found by the suite name-pattern sweep.
    if (site === 'nyc') {
      const suite = [
        { name: 'vra-prod', ghost: 'vra-prod.demo.local', cpus: 12, memGb: 48, cpuPct: 35, memPct: 62, status: 'green' },
        { name: 'vra-dr', ghost: 'vra-dr.demo.local', cpus: 12, memGb: 48, cpuPct: 12, memPct: 55, status: 'green' },
        { name: 'vrops-nyc-01', ghost: 'vrops-nyc-01.icc.demo', cpus: 24, memGb: 128, cpuPct: 58, memPct: 71, status: 'green' },
        { name: 'vrli-nyc-01', ghost: 'vrli-nyc-01.icc.demo', cpus: 8, memGb: 16, cpuPct: 44, memPct: 86, status: 'yellow' },
        { name: 'vrlcm-nyc-01', ghost: 'vrlcm-nyc-01.icc.demo', cpus: 2, memGb: 6, cpuPct: 8, memPct: 40, status: 'green' },
        { name: 'vrni-nyc-01', ghost: 'vrni-nyc-01.icc.demo', cpus: 16, memGb: 64, cpuPct: 30, memPct: 52, status: 'green' },
      ];
      suite.forEach((s, i) => {
        insertVm.run(vcId, `vm-aria-${i}`, s.name, 'nyc-esx-0101.icc.demo', 'nyc-cl-01', 'POWERED_ON',
          'VMware Photon OS (64-bit)', s.cpus, s.memGb * 1024, `10.100.5.${20 + i}`,
          'guestToolsRunning', 'vmx-20', TOOLS_VERSIONS.current, 'guestToolsCurrent',
          JSON.stringify(['dvpg-prod-100']), JSON.stringify(['nyc-ds-vmfs-01']), JSON.stringify(['App: ARIA']),
          JSON.stringify([{ network: 'dvpg-prod-100', mac: `00:50:56:aa:00:0${i}`, connected: true, ips: [`10.100.5.${20 + i}`] }]),
          randInt(rng, 20, 120) * 86400, randInt(rng, 60, 200) * GIB, null,
          Math.round((s.cpuPct / 100) * 2400 * s.cpus), Math.round((s.memPct / 100) * s.memGb * 1024),
          s.status, s.ghost, nowIso);
        vmTotal++;
      });
      // Keep the VM-count tie (host vm_count sums must equal vcenter_vms rows).
      db.prepare('UPDATE vcenter_hosts SET vm_count = vm_count + ? WHERE vcenter_id = ? AND name = ?')
        .run(suite.length, vcId, 'nyc-esx-0101.icc.demo');
      db.prepare('UPDATE vcenter_clusters SET vm_count = vm_count + ? WHERE vcenter_id = ? AND name = ?')
        .run(suite.length, vcId, 'nyc-cl-01');
      vcVmCount += suite.length;
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

    // Distributed switch + portgroups (vCenter-wide rows, host_name NULL).
    insertNetwork.run(vcId, null, 'dvswitch', `${site}-dvs-01`, null, null, null, null, null, null,
      null, JSON.stringify(['vmnic0', 'vmnic1']), 512, JSON.stringify({ uuid: `50 2f ${vcIdx}0 de mo` }), nowIso);
    [['dvpg-prod', 100], ['dvpg-db', 110], ['dvpg-web', 120], ['dvpg-dmz', 200], ['dvpg-backup', 310]].forEach(([pg, vlan]) => {
      insertNetwork.run(vcId, null, 'dvportgroup', `${pg}-${vlan}`, `${site}-dvs-01`, vlan,
        null, null, null, null, null, null, null, null, nowIso);
    });

    // Orphaned VMDKs on a few sites so the card and Governance table have data.
    if (['nyc', 'sgp', 'chi'].includes(site)) {
      const orphanCount = randInt(rng, 2, 4);
      for (let o = 1; o <= orphanCount; o++) {
        insertOrphan.run(vcId, `${site}-ds-vmfs-01`,
          `[${site}-ds-vmfs-01] decommissioned/${site}-old-${role4(rng)}-${String(o).padStart(2, '0')}.vmdk`,
          randInt(rng, 20, 500) * GIB,
          new Date(now - randInt(rng, 60, 500) * 86400000).toISOString(), nowIso);
        orphanTotal++;
      }
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

  // ── Native vSphere events: ~50 per vCenter over the last 48h ────────────
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO vcenter_events (vcenter_id, event_key, event_type, severity, message, username, entity_name, created_at, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let eventTotal = 0;
  let eventKey = 100000;
  for (const vc of db.prepare('SELECT * FROM vcenter_vcenters').all()) {
    const rng = rngFor(`${vc.name}-events`);
    const vms = db.prepare('SELECT name, host_name FROM vcenter_vms WHERE vcenter_id = ?').all(vc.id);
    const hosts = db.prepare('SELECT name FROM vcenter_hosts WHERE vcenter_id = ?').all(vc.id).map(h => h.name);
    const unreachable = vc.last_poll_status === 'error';
    const count = randInt(rng, 40, 60);
    for (let i = 0; i < count; i++) {
      const at = new Date(now - randInt(rng, 2, 48 * 60) * 60000).toISOString();
      const vm = pick(rng, vms);
      const otherHost = pick(rng, hosts);
      const roll = rng();
      let type, severity, message, entity, user = null;
      if (unreachable && roll < 0.25) {
        type = 'HostConnectionLostEvent'; severity = 'error'; entity = pick(rng, hosts);
        message = `Connection to host ${entity} lost — cannot synchronize host state`;
      } else if (roll < 0.06) {
        type = 'VmFailedMigrateEvent'; severity = 'error'; entity = vm.name;
        message = `Cannot migrate ${vm.name} from ${vm.host_name} to ${otherHost}: insufficient resources`;
      } else if (roll < 0.16) {
        type = 'HostCnxFailedTimeoutEvent'; severity = 'warning'; entity = pick(rng, hosts);
        message = `Host ${entity} heartbeat delayed — connection retried successfully`;
      } else if (roll < 0.5) {
        type = chance(rng, 0.6) ? 'DrsVmMigratedEvent' : 'VmMigratedEvent'; severity = 'info'; entity = vm.name;
        user = type === 'VmMigratedEvent' ? 'ICC\\vsphere.admin' : null;
        message = `Migration of virtual machine ${vm.name} from ${vm.host_name} to ${otherHost} completed`;
      } else if (roll < 0.7) {
        const on = chance(rng, 0.6);
        type = on ? 'VmPoweredOnEvent' : 'VmPoweredOffEvent'; severity = 'info'; entity = vm.name;
        user = 'ICC\\vsphere.admin';
        message = `${vm.name} on host ${vm.host_name} is powered ${on ? 'on' : 'off'}`;
      } else if (roll < 0.82) {
        type = chance(rng, 0.5) ? 'VmCreatedEvent' : 'VmRemovedEvent'; severity = 'info'; entity = vm.name;
        user = 'ICC\\provisioning.svc';
        message = type === 'VmCreatedEvent'
          ? `Created virtual machine ${vm.name} on ${vm.host_name}`
          : `Removed virtual machine ${vm.name} from ${vm.host_name}`;
      } else {
        const entering = chance(rng, 0.5);
        type = entering ? 'EnteredMaintenanceModeEvent' : 'ExitMaintenanceModeEvent'; severity = 'info';
        entity = pick(rng, hosts); user = 'ICC\\vsphere.admin';
        message = `Host ${entity} has ${entering ? 'entered' : 'exited'} maintenance mode`;
      }
      insertEvent.run(vc.id, eventKey++, type, severity, message, user, entity, at, nowIso);
      eventTotal++;
    }
  }

  // ── Issue lifecycle history ─────────────────────────────────────────────
  // Open rows come from the REAL reconcile against the just-seeded inventory
  // (keys guaranteed to match computeIssues), then get backdated for realism;
  // a few resolved incidents are added by hand.
  const { reconcileIssueHistory } = require('../../services/vcenterIssues');
  reconcileIssueHistory();
  const histRng = rngFor('vcenter-issue-history');
  for (const row of db.prepare("SELECT id FROM vcenter_issue_history WHERE status = 'open'").all()) {
    const ageMin = randInt(histRng, 3 * 60, 6 * 24 * 60); // opened 3h–6d ago
    db.prepare(`
      UPDATE vcenter_issue_history SET first_seen = datetime('now', ?), last_seen = datetime('now', '-4 minutes') WHERE id = ?
    `).run(`-${ageMin} minutes`, row.id);
  }
  const insertResolved = db.prepare(`
    INSERT INTO vcenter_issue_history (issue_key, vcenter, severity, type, target, message, status, first_seen, last_seen, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, 'resolved', datetime('now', ?), datetime('now', ?), datetime('now', ?))
  `);
  const RESOLVED = [
    ['host-down|lon-vc-prd-01|lon-esx-0202.icc.demo', 'lon-vc-prd-01', 'critical', 'host-down', 'lon-esx-0202.icc.demo',
      'Host lon-esx-0202.icc.demo is not responding', 9 * 24 * 60, 51],
    ['vcenter-unreachable|syd-vc-prd-01|syd-vc-prd-01', 'syd-vc-prd-01', 'critical', 'vcenter-unreachable', 'syd-vc-prd-01',
      'vCenter syd-vc-prd-01 is unreachable: connect ETIMEDOUT', 6 * 24 * 60, 2 * 60 + 12],
    ['datastore-usage|nyc-vc-prd-01|nyc-ds-vmfs-02', 'nyc-vc-prd-01', 'warning', 'datastore-usage', 'nyc-ds-vmfs-02',
      'Datastore nyc-ds-vmfs-02 is 84.2% full', 14 * 24 * 60, 3 * 24 * 60],
    ['cluster-capacity|dal-vc-prd-01|dal-cl-01:memory', 'dal-vc-prd-01', 'warning', 'cluster-capacity', 'dal-cl-01:memory',
      'Cluster dal-cl-01 has 17.8% memory headroom left', 11 * 24 * 60, 26 * 60],
    ['host-maintenance|fra-vc-prd-01|fra-esx-0104.icc.demo', 'fra-vc-prd-01', 'info', 'host-maintenance', 'fra-esx-0104.icc.demo',
      'Host fra-esx-0104.icc.demo is in maintenance mode', 4 * 24 * 60, 5 * 60 + 40],
  ];
  for (const [key, vcName, sev, type, target, msg, openedMinAgo, durationMin] of RESOLVED) {
    const resolvedMinAgo = openedMinAgo - durationMin;
    insertResolved.run(key, vcName, sev, type, target, msg,
      `-${openedMinAgo} minutes`, `-${resolvedMinAgo} minutes`, `-${resolvedMinAgo} minutes`);
  }

  return {
    vcenters: SITES.length, clusters: clusterTotal, hosts: hostTotal, vms: vmTotal,
    datastores: dsTotal, orphans: orphanTotal, events: eventTotal,
    issueHistory: db.prepare('SELECT COUNT(*) n FROM vcenter_issue_history').get().n,
  };
}

module.exports = { seedVcenter };
