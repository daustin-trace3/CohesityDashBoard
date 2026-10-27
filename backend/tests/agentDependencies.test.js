import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const seed = require('./helpers/opsCorrelationSeed');
const deps = require('../services/agentDependencies');
const agent = require('../services/opsAgent');

const { db } = seed;

beforeEach(() => { seed.reset(); });

describe('agent dependencies', () => {
  it('agrees with the agent on what a host key is', () => {
    for (const h of ['ESX-01.lab.local', 'r740-07 (ABC1234)', '10.40.7.66', 'Web Check @ Phoenix', '']) {
      expect(deps.hostKey(h)).toBe(agent.hostKey(h));
    }
  });

  it('parentsOf lists the host and the datastores a VM sits on, host first', () => {
    seed.host('esx-01.lab.local');
    seed.datastore('DS-PROD-01');
    seed.vm('web01', { onHost: 'esx-01.lab.local', datastores: ['DS-PROD-01'] });
    const p = deps.parentsOf(db, 'web01.lab.local');
    expect(p.map((x) => x.kind)).toEqual(['host', 'datastore', 'source']);
    expect(p[0]).toMatchObject({ parent: 'esx-01.lab.local', parentKey: 'esx-01', platform: 'vcenter' });
    expect(p[1]).toMatchObject({ parent: 'DS-PROD-01', parentKey: 'ds-prod-01' });
    expect(deps.parentsOf(db, 'unknown-box')).toEqual([]);
  });

  it('tolerates a VM with no datastores and one with a non-JSON datastores column', () => {
    seed.vm('a1', { onHost: 'esx-01' });
    db.prepare("INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, datastores) VALUES (1, 'x', 'b1', 'esx-01', 'DS-A; DS-B')").run();
    expect(deps.parentsOf(db, 'a1').some((x) => x.kind === 'datastore')).toBe(false);
    expect(deps.parentsOf(db, 'b1').filter((x) => x.kind === 'datastore').map((x) => x.parent)).toEqual(['DS-A', 'DS-B']);
  });

  it('childrenOf(switch) comes from brocade_device_ports', () => {
    seed.brocadePort('esx-01', 'sw-core-1');
    seed.brocadePort('esx-02.lab.local', 'sw-core-1');
    seed.brocadePort('esx-03', 'sw-core-2');
    const kids = deps.childrenOf(db, 'SW-CORE-1', 'switch');
    expect(kids.map((k) => k.hostKey).sort()).toEqual(['esx-01', 'esx-02']);
    expect(kids[0]).toMatchObject({ platform: 'brocade', childKind: 'host' });
    expect(deps.isParent(db, 'switch', 'sw-core-2')).toBe(true);
    expect(deps.isParent(db, 'switch', 'sw-none')).toBe(false);
  });

  it('appsOn(host) finds the watched app services on its VMs', () => {
    seed.host('esx-01');
    seed.watch('aa001', 'AA-001', 'Payroll');
    seed.vm('pay01', { onHost: 'esx-01', tags: ['usage-id: aa001'] });
    seed.vm('pay02', { onHost: 'esx-01', tags: ['Usage-Id: AA001'] });
    seed.vm('other', { onHost: 'esx-01', tags: ['usage-id: aa999'] });   // not watched
    const apps = deps.appsOn(db, 'esx-01.lab.local', 'host');
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ usageId: 'aa001', displayId: 'AA-001', label: 'Payroll' });
    expect(apps[0].servers.sort()).toEqual(['pay01', 'pay02']);
  });

  it('downParentsStored reports an inaccessible datastore and a disconnected Zerto site', () => {
    seed.datastore('DS-GOOD', 1);
    seed.datastore('DS-BAD', 0);
    db.prepare("INSERT INTO zerto_sites (site_identifier, name, connection_status) VALUES ('s1', 'Phoenix', 'Connected'), ('s2', 'Dallas', 'Disconnected')").run();
    const down = deps.downParentsStored(db);
    expect(down.map((d) => `${d.kind}:${d.parent}`).sort()).toEqual(['datastore:DS-BAD', 'site:Dallas']);
    expect(down.every((d) => d.since === null)).toBe(true);
  });

  it('the index is rebuilt after a write', () => {
    seed.host('esx-01');
    seed.vm('web01', { onHost: 'esx-01' });
    expect(deps.parentsOf(db, 'web01').some((p) => p.parentKey === 'esx-01')).toBe(true);
    db.prepare("UPDATE vcenter_vms SET host_name = 'esx-09' WHERE name = 'web01'").run();
    expect(deps.parentsOf(db, 'web01').map((p) => p.parentKey)).toContain('esx-09');
    expect(deps.parentsOf(db, 'web01').map((p) => p.parentKey)).not.toContain('esx-01');
  });
});
