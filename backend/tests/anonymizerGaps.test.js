/**
 * Security audit fixes for anonymizer.js findings A1-A5:
 * A1: dictionary gaps (Dell service_tag, Brocade zones/zonesets, BlueCat configs/locations, App Services, AWS volumes)
 * A2: Dell service tag in prompts (noun template)
 * A3: regex fallbacks (WWN, AWS ARNs/accounts/resources, URL userinfo)
 * A4: scrubText forward-map replacement
 * A5: stringified JSON objects
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { createAnonymizer } = require('../services/anonymizer');

beforeAll(() => {
  // A1: Dictionary entries for Dell service_tag
  db.prepare(`
    INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials)
    VALUES ('dell-ome-test', 'ome.invalid', 'admin', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO dell_devices (ome_id, device_id, name, service_tag)
    VALUES (1, 1001, 'server-test', 'SVC-TAG-ALPHA')
  `).run();

  // A1: Brocade zones and zonesets
  db.prepare(`
    INSERT INTO brocade_sources (name, host, username, password_enc)
    VALUES ('brocade-test', 'sannav.invalid', 'admin', '')
  `).run();
  db.prepare(`
    INSERT INTO brocade_fabrics (source_id, name, active_zoneset_name)
    VALUES (1, 'fabric-prod', 'zoneset-active-alpha')
  `).run();
  db.prepare(`
    INSERT INTO brocade_zones (source_id, fabric_name, zone_name)
    VALUES (1, 'fabric-prod', 'zone-database-tier')
  `).run();

  // A1: BlueCat configuration names and block locations
  db.prepare(`
    INSERT INTO bluecat_sources (name, host, encrypted_credentials)
    VALUES ('bluecat-test', 'bam.invalid', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO bluecat_views (source_id, view_id, configuration_name)
    VALUES (1, 1, 'bluecat-config-main')
  `).run();
  db.prepare(`
    INSERT INTO bluecat_blocks (source_id, block_id, name, location_name)
    VALUES (1, 1, 'corp-block', 'office-manhattan')
  `).run();

  // A1: App Services labels and catalog
  db.prepare(`
    INSERT INTO app_service_watch (usage_id, display_id, label, created_at)
    VALUES ('app-001', 'app-prod-server', 'app-svc-monitoring-label', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO app_service_catalog (usage_id, atm_id, name, imported_at)
    VALUES ('app-002', 'ATM-99999', 'app-catalog-entry-name', datetime('now'))
  `).run();

  // A1: AWS EBS volumes
  db.prepare(`
    INSERT INTO aws_accounts (name, access_key_id) VALUES ('aws-test-account', 'AKIAEXAMPLE12345678')
  `).run();
  db.prepare(`
    INSERT INTO aws_ebs_volumes (account_id, volume_id)
    VALUES (1, 'vol-0ebsvolume123456')
  `).run();

  // A1: vCenter VM guest_hostname
  db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials)
    VALUES ('vcenter-test', 'vcsa.invalid', 'administrator@vsphere.local', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, guest_hostname)
    VALUES (1, 'vm-123', 'prod-web-server', 'web-guest-hostname')
  `).run();

  // Seed data for A5 JSON tests (used in dictionary lookup)
  db.prepare(`
    INSERT INTO pure_arrays (name, mgmt_host, client_id, key_id, username, encrypted_credentials)
    VALUES ('pure-array-alpha', '10.20.30.40', 'cid', 'kid', 'admin', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials)
    VALUES ('netapp-cluster-beta', 'netapp-mgmt.invalid', 'admin', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name) VALUES (1, 'host-1', 'esxi-rack3-node07')
  `).run();
});

describe('A1: anonymizer dictionary gaps', () => {
  it('tokenizes Dell service_tag from dell_devices table', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ service_tag: 'SVC-TAG-ALPHA' });
    expect(out.service_tag).toMatch(/^SERIAL-\d+$/);
    expect(out.service_tag).not.toContain('SVC-TAG-ALPHA');
  });

  it('tokenizes Brocade active_zoneset_name from brocade_fabrics', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Activated zoneset-active-alpha in the fabric');
    expect(out).not.toContain('zoneset-active-alpha');
    expect(out).toMatch(/TAG-\d+/);
  });

  it('tokenizes Brocade zone_name from brocade_zones', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Zone zone-database-tier contains members');
    expect(out).not.toContain('zone-database-tier');
  });

  it('tokenizes BlueCat configuration_name from bluecat_views', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Using configuration bluecat-config-main');
    expect(out).not.toContain('bluecat-config-main');
  });

  it('tokenizes BlueCat location_name from bluecat_blocks', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Block in location office-manhattan');
    expect(out).not.toContain('office-manhattan');
  });

  it('tokenizes app_service_watch.display_id', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Service app-prod-server is monitored');
    expect(out).not.toContain('app-prod-server');
  });

  it('tokenizes app_service_watch.label', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Label app-svc-monitoring-label assigned');
    expect(out).not.toContain('app-svc-monitoring-label');
  });

  it('tokenizes app_service_catalog.name', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Catalog entry app-catalog-entry-name');
    expect(out).not.toContain('app-catalog-entry-name');
  });

  it('tokenizes app_service_catalog.atm_id', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('ATM-99999 imported');
    expect(out).not.toContain('ATM-99999');
  });

  it('tokenizes AWS EBS volume_id', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Volume vol-0ebsvolume123456 attached');
    expect(out).not.toContain('vol-0ebsvolume123456');
  });

  it('tokenizes vCenter VM guest_hostname', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize('Guest hostname web-guest-hostname resolved');
    expect(out).not.toContain('web-guest-hostname');
  });
});

describe('A2: Dell service tag in prompt nouns', () => {
  it('scrubs seeded Dell service_tag inside descriptive text', () => {
    const anon = createAnonymizer();
    const text = 'device 360 analysis for service tag SVC-TAG-ALPHA regarding';
    const out = anon.anonymize(text);
    expect(out).not.toContain('SVC-TAG-ALPHA');
    expect(out).toMatch(/SERIAL-\d+/);
  });
});

describe('A3: regex fallbacks for identifiers', () => {
  it('tokenizes 8-octet WWN format (xx:xx:xx:xx:xx:xx:xx:xx)', () => {
    const anon = createAnonymizer();
    const wwn = '52:4a:93:7a:00:01:02:03';
    const out = anon.anonymize(`Device with WWN ${wwn} connected`);
    expect(out).not.toContain(wwn);
    expect(out).toMatch(/MAC-\d+/);
  });

  it('round-trips 8-octet WWN through restore', () => {
    const anon = createAnonymizer();
    const wwn = '52:4a:93:7a:00:01:02:03';
    const anonymized = anon.anonymize(`Storage at ${wwn}`);
    const restored = anon.restore(anonymized);
    expect(restored).toContain(wwn);
  });

  it('tokenizes AWS ARN format', () => {
    const anon = createAnonymizer();
    const arn = 'arn:aws:iam::123456789012:user/alice';
    const out = anon.anonymize(`Policy applied to ${arn}`);
    expect(out).not.toContain(arn);
  });

  it('tokenizes bare AWS account ID when preceded by account keyword', () => {
    const anon = createAnonymizer();
    const accountId = '123456789012';
    const out = anon.anonymize(`account ${accountId} in AWS`);
    expect(out).not.toContain(accountId);
  });

  it('tokenizes AWS resource IDs (i-, vol-, snap-, sg-, subnet-, vpc-, eni-, ami-)', () => {
    const anon = createAnonymizer();
    const resources = [
      'i-0abc123def456789a',
      'vol-0ebsvolume123456',
      'snap-0snapshotid12345',
      'sg-0securitygp123456',
      'subnet-0subnetid123456',
      'vpc-0vpcid1234567890',
      'eni-0eni1234567890abc',
      'ami-0amiid1234567890a',
    ];
    for (const res of resources) {
      const out = anon.anonymize(`Resource ${res} state`);
      expect(out).not.toContain(res);
    }
  });

  it('strips URL userinfo credentials', () => {
    const anon = createAnonymizer();
    const url = 'https://user:password@example.com/api';
    const out = anon.anonymize(`Connect to ${url}`);
    expect(out).not.toContain('password');
  });

  it('handles adversarial 200KB string with new regexes in under 500ms', () => {
    const anon = createAnonymizer();
    const adversarial = 'ARN: ' + 'arn:aws:service:region:123456789012:resource '.repeat(5000);
    const start = Date.now();
    const out = anon.anonymize(adversarial);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

describe('A4: scrubText forward-map replacement', () => {
  it('replaces a forward-mapped value when it reappears in free text', () => {
    const anon = createAnonymizer();
    anon.anonymize({ service_tag: 'SERIAL-TAG-ALPHA' });
    const text = `Later reference to SERIAL-TAG-ALPHA in alert`;
    const out = anon.anonymize(text);
    expect(out).not.toContain('SERIAL-TAG-ALPHA');
  });

  it('respects minimum length rule for forward-map replacement', () => {
    const anon = createAnonymizer();
    const text = 'Code: aa';
    const out = anon.anonymize(text);
    expect(out).toContain('aa');
  });

  it('longest-first replacement prevents prefix corruption', () => {
    const anon = createAnonymizer();
    anon.anonymize({ serial: 'ABC123' });
    anon.anonymize({ serial: 'ABC123EXTENDED' });
    const text = 'Found ABC123EXTENDED in the system';
    const out = anon.anonymize(text);
    expect(out).not.toContain('ABC123EXTENDED');
  });
});

describe('A5: stringified JSON in anonymizer walk', () => {
  it('anonymizes parsed JSON string values in object walk', () => {
    const anon = createAnonymizer();
    const obj = {
      summary: JSON.stringify({
        cluster: 'pure-array-alpha',
        status: 'online',
      }),
    };
    const out = anon.anonymize(obj);
    expect(out.summary).not.toContain('pure-array-alpha');
    expect(out.summary).toMatch(/CLUSTER-\d+/);
  });

  it('falls back to scrubText for truncated JSON', () => {
    const anon = createAnonymizer();
    const obj = {
      summary: '{"incomplete": "json without closing',
    };
    const out = anon.anonymize(obj);
    expect(out.summary).toBeDefined();
  });

  it('preserves non-JSON strings as-is', () => {
    const anon = createAnonymizer();
    const obj = {
      summary: 'This is plain text summary',
    };
    const out = anon.anonymize(obj);
    expect(out.summary).toBe('This is plain text summary');
  });

  it('anonymizes nested objects within JSON strings', () => {
    const anon = createAnonymizer();
    const complexJson = {
      summary: JSON.stringify({
        alerts: [
          { source: 'netapp-cluster-beta', level: 'critical' },
          { vm: 'esxi-rack3-node07', status: 'failed' },
        ],
      }),
    };
    const out = anon.anonymize(complexJson);
    expect(out.summary).not.toContain('netapp-cluster-beta');
    expect(out.summary).not.toContain('esxi-rack3-node07');
  });
});
