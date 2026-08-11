/**
 * Round-trip coverage for the non-Cohesity platform dictionary sources added
 * to anonymizer.js's loadDictionary() (Pure, NetApp, Zerto, vCenter, Dell,
 * Aria) plus the key-based whole-value masking (serial/service_tag -> SERIAL,
 * user/requested_by/created_by -> USER, wwn -> MAC) and the new SERIAL token
 * category. Requires ../db/database (see tests/setup.js for the per-file temp
 * DB) so every platform migration has already run by the time this file loads.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { createAnonymizer } = require('../services/anonymizer');

beforeAll(() => {
  // Pure
  db.prepare(`
    INSERT INTO pure_arrays (name, mgmt_host, client_id, key_id, username, encrypted_credentials)
    VALUES ('pure-array-alpha', '10.20.30.40', 'cid', 'kid', 'admin', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO pure_hosts (array_id, name) VALUES (1, 'esx-hostgroup-01')
  `).run();

  // NetApp
  db.prepare(`
    INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials)
    VALUES ('netapp-cluster-beta', 'netapp-mgmt.invalid', 'admin', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO netapp_svms (array_id, name) VALUES (1, 'svm-finance-01')
  `).run();

  // Zerto
  db.prepare(`
    INSERT INTO zerto_vpgs (vpg_identifier, name) VALUES ('vpg-1', 'vpg-payroll-replication')
  `).run();

  // vCenter
  db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials)
    VALUES ('vcenter-prod-gamma', 'vcsa.invalid', 'administrator@vsphere.local', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name) VALUES (1, 'host-1', 'esxi-rack3-node07')
  `).run();

  // Dell
  db.prepare(`
    INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials)
    VALUES ('dell-ome-delta', 'ome.invalid', 'admin', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO dell_devices (ome_id, device_id, name, service_tag) VALUES (1, 1001, 'poweredge-r740-04', 'ABC1234')
  `).run();

  // Aria
  db.prepare(`
    INSERT INTO aria_instances (name, host, username, encrypted_credentials)
    VALUES ('aria-vra-epsilon', 'aria.invalid', 'administrator', ?)
  `).run(encrypt(JSON.stringify({})));
  db.prepare(`
    INSERT INTO aria_deployments (instance_id, deployment_id, name, created_by)
    VALUES (1, 'dep-1', 'app-deployment-checkout', 'jdoe')
  `).run();

  // AWS
  db.prepare(`
    INSERT INTO aws_accounts (name, access_key_id) VALUES ('aws-account-lambda', 'AKIAEXAMPLE12345678')
  `).run();
  db.prepare(`
    INSERT INTO aws_ec2_instances (account_id, instance_id, name) VALUES (1, 'i-0abc123mu', 'ec2-webapp-mu')
  `).run();
  db.prepare(`
    INSERT INTO aws_lightsail_instances (account_id, name) VALUES (1, 'lightsail-node-nu')
  `).run();
  db.prepare(`
    INSERT INTO aws_ecs_clusters (account_id, cluster_arn, cluster_name) VALUES (1, 'arn:aws:ecs:cl-1', 'ecs-cluster-xi')
  `).run();
  db.prepare(`
    INSERT INTO aws_ecs_services (account_id, cluster_name, service_name) VALUES (1, 'ecs-cluster-xi', 'ecs-service-omicron')
  `).run();
  db.prepare(`
    INSERT INTO aws_s3_buckets (account_id, name) VALUES (1, 'bucket-reports-pi')
  `).run();
  db.prepare(`
    INSERT INTO aws_rds_instances (account_id, db_id) VALUES (1, 'rds-orders-rho')
  `).run();
  db.prepare(`
    INSERT INTO aws_lambda_functions (account_id, name) VALUES (1, 'lambda-invoice-sigma')
  `).run();
  db.prepare(`
    INSERT INTO aws_dynamo_tables (account_id, name) VALUES (1, 'dynamo-sessions-tau')
  `).run();
  db.prepare(`
    INSERT INTO aws_ecr_repos (account_id, name) VALUES (1, 'ecr-repo-upsilon')
  `).run();
  db.prepare(`
    INSERT INTO aws_vpcs (account_id, vpc_id, name) VALUES (1, 'vpc-0phichi', 'vpc-core-phi')
  `).run();
});

const SEEDED_NAMES = [
  'pure-array-alpha', 'esx-hostgroup-01',
  'netapp-cluster-beta', 'svm-finance-01',
  'vpg-payroll-replication',
  'vcenter-prod-gamma', 'esxi-rack3-node07',
  'dell-ome-delta', 'poweredge-r740-04',
  'aria-vra-epsilon', 'app-deployment-checkout',
  'aws-account-lambda', 'ec2-webapp-mu', 'lightsail-node-nu', 'ecs-cluster-xi',
  'ecs-service-omicron', 'bucket-reports-pi', 'rds-orders-rho', 'lambda-invoice-sigma',
  'dynamo-sessions-tau', 'ecr-repo-upsilon', 'vpc-core-phi',
];

describe('anonymizer platform coverage', () => {
  it('scrubs seeded platform names with zero leaks in a composed text blob', () => {
    const anon = createAnonymizer();
    const blob = SEEDED_NAMES.map((n) => `Alert regarding ${n} at 10.20.30.40`).join('. ');
    const out = anon.anonymize(blob);
    for (const name of SEEDED_NAMES) {
      expect(out).not.toContain(name);
    }
  });

  it('masks a service_tag value entirely with a SERIAL token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ service_tag: 'ABC1234' });
    expect(out.service_tag).toMatch(/^SERIAL-\d+$/);
    expect(out.service_tag).not.toContain('ABC1234');
  });

  it('masks a serial-keyed field entirely with a SERIAL token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ serial_number: 'SN-99887766' });
    expect(out.serial_number).toMatch(/^SERIAL-\d+$/);
  });

  it('masks a wwn-keyed field with a MAC token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ wwn: '52:4a:93:7a:00:01:02:03' });
    expect(out.wwn).toMatch(/^MAC-\d+$/);
  });

  it('masks user/created_by/requested_by keyed fields with a USER token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ username: 'jdoe', created_by: 'asmith', requested_by: 'bwhite' });
    expect(out.username).toMatch(/^USER-\d+$/);
    expect(out.created_by).toMatch(/^USER-\d+$/);
    expect(out.requested_by).toMatch(/^USER-\d+$/);
  });

  it('preserves version strings under a "version" key', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ version: '7.0.1.100' });
    expect(out.version).toBe('7.0.1.100');
  });

  it('preserves time-of-day strings that look like IPv6', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ duration: 'Started at 12:30:44 and finished later' });
    expect(out.duration).toContain('12:30:44');
  });

  it('restore() maps tokens back to originals, including a lowercased token', () => {
    const anon = createAnonymizer();
    const out = anon.anonymize({ name: 'pure-array-alpha' });
    const token = out.name;
    expect(token).toMatch(/^CLUSTER-\d+$/i);
    const restored = anon.restore(`Cluster ${token} and also ${token.toLowerCase()} had an issue.`);
    expect(restored).toContain('pure-array-alpha');
    expect(restored.match(/pure-array-alpha/g)).toHaveLength(2);
  });

  it('mappings() includes the expected categories after mixed use', () => {
    const anon = createAnonymizer();
    anon.anonymize({
      cluster: 'netapp-cluster-beta',
      service_tag: 'XYZ9999',
      wwn: '52:4a:93:7a:00:01:02:04',
      username: 'someuser',
    });
    const categories = new Set(anon.mappings().map((m) => m.token.split('-')[0]));
    expect(categories.has('CLUSTER')).toBe(true);
    expect(categories.has('SERIAL')).toBe(true);
    expect(categories.has('MAC')).toBe(true);
    expect(categories.has('USER')).toBe(true);
  });
});
