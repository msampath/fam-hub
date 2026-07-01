import { describe, it, expect, vi } from 'vitest';
import dns from 'dns/promises';
import { isBlockedIp, assertSafeUrl } from '../../server';

describe('isBlockedIp', () => {
  it('blocks private / loopback / link-local / CGNAT / unique-local addresses', () => {
    expect(isBlockedIp('10.0.0.1')).toBe(true);
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('192.168.1.5')).toBe(true);
    expect(isBlockedIp('172.16.0.1')).toBe(true);
    expect(isBlockedIp('169.254.1.1')).toBe(true);
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('100.64.0.1')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('1.1.1.1')).toBe(false);
  });

  it('allows 172.x addresses outside the /12 range', () => {
    expect(isBlockedIp('172.15.0.1')).toBe(false);
    expect(isBlockedIp('172.32.0.1')).toBe(false);
  });

  it('treats non-IP strings as blocked', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertSafeUrl (no-DNS failure paths)', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertSafeUrl('ftp://example.com')).rejects.toThrow();
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow();
  });

  it('rejects malformed URL strings', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toThrow();
  });
});

describe('assertSafeUrl (IP-pinning contract — DNS-rebinding fix)', () => {
  it('returns the validated IP for an IP-literal host (the address safeFetch pins the socket to)', async () => {
    await expect(assertSafeUrl('http://8.8.8.8/')).resolves.toBe('8.8.8.8');
    await expect(assertSafeUrl('https://1.1.1.1/path')).resolves.toBe('1.1.1.1');
  });

  it('the pinned IP it returns is ALWAYS a non-blocked address', async () => {
    expect(isBlockedIp(await assertSafeUrl('http://8.8.8.8/'))).toBe(false);
  });

  it('still rejects private / loopback / cloud-metadata IP-literal hosts (nothing private can be pinned)', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toThrow();
    await expect(assertSafeUrl('http://192.168.1.5/')).rejects.toThrow();
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
  });

  it('pins to the FIRST validated resolution, so a later rebind to a private IP cannot change the target', async () => {
    // safeFetch pins the socket to exactly the IP assertSafeUrl returns, so a subsequent (malicious)
    // resolution to a private address never reaches the connection — the TOCTOU window is closed.
    const spy = vi.spyOn(dns, 'lookup' as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
    const pinned = await assertSafeUrl('https://rebind.example/');
    expect(pinned).toBe('93.184.216.34');
    expect(isBlockedIp(pinned)).toBe(false);
    spy.mockRestore();
  });

  it('rejects at check time when the host resolves to a private address', async () => {
    const spy = vi.spyOn(dns, 'lookup' as any).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    await expect(assertSafeUrl('https://rebind.example/')).rejects.toThrow(/private or local/);
    spy.mockRestore();
  });
});
