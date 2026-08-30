import { describe, expect, it } from 'vitest';
import {
  assertResolvedAddresses,
  checkAddress,
  checkUrlSyntax,
  DEFAULT_SSRF_OPTIONS,
  type SsrfOptions,
} from './ssrf.js';

const opts: SsrfOptions = { ...DEFAULT_SSRF_OPTIONS };

describe('checkAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'RFC1918'],
    ['172.16.0.1', 'RFC1918'],
    ['172.31.255.254', 'RFC1918'],
    ['192.168.1.1', 'RFC1918'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-grade'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
  ])('blocks %s', (ip) => {
    expect(checkAddress(ip)).not.toBeNull();
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255'])(
    'allows public address %s',
    (ip) => {
      expect(checkAddress(ip)).toBeNull();
    },
  );

  it('blocks IPv6 loopback and unique-local', () => {
    expect(checkAddress('::1')).not.toBeNull();
    expect(checkAddress('fd00::1')).not.toBeNull();
    expect(checkAddress('fe80::1')).not.toBeNull();
  });

  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(checkAddress('::ffff:127.0.0.1')).not.toBeNull();
    expect(checkAddress('::ffff:8.8.8.8')).toBeNull();
  });

  it('allows global unicast IPv6', () => {
    expect(checkAddress('2606:4700:4700::1111')).toBeNull();
  });
});

describe('checkUrlSyntax', () => {
  it('accepts a normal https URL', () => {
    expect(checkUrlSyntax('https://example.com/path', opts).allowed).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(checkUrlSyntax('file:///etc/passwd', opts).allowed).toBe(false);
    expect(checkUrlSyntax('gopher://example.com', opts).allowed).toBe(false);
  });

  it('rejects localhost by name', () => {
    expect(checkUrlSyntax('http://localhost:3000', opts).allowed).toBe(false);
  });

  it('rejects internal-only suffixes', () => {
    expect(checkUrlSyntax('http://db.internal/', opts).allowed).toBe(false);
    expect(checkUrlSyntax('http://printer.local/', opts).allowed).toBe(false);
  });

  it('rejects the cloud metadata endpoint', () => {
    expect(checkUrlSyntax('http://169.254.169.254/latest/meta-data/', opts).allowed).toBe(false);
    expect(checkUrlSyntax('http://metadata.google.internal/', opts).allowed).toBe(false);
  });

  it('rejects embedded credentials', () => {
    expect(checkUrlSyntax('https://user:pass@example.com/', opts).allowed).toBe(false);
  });

  it('rejects encoded IP literals', () => {
    // 2130706433 === 127.0.0.1
    expect(checkUrlSyntax('http://2130706433/', opts).allowed).toBe(false);
    expect(checkUrlSyntax('http://0x7f000001/', opts).allowed).toBe(false);
  });

  it('rejects unusual ports', () => {
    expect(checkUrlSyntax('http://example.com:22/', opts).allowed).toBe(false);
    expect(checkUrlSyntax('http://example.com:6379/', opts).allowed).toBe(false);
  });

  it('honours the allowlist', () => {
    const withAllow = { ...opts, allowlist: ['localhost'] };
    expect(checkUrlSyntax('http://localhost:3000/', withAllow).allowed).toBe(true);
  });

  it('is a no-op when protection is disabled', () => {
    const disabled = { ...opts, enabled: false };
    expect(checkUrlSyntax('http://127.0.0.1/', disabled).allowed).toBe(true);
  });
});

describe('assertResolvedAddresses', () => {
  it('blocks a public-looking host that resolves to a private IP', () => {
    const result = assertResolvedAddresses('evil.example.com', ['127.0.0.1'], opts);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('loopback');
  });

  it('blocks when ANY resolved address is private', () => {
    const result = assertResolvedAddresses('mixed.example.com', ['8.8.8.8', '10.0.0.5'], opts);
    expect(result.allowed).toBe(false);
  });

  it('allows an all-public resolution', () => {
    expect(assertResolvedAddresses('example.com', ['93.184.216.34'], opts).allowed).toBe(true);
  });

  it('blocks a host with no addresses', () => {
    expect(assertResolvedAddresses('nowhere.example', [], opts).allowed).toBe(false);
  });
});
