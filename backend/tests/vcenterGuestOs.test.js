import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseDetailed, classifyGuestOs, rollupGuestOs } = require('../services/vcenterGuestOs');

const WIN19 = "architecture='X86' bitness='64' buildNumber='17763' familyName='Windows' kernelVersion='10.0' prettyName='Windows Server 2019 Standard, 64-bit (Build 17763)'";
const RHEL94 = "architecture='X86' bitness='64' distroName='Red Hat Enterprise Linux' distroVersion='9.4' familyName='Linux' kernelVersion='5.14.0-427.13.1.el9_4.x86_64' prettyName='Red Hat Enterprise Linux 9.4 (Plow)'";

describe('parseDetailed', () => {
  it('reads key=value pairs with spaces, commas and parentheses', () => {
    const d = parseDetailed(WIN19);
    expect(d.buildNumber).toBe('17763');
    expect(d.prettyName).toBe('Windows Server 2019 Standard, 64-bit (Build 17763)');
  });
  it('returns {} for empty, null and malformed input', () => {
    expect(parseDetailed('')).toEqual({});
    expect(parseDetailed(null)).toEqual({});
    expect(parseDetailed(42)).toEqual({});
    expect(parseDetailed("garbage = = 'unterminated")).toEqual({});
  });
});

describe('classifyGuestOs', () => {
  it('Windows Server from detailed data', () => {
    const c = classifyGuestOs({ guest_detailed: WIN19, guest_os: 'Microsoft Windows Server 2016 (64-bit)' });
    expect(c).toMatchObject({
      family: 'windows', vendor: 'Microsoft', product: 'Windows Server', major: '2019',
      label: 'Windows Server 2019', edition: 'Standard', build: '17763', bits: '64', source: 'tools-detailed',
    });
  });
  it('RHEL from detailed data keeps the minor version', () => {
    const c = classifyGuestOs({ guest_detailed: RHEL94 });
    expect(c).toMatchObject({
      family: 'linux', vendor: 'Red Hat', product: 'RHEL', major: '9', version: '9.4',
      label: 'RHEL 9', versionLabel: 'RHEL 9.4', source: 'tools-detailed',
    });
  });
  it('Ubuntu keeps 22.04 as the major', () => {
    const c = classifyGuestOs({ guest_detailed: "bitness='64' distroName='Ubuntu' distroVersion='22.04' familyName='Linux' prettyName='Ubuntu 22.04.4 LTS'" });
    expect(c).toMatchObject({ vendor: 'Canonical', product: 'Ubuntu', major: '22.04', label: 'Ubuntu 22.04' });
  });
  it('Tools-reported name beats the configured one', () => {
    const c = classifyGuestOs({ guest_os_running: 'Red Hat Enterprise Linux 8 (64-bit)', guest_os: 'Other Linux (64-bit)' });
    expect(c).toMatchObject({ label: 'RHEL 8', source: 'tools' });
  });
  it('configured names: Windows Server releases and "or later"', () => {
    const lbl = (s) => classifyGuestOs({ guest_os: s }).label;
    expect(lbl('Microsoft Windows Server 2008 R2 (64-bit)')).toBe('Windows Server 2008 R2');
    expect(lbl('Microsoft Windows Server 2012 (64-bit)')).toBe('Windows Server 2012');
    expect(lbl('Microsoft Windows Server 2012 R2 (64-bit)')).toBe('Windows Server 2012 R2');
    expect(lbl('Microsoft Windows Server 2016 (64-bit)')).toBe('Windows Server 2016');
    expect(lbl('Microsoft Windows Server 2022 or later (64-bit)')).toBe('Windows Server 2022');
    expect(lbl('Microsoft Windows Server 2025 (64-bit)')).toBe('Windows Server 2025');
  });
  it('configured names: Windows client', () => {
    expect(classifyGuestOs({ guest_os: 'Microsoft Windows 11 (64-bit)' })).toMatchObject({ product: 'Windows', label: 'Windows 11', family: 'windows' });
    expect(classifyGuestOs({ guest_os: 'Microsoft Windows 10 (32-bit)' })).toMatchObject({ label: 'Windows 10', bits: '32' });
  });
  it('configured names: Linux families', () => {
    const lbl = (s) => classifyGuestOs({ guest_os: s }).label;
    expect(lbl('Red Hat Enterprise Linux 7 (64-bit)')).toBe('RHEL 7');
    expect(lbl('SUSE Linux Enterprise 15 (64-bit)')).toBe('SLES 15');
    expect(lbl('CentOS 7 (64-bit)')).toBe('CentOS 7');
    expect(lbl('Oracle Linux 8 (64-bit)')).toBe('Oracle Linux 8');
    expect(lbl('Ubuntu Linux (64-bit)')).toBe('Ubuntu');
    expect(lbl('Debian GNU/Linux 10 (64-bit)')).toBe('Debian 10');
    expect(lbl('VMware Photon OS (64-bit)')).toBe('Photon OS');
    expect(lbl('FreeBSD 13 (64-bit)')).toBe('FreeBSD 13');
  });
  it('a list like CentOS 4/5 gets no major', () => {
    expect(classifyGuestOs({ guest_os: 'CentOS 4/5 or later (64-bit)' })).toMatchObject({ product: 'CentOS', major: null, label: 'CentOS' });
  });
  it('Other Linux and Other', () => {
    expect(classifyGuestOs({ guest_os: 'Other Linux (64-bit)' })).toMatchObject({ family: 'linux', vendor: 'Other', label: 'Other Linux', bits: '64' });
    expect(classifyGuestOs({ guest_os: 'Other (32-bit)' })).toMatchObject({ family: 'other', label: 'Other', bits: '32' });
  });
  it('guestId-only rows, including the Next suffix shift', () => {
    const lbl = (id) => classifyGuestOs({ guest_id: id }).label;
    expect(lbl('windows2019srv_64Guest')).toBe('Windows Server 2019');
    expect(lbl('windows2019srvNext_64Guest')).toBe('Windows Server 2022');
    expect(lbl('windows2022srvNext_64Guest')).toBe('Windows Server 2025');
    expect(lbl('rhel8_64Guest')).toBe('RHEL 8');
    expect(lbl('sles15_64Guest')).toBe('SLES 15');
    expect(lbl('centos7_64Guest')).toBe('CentOS 7');
    expect(lbl('oracleLinux8_64Guest')).toBe('Oracle Linux 8');
    expect(lbl('ubuntu64Guest')).toBe('Ubuntu');
    expect(lbl('debian11_64Guest')).toBe('Debian 11');
    expect(lbl('otherLinux64Guest')).toBe('Other Linux');
    expect(lbl('other3xLinux64Guest')).toBe('Other Linux');
    expect(lbl('vmwarePhoton64Guest')).toBe('Photon OS');
    expect(lbl('freebsd13_64Guest')).toBe('FreeBSD 13');
    expect(classifyGuestOs({ guest_id: 'rhel8_64Guest' }).source).toBe('configured');
  });
  it('a generic detailed answer does not beat a specific configured one', () => {
    const c = classifyGuestOs({ guest_detailed: "familyName='Linux' kernelVersion='5.10'", guest_os: 'SUSE Linux Enterprise 15 (64-bit)' });
    expect(c).toMatchObject({ label: 'SLES 15', source: 'configured' });
  });
  it('guest_family alone gives a Tools-sourced family', () => {
    expect(classifyGuestOs({ guest_family: 'windowsGuest' })).toMatchObject({ family: 'windows', source: 'tools' });
  });
  it('null row and garbage never throw and give Unknown', () => {
    for (const r of [null, undefined, {}, { guest_os: '' }, { guest_detailed: "=== ''", guest_os: 7, guest_id: {} }]) {
      expect(classifyGuestOs(r)).toMatchObject({ family: 'unknown', label: 'Unknown', source: 'none' });
    }
  });
});

describe('rollupGuestOs', () => {
  it('counts by release, version and family', () => {
    const mk = (vc, name, power, c, tv) => ({ vcenter_id: vc, vcenter_name: name, power_state: power, tools_version_status: tv, ...c });
    const a = classifyGuestOs({ guest_detailed: RHEL94 });
    const b = classifyGuestOs({ guest_os: 'Red Hat Enterprise Linux 9 (64-bit)' });
    const w = classifyGuestOs({ guest_detailed: WIN19 });
    const r = rollupGuestOs([
      mk(1, 'a', 'POWERED_ON', a, 'guestToolsCurrent'),
      mk(2, 'b', 'POWERED_OFF', b, 'guestToolsNeedUpgrade'),
      mk(1, 'a', 'POWERED_ON', w, 'guestToolsCurrent'),
    ], [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    expect(r.summary).toMatchObject({ vms: 3, poweredOn: 2, poweredOff: 1, windows: 1, linux: 2, detailed: 2, configuredOnly: 1, toolsOutdated: 1 });
    expect(r.releases[0]).toMatchObject({ label: 'RHEL 9', vms: 2, poweredOn: 1 });
    expect(r.releases[0].versions).toEqual(expect.arrayContaining([{ version: '9.4', vms: 1 }, { version: '9', vms: 1 }]));
    expect(r.versions.map((v) => v.versionLabel).sort()).toEqual(['RHEL 9', 'RHEL 9.4', 'Windows Server 2019 Standard (build 17763)']);
    expect(r.families[0].family).toBe('windows');
  });
});
