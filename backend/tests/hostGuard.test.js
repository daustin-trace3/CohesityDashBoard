import { describe, it, expect } from 'vitest';

const { isBlockedAddress, isBlockedHost, assertSafeHost, hostOf } = require('../utils/hostGuard');

describe('hostGuard', () => {
  it('blocks loopback, link-local, metadata and unspecified addresses', () => {
    for (const ip of ['127.0.0.1', '127.8.9.1', '0.0.0.0', '169.254.169.254', '169.254.1.1', '224.0.0.1',
      '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fe80::1', 'fd00:ec2::254', '[::1]', '100.100.100.200']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows private and public unicast (ICC monitors internal infrastructure)', () => {
    for (const ip of ['10.1.2.3', '172.16.5.5', '192.168.128.109', '8.8.8.8', '2001:db8::1', 'fd12:3456::1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('checks the typed host in every accepted shape', () => {
    for (const v of ['localhost', 'LOCALHOST', 'foo.localhost', 'localhost:8443', 'https://localhost/x', '127.0.0.1:443',
      'https://127.0.0.1:9000/a', '[::1]:443', 'http://[::1]/', 'metadata.google.internal', '2130706433', '0x7f.0.0.1', '', '   ']) {
      expect(isBlockedHost(v), JSON.stringify(v)).toBe(true);
    }
    for (const v of ['vcenter01.corp.example', 'cafe.example.com', '10.20.30.40', 'https://sannav.corp.example:443/x', 'ome-01', 'a1b2.example.org']) {
      expect(isBlockedHost(v), v).toBe(false);
    }
  });

  it('hostOf strips scheme, port, path and brackets', () => {
    expect(hostOf('https://h.example:8443/a/b')).toBe('h.example');
    expect(hostOf('h.example:8443')).toBe('h.example');
    expect(hostOf('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(hostOf('2001:db8::1')).toBe('2001:db8::1');
  });

  it('assertSafeHost rejects by resolved address and lets unresolvable names through', async () => {
    await expect(assertSafeHost('127.0.0.1')).rejects.toMatchObject({ status: 400 });
    await expect(assertSafeHost('localhost')).rejects.toMatchObject({ status: 400 });
    await expect(assertSafeHost('10.9.8.7')).resolves.toEqual(['10.9.8.7']);
    await expect(assertSafeHost('does-not-exist.invalid')).resolves.toEqual([]);
  });
});
