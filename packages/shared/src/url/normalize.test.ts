import { describe, expect, it } from 'vitest';
import {
  isNonPageResource,
  isSameSite,
  looksLikeCrawlTrap,
  normalizeUrl,
  resolveUrl,
} from './normalize.js';

describe('normalizeUrl', () => {
  it('strips tracking parameters but keeps meaningful ones', () => {
    const out = normalizeUrl('https://x.com/a?utm_source=twitter&page=2&fbclid=abc');
    expect(out).toBe('https://x.com/a?page=2');
  });

  it('sorts query parameters so order does not create duplicates', () => {
    expect(normalizeUrl('https://x.com/a?b=2&a=1')).toBe(normalizeUrl('https://x.com/a?a=1&b=2'));
  });

  it('strips the fragment', () => {
    expect(normalizeUrl('https://x.com/a#section')).toBe('https://x.com/a');
  });

  it('drops default ports', () => {
    expect(normalizeUrl('https://x.com:443/a')).toBe(normalizeUrl('https://x.com/a'));
    expect(normalizeUrl('http://x.com:80/a')).toBe(normalizeUrl('http://x.com/a'));
  });

  it('normalizes trailing slashes but preserves root', () => {
    expect(normalizeUrl('https://x.com/a/')).toBe('https://x.com/a');
    expect(normalizeUrl('https://x.com/')).toBe('https://x.com/');
  });

  it('lower-cases the host but not the path', () => {
    expect(normalizeUrl('https://EXAMPLE.com/CaseSensitive')).toBe('https://example.com/CaseSensitive');
  });

  it('collapses duplicate slashes', () => {
    expect(normalizeUrl('https://x.com//a//b')).toBe('https://x.com/a/b');
  });

  it('rejects non-http schemes and garbage', () => {
    expect(normalizeUrl('ftp://x.com/a')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('isNonPageResource', () => {
  it('flags binary and asset extensions', () => {
    expect(isNonPageResource('https://x.com/file.pdf')).toBe(true);
    expect(isNonPageResource('https://x.com/a/app.js')).toBe(true);
    expect(isNonPageResource('https://x.com/img.PNG')).toBe(true);
  });

  it('does not flag html pages or extensionless paths', () => {
    expect(isNonPageResource('https://x.com/about')).toBe(false);
    expect(isNonPageResource('https://x.com/index.html')).toBe(false);
  });
});

describe('isSameSite', () => {
  const seed = 'https://example.com/';

  it('matches the exact host', () => {
    expect(isSameSite('https://example.com/a', seed, false)).toBe(true);
  });

  it('excludes subdomains unless enabled', () => {
    expect(isSameSite('https://blog.example.com/a', seed, false)).toBe(false);
    expect(isSameSite('https://blog.example.com/a', seed, true)).toBe(true);
  });

  it('excludes unrelated hosts even with subdomains enabled', () => {
    expect(isSameSite('https://evil.com/a', seed, true)).toBe(false);
    expect(isSameSite('https://notexample.com/a', seed, true)).toBe(false);
  });

  it('handles two-part TLDs', () => {
    expect(isSameSite('https://shop.example.co.uk/a', 'https://example.co.uk/', true)).toBe(true);
  });
});

describe('looksLikeCrawlTrap', () => {
  it('detects repeated path segments', () => {
    expect(looksLikeCrawlTrap('https://x.com/a/b/a/b/a/b')).toContain('repeated');
  });

  it('detects deep pagination', () => {
    expect(looksLikeCrawlTrap('https://x.com/list?page=500')).toContain('pagination');
  });

  it('detects session identifiers', () => {
    expect(looksLikeCrawlTrap('https://x.com/a?PHPSESSID=abc123')).toContain('session id');
  });

  it('detects faceted-search explosion', () => {
    expect(looksLikeCrawlTrap('https://x.com/s?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9')).toContain('faceted');
  });

  it('allows ordinary URLs', () => {
    expect(looksLikeCrawlTrap('https://x.com/products/widget?color=red')).toBeNull();
    expect(looksLikeCrawlTrap('https://x.com/blog?page=2')).toBeNull();
  });
});

describe('resolveUrl', () => {
  it('resolves relative hrefs', () => {
    expect(resolveUrl('/about', 'https://x.com/a/b')).toBe('https://x.com/about');
    expect(resolveUrl('../c', 'https://x.com/a/b')).toBe('https://x.com/c');
  });

  it('rejects non-navigational schemes', () => {
    expect(resolveUrl('javascript:void(0)', 'https://x.com/')).toBeNull();
    expect(resolveUrl('mailto:a@b.com', 'https://x.com/')).toBeNull();
    expect(resolveUrl('#', 'https://x.com/')).toBeNull();
  });
});
