import { describe, it, expect } from 'vitest';
import { isBlockedIp, assertAllowedUrl, BlockedUrlError } from './net-guard';

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast/reserved (IPv4)', () => {
    for (const ip of [
      '127.0.0.1',
      '127.5.5.5',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1']) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });

  it('blocks loopback / unspecified / ULA / link-local / mapped (IPv6)', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it('blocks IPv4-mapped/compat IPv6 in HEX notation + expanded loopback (the bypass vectors)', () => {
    for (const ip of [
      '::ffff:7f00:1', // 127.0.0.1 in hex
      '::ffff:a9fe:a9fe', // 169.254.169.254 cloud metadata in hex
      '0:0:0:0:0:0:0:1', // expanded loopback
      '::7f00:1', // IPv4-compatible 127.0.0.1
      'ff02::1', // multicast
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
    // public addresses must still be allowed
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIp('::ffff:0808:0808')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertAllowedUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertAllowedUrl('file:///etc/passwd')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl('ftp://example.com')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects internal IP literals', async () => {
    await expect(assertAllowedUrl('http://127.0.0.1:8080/')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    await expect(assertAllowedUrl('http://[::1]/')).rejects.toThrow();
    await expect(assertAllowedUrl('http://10.1.2.3/')).rejects.toThrow();
  });

  it('rejects localhost (resolves to loopback)', async () => {
    await expect(assertAllowedUrl('http://localhost:4000/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('accepts a public IP literal URL', async () => {
    const u = await assertAllowedUrl('https://1.1.1.1/');
    expect(u.url.protocol).toBe('https:');
    expect(u.addresses).toContain('1.1.1.1');
  });
});
