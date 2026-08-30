/**
 * Rule tests.
 *
 * Rules are pure functions from observations to findings, which is exactly why
 * they are worth testing hardest: no browser, no network, no LLM — just a
 * fixture in and an assertion out. These tests protect the two properties the
 * product's credibility rests on:
 *
 *   - a rule fires when the evidence warrants it, and stays silent otherwise
 *   - the confidence it claims matches the strength of that evidence
 */

import { describe, expect, it } from 'vitest';
import type {
  InteractionObservation,
  NetworkObservation,
  PageObservations,
  ResolvedAuditConfig,
  SiteObservations,
} from '@webqa/shared';
import {
  brokenLinkRule,
  consoleErrorRule,
  failedRequestRule,
  interactionRule,
  jsExceptionRule,
} from './functional.js';
import { clsRule, compressionRule, lcpRule, payloadRule } from './performance.js';
import { duplicateTitleRule, titleRule, viewportRule } from './seo.js';
import { httpsRule, mixedContentRule, securityHeadersRule } from './security.js';
import { unnamedControlRule } from './accessibility.js';
import { runRules } from './index.js';

// ── fixtures ───────────────────────────────────────────────────────────────

function makePage(overrides: Partial<PageObservations> = {}): PageObservations {
  return {
    url: 'https://example.com/',
    depth: 0,
    discoveredFrom: null,
    device: 'DESKTOP',
    network: 'FAST',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:10.000Z',
    probeError: null,
    navigation: {
      requestedUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      status: 200,
      redirectChain: [],
      crossOriginRedirect: false,
      timing: { ttfbMs: 120, domContentLoadedMs: 400, loadEventMs: 800 },
      tls: null,
    },
    meta: {
      // Title length matters: the fixture must sit inside the 15–65 character
      // window or the length rule fires and every other assertion drifts.
      title: 'Example Page — Widgets and Gadgets', titleCount: 1,
      description: 'A description that is long enough to be reasonable for search engines to display.',
      canonical: 'https://example.com/', robots: null, viewport: 'width=device-width, initial-scale=1',
      langAttribute: 'en', charset: 'utf-8', openGraph: {}, twitterCard: {},
      structuredData: [], structuredDataErrors: [], headings: [{ level: 1, text: 'Example' }],
      duplicateIds: [], landmarks: ['main'], htmlBytes: 2000, wordCount: 400,
    },
    vitals: {
      lcpMs: 1200, lcpElement: 'img.hero', lcpResourceUrl: null, fcpMs: 800, cls: 0.02,
      clsSources: [], inpMs: null, ttfbMs: 120, tbtMs: 50, domContentLoadedMs: 400, loadEventMs: 800,
    },
    longTasks: [],
    coverage: [],
    requests: [],
    console: [],
    pageErrors: [],
    links: [],
    images: [],
    forms: [],
    interactiveElements: [],
    layout: [],
    axeViolations: [],
    interactions: [],
    security: {
      url: 'https://example.com/',
      isHttps: true,
      headers: {
        'content-security-policy': "default-src 'self'",
        'strict-transport-security': 'max-age=31536000',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=()',
        'x-frame-options': 'SAMEORIGIN',
      },
      cookies: [],
      mixedContentUrls: [],
      thirdPartyScriptOrigins: [],
    },
    lighthouse: null,
    screenshots: { viewportKey: null, fullPageKey: null },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<NetworkObservation> = {}): NetworkObservation {
  return {
    requestId: 'r1',
    url: 'https://example.com/app.js',
    origin: 'https://example.com',
    method: 'GET',
    resourceKind: 'script',
    status: 200,
    statusText: 'OK',
    failureText: null,
    transferSizeBytes: 1000,
    resourceSizeBytes: 1000,
    mimeType: 'application/javascript',
    durationMs: 50,
    startedAtMs: 100,
    fromCache: false,
    isThirdParty: false,
    responseHeaders: { 'content-encoding': 'br', 'cache-control': 'max-age=31536000' },
    redirectChain: [],
    protocol: 'h2',
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<InteractionObservation> = {}): InteractionObservation {
  return {
    selector: 'button.cta',
    label: 'Sign up',
    elementKind: 'button',
    outcome: 'DOM_CHANGED',
    consoleErrors: [],
    pageErrors: [],
    networkRequests: [],
    failedRequests: [],
    urlBefore: 'https://example.com/',
    urlAfter: 'https://example.com/',
    domMutationCount: 12,
    durationMs: 900,
    screenshotKey: null,
    ...overrides,
  };
}

const SITE: SiteObservations = {
  seedUrl: 'https://example.com/',
  origin: 'https://example.com',
  robots: { found: true, url: 'https://example.com/robots.txt', status: 200, sitemapUrls: [], disallowedPaths: [], raw: '' },
  sitemap: { found: true, url: 'https://example.com/sitemap.xml', status: 200, urlCount: 5, sampleUrls: [], parseError: null },
  linkChecks: [],
  skipped: [],
};

const CONFIG = { maxPages: 25, maxDepth: 2, device: 'DESKTOP', network: 'FAST' } as unknown as ResolvedAuditConfig;
const ctx = (page: PageObservations) => ({ page, site: SITE, config: CONFIG, totalPages: 1 });

// ── functional ─────────────────────────────────────────────────────────────

describe('jsExceptionRule', () => {
  it('is silent on a clean page', () => {
    expect(jsExceptionRule.run(ctx(makePage()))).toHaveLength(0);
  });

  it('reports an uncaught exception as CONFIRMED', () => {
    const findings = jsExceptionRule.run(
      ctx(makePage({
        pageErrors: [{ name: 'TypeError', message: "Cannot read properties of undefined (reading 'x')", stack: 'at foo', atMs: 500 }],
      })),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('HIGH');
    expect(findings[0]!.confidence).toBe('CONFIRMED');
    expect(findings[0]!.measuredFacts.length).toBeGreaterThan(0);
  });

  it('groups repeats of the same error into one finding', () => {
    const error = { name: 'TypeError', message: 'x is not a function', stack: null, atMs: 100 };
    const findings = jsExceptionRule.run(
      ctx(makePage({ pageErrors: [error, { ...error, atMs: 200 }, { ...error, atMs: 300 }] })),
    );
    expect(findings).toHaveLength(1);
  });

  it('separates genuinely different errors', () => {
    const findings = jsExceptionRule.run(
      ctx(makePage({
        pageErrors: [
          { name: 'TypeError', message: 'a is undefined', stack: null, atMs: 1 },
          { name: 'ReferenceError', message: 'b is not defined', stack: null, atMs: 2 },
        ],
      })),
    );
    expect(findings).toHaveLength(2);
  });
});

describe('failedRequestRule', () => {
  it('rates a 500 on a first-party API call as CRITICAL', () => {
    const findings = failedRequestRule.run(
      ctx(makePage({
        requests: [makeRequest({ url: 'https://example.com/api/checkout', resourceKind: 'fetch', status: 500, method: 'POST' })],
      })),
    );
    expect(findings[0]!.severity).toBe('CRITICAL');
    expect(findings[0]!.confidence).toBe('CONFIRMED');
  });

  it('rates a third-party 404 as LOW', () => {
    const findings = failedRequestRule.run(
      ctx(makePage({
        requests: [makeRequest({ url: 'https://cdn.other.com/pixel.gif', origin: 'https://cdn.other.com', resourceKind: 'image', status: 404, isThirdParty: true })],
      })),
    );
    expect(findings[0]!.severity).toBe('LOW');
  });

  it('ignores successful requests', () => {
    expect(failedRequestRule.run(ctx(makePage({ requests: [makeRequest()] })))).toHaveLength(0);
  });

  it('groups failures that share a status and URL template', () => {
    const findings = failedRequestRule.run(
      ctx(makePage({
        requests: [
          makeRequest({ url: 'https://example.com/api/item/1', resourceKind: 'fetch', status: 500 }),
          makeRequest({ url: 'https://example.com/api/item/2', resourceKind: 'fetch', status: 500 }),
          makeRequest({ url: 'https://example.com/api/item/3', resourceKind: 'fetch', status: 500 }),
        ],
      })),
    );
    expect(findings).toHaveLength(1);
  });
});

describe('interactionRule', () => {
  it('says nothing about a control that worked', () => {
    expect(interactionRule.run(ctx(makePage({ interactions: [makeInteraction()] })))).toHaveLength(0);
  });

  it('reports an exception during interaction as CRITICAL and CONFIRMED', () => {
    const findings = interactionRule.run(
      ctx(makePage({
        interactions: [makeInteraction({
          outcome: 'THREW_EXCEPTION',
          pageErrors: [{ name: 'TypeError', message: 'handler failed', stack: null, atMs: 10 }],
        })],
      })),
    );
    expect(findings[0]!.severity).toBe('CRITICAL');
    expect(findings[0]!.confidence).toBe('CONFIRMED');
    expect(findings[0]!.reproduction?.steps.length).toBeGreaterThan(0);
  });

  it('reports a failed API call behind a click', () => {
    const findings = interactionRule.run(
      ctx(makePage({
        interactions: [makeInteraction({
          label: 'Checkout',
          outcome: 'NETWORK_ACTIVITY',
          failedRequests: [makeRequest({ url: 'https://example.com/api/checkout', method: 'POST', resourceKind: 'fetch', status: 500 })],
        })],
      })),
    );
    expect(findings[0]!.severity).toBe('CRITICAL');
    expect(findings[0]!.title).toContain('Checkout');
  });

  it('marks "no observable effect" as POSSIBLE, not CONFIRMED', () => {
    // This is the honesty invariant: absence of evidence is not evidence.
    const findings = interactionRule.run(
      ctx(makePage({
        interactions: [makeInteraction({ outcome: 'NO_OBSERVABLE_EFFECT', domMutationCount: 0 })],
      })),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe('POSSIBLE');
    expect(findings[0]!.severity).toBe('MEDIUM');
  });

  it('does not flag a plain link that produced no effect', () => {
    const findings = interactionRule.run(
      ctx(makePage({
        interactions: [makeInteraction({ elementKind: 'link', outcome: 'NO_OBSERVABLE_EFFECT' })],
      })),
    );
    expect(findings).toHaveLength(0);
  });
});

describe('consoleErrorRule', () => {
  it('reports console errors as LIKELY rather than CONFIRMED', () => {
    const findings = consoleErrorRule.run(
      ctx(makePage({
        console: [{ level: 'error', text: 'Failed to fetch config', url: null, lineNumber: null, atMs: 10 }],
      })),
    );
    expect(findings[0]!.confidence).toBe('LIKELY');
  });

  it('ignores warnings and logs', () => {
    const findings = consoleErrorRule.run(
      ctx(makePage({
        console: [
          { level: 'warning', text: 'deprecated', url: null, lineNumber: null, atMs: 1 },
          { level: 'log', text: 'hello', url: null, lineNumber: null, atMs: 2 },
        ],
      })),
    );
    expect(findings).toHaveLength(0);
  });
});

describe('brokenLinkRule', () => {
  it('separates internal from external broken links and rates them differently', () => {
    const findings = brokenLinkRule.run({
      pages: [],
      config: CONFIG,
      totalPages: 1,
      site: {
        ...SITE,
        linkChecks: [
          { url: 'https://example.com/gone', status: 404, failureText: null, isInternal: true, referrers: ['https://example.com/'], redirectedTo: null },
          { url: 'https://other.com/gone', status: 404, failureText: null, isInternal: false, referrers: ['https://example.com/'], redirectedTo: null },
        ],
      },
    });

    expect(findings).toHaveLength(2);
    const internal = findings.find((f) => f.ruleId.includes('internal'));
    const external = findings.find((f) => f.ruleId.includes('external'));
    expect(internal!.severity).toBe('HIGH');
    expect(external!.severity).toBe('LOW');
  });

  it('is silent when every link resolves', () => {
    expect(brokenLinkRule.run({ pages: [], config: CONFIG, totalPages: 1, site: SITE })).toHaveLength(0);
  });
});

// ── performance ────────────────────────────────────────────────────────────

describe('lcpRule', () => {
  it('is silent on a fast page', () => {
    expect(lcpRule.run(ctx(makePage()))).toHaveLength(0);
  });

  it('reports a poor LCP as HIGH', () => {
    const page = makePage();
    page.vitals!.lcpMs = 5200;
    expect(lcpRule.run(ctx(page))[0]!.severity).toBe('HIGH');
  });

  it('reports a borderline LCP as MEDIUM', () => {
    const page = makePage();
    page.vitals!.lcpMs = 3000;
    expect(lcpRule.run(ctx(page))[0]!.severity).toBe('MEDIUM');
  });

  it('names the lazily-loaded LCP image and calls the fix trivial', () => {
    const page = makePage({
      images: [{
        src: '/hero.jpg', absoluteUrl: 'https://example.com/hero.jpg', alt: 'Hero', altMissing: false,
        width: 1200, height: 600, naturalWidth: 3000, naturalHeight: 1500, loading: 'lazy',
        broken: false, inViewport: true, selector: 'img.hero',
      }],
      requests: [makeRequest({ url: 'https://example.com/hero.jpg', resourceKind: 'image', transferSizeBytes: 1_800_000 })],
    });
    page.vitals!.lcpMs = 4200;
    page.vitals!.lcpResourceUrl = 'https://example.com/hero.jpg';

    const finding = lcpRule.run(ctx(page))[0]!;
    expect(finding.inference).toContain('lazy');
    expect(finding.recommendation).toContain('fetchpriority');
    expect(finding.estimatedEffort).toBe('TRIVIAL');
    // The specific resource size must appear — this is the "name the bytes" bar.
    expect(JSON.stringify(finding.measuredFacts)).toContain('1.72 MB');
  });
});

describe('clsRule', () => {
  it('is silent below the threshold', () => {
    expect(clsRule.run(ctx(makePage()))).toHaveLength(0);
  });

  it('reports poor CLS and connects it to unsized images', () => {
    const page = makePage({
      images: [{
        src: '/a.jpg', absoluteUrl: 'https://example.com/a.jpg', alt: '', altMissing: false,
        width: null, height: null, naturalWidth: 800, naturalHeight: 600, loading: null,
        broken: false, inViewport: true, selector: 'img.a',
      }],
    });
    page.vitals!.cls = 0.4;
    const finding = clsRule.run(ctx(page))[0]!;
    expect(finding.severity).toBe('HIGH');
    expect(finding.inference).toContain('width/height');
  });
});

describe('payloadRule', () => {
  it('ignores a lean page', () => {
    expect(payloadRule.run(ctx(makePage({ requests: [makeRequest()] })))).toHaveLength(0);
  });

  it('reports a heavy page and identifies the dominant resource type', () => {
    const requests = Array.from({ length: 5 }, (_, index) =>
      makeRequest({ url: `https://example.com/img${index}.jpg`, resourceKind: 'image', transferSizeBytes: 900_000 }),
    );
    const finding = payloadRule.run(ctx(makePage({ requests })))[0]!;
    expect(finding).toBeDefined();
    expect(finding.title).toContain('MB');
    expect(finding.recommendation).toContain('AVIF');
  });
});

describe('compressionRule', () => {
  it('flags uncompressed text resources', () => {
    const finding = compressionRule.run(
      ctx(makePage({
        requests: [makeRequest({ transferSizeBytes: 200_000, responseHeaders: { 'cache-control': 'max-age=100' } })],
      })),
    )[0]!;
    expect(finding).toBeDefined();
    expect(finding.estimatedEffort).toBe('TRIVIAL');
  });

  it('accepts brotli-encoded resources', () => {
    expect(
      compressionRule.run(ctx(makePage({ requests: [makeRequest({ transferSizeBytes: 200_000 })] }))),
    ).toHaveLength(0);
  });
});

// ── SEO ────────────────────────────────────────────────────────────────────

describe('titleRule', () => {
  it('accepts a well-formed title', () => {
    expect(titleRule.run(ctx(makePage()))).toHaveLength(0);
  });

  it('reports a missing title as HIGH', () => {
    const page = makePage();
    page.meta!.title = null;
    page.meta!.titleCount = 0;
    const findings = titleRule.run(ctx(page));
    expect(findings[0]!.severity).toBe('HIGH');
  });

  it('reports an over-long title', () => {
    const page = makePage();
    page.meta!.title = 'x'.repeat(90);
    expect(titleRule.run(ctx(page))[0]!.ruleId).toBe('seo.title-length');
  });
});

describe('viewportRule', () => {
  it('accepts a standard viewport', () => {
    expect(viewportRule.run(ctx(makePage()))).toHaveLength(0);
  });

  it('flags a missing viewport as HIGH', () => {
    const page = makePage();
    page.meta!.viewport = null;
    expect(viewportRule.run(ctx(page))[0]!.severity).toBe('HIGH');
  });

  it('flags zoom suppression as an accessibility failure', () => {
    const page = makePage();
    page.meta!.viewport = 'width=device-width, user-scalable=no';
    const finding = viewportRule.run(ctx(page))[0]!;
    expect(finding.category).toBe('ACCESSIBILITY');
    expect(finding.standardsRef).toContain('WCAG');
  });
});

describe('duplicateTitleRule', () => {
  it('detects titles reused across pages', () => {
    const a = makePage({ url: 'https://example.com/a' });
    const b = makePage({ url: 'https://example.com/b' });
    const findings = duplicateTitleRule.run({ pages: [a, b], site: SITE, config: CONFIG, totalPages: 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.occurrences.length).toBe(2);
  });

  it('is silent when titles are unique', () => {
    const a = makePage({ url: 'https://example.com/a' });
    const b = makePage({ url: 'https://example.com/b' });
    b.meta!.title = 'A Different Title';
    expect(duplicateTitleRule.run({ pages: [a, b], site: SITE, config: CONFIG, totalPages: 2 })).toHaveLength(0);
  });
});

// ── security ───────────────────────────────────────────────────────────────

describe('httpsRule', () => {
  it('accepts an HTTPS page', () => {
    expect(httpsRule.run(ctx(makePage()))).toHaveLength(0);
  });

  it('rates plain HTTP as CRITICAL', () => {
    const page = makePage();
    page.security!.isHttps = false;
    expect(httpsRule.run(ctx(page))[0]!.severity).toBe('CRITICAL');
  });
});

describe('securityHeadersRule', () => {
  it('is silent when all headers are properly set', () => {
    expect(securityHeadersRule.run(ctx(makePage()))).toHaveLength(0);
  });

  it('reports a missing CSP', () => {
    const page = makePage();
    delete page.security!.headers['content-security-policy'];
    const findings = securityHeadersRule.run(ctx(page));
    expect(findings.some((f) => f.ruleId.includes('content-security-policy'))).toBe(true);
  });

  it("flags a CSP weakened by 'unsafe-inline'", () => {
    const page = makePage();
    page.security!.headers['content-security-policy'] = "default-src 'self'; script-src 'unsafe-inline'";
    const findings = securityHeadersRule.run(ctx(page));
    const weak = findings.find((f) => f.ruleId.includes('weak'));
    expect(weak).toBeDefined();
    expect(weak!.description).toContain('unsafe-inline');
  });

  it('accepts CSP frame-ancestors in place of X-Frame-Options', () => {
    const page = makePage();
    delete page.security!.headers['x-frame-options'];
    page.security!.headers['content-security-policy'] = "default-src 'self'; frame-ancestors 'self'";
    const findings = securityHeadersRule.run(ctx(page));
    expect(findings.some((f) => f.ruleId.includes('x-frame-options'))).toBe(false);
  });

  it('does not demand HSTS on a plain-HTTP page', () => {
    const page = makePage();
    page.security!.isHttps = false;
    delete page.security!.headers['strict-transport-security'];
    const findings = securityHeadersRule.run(ctx(page));
    expect(findings.some((f) => f.ruleId.includes('strict-transport-security'))).toBe(false);
  });
});

describe('mixedContentRule', () => {
  it('rates active mixed content higher than passive', () => {
    const active = mixedContentRule.run(
      ctx(makePage({ requests: [makeRequest({ url: 'http://cdn.example.com/a.js', resourceKind: 'script' })] })),
    )[0]!;
    const passive = mixedContentRule.run(
      ctx(makePage({ requests: [makeRequest({ url: 'http://cdn.example.com/a.jpg', resourceKind: 'image' })] })),
    )[0]!;

    expect(active.severity).toBe('HIGH');
    expect(passive.severity).toBe('MEDIUM');
  });

  it('does not apply to an HTTP page', () => {
    const page = makePage({ requests: [makeRequest({ url: 'http://x.com/a.js', resourceKind: 'script' })] });
    page.security!.isHttps = false;
    expect(mixedContentRule.run(ctx(page))).toHaveLength(0);
  });
});

// ── accessibility ──────────────────────────────────────────────────────────

describe('unnamedControlRule', () => {
  it('flags a visible control with no accessible name', () => {
    const findings = unnamedControlRule.run(
      ctx(makePage({
        interactiveElements: [{
          selector: 'button.icon', tag: 'button', role: null, accessibleName: '',
          visible: true, enabled: true, inViewport: true,
          boundingBox: { x: 0, y: 0, width: 40, height: 40 }, obscuredBy: null,
        }],
      })),
    );
    expect(findings[0]!.severity).toBe('HIGH');
    expect(findings[0]!.standardsRef).toContain('4.1.2');
  });

  it('ignores hidden controls', () => {
    const findings = unnamedControlRule.run(
      ctx(makePage({
        interactiveElements: [{
          selector: 'button.hidden', tag: 'button', role: null, accessibleName: '',
          visible: false, enabled: true, inViewport: false, boundingBox: null, obscuredBy: null,
        }],
      })),
    );
    expect(findings).toHaveLength(0);
  });
});

// ── engine ─────────────────────────────────────────────────────────────────

describe('runRules', () => {
  it('runs every rule without throwing on a minimal page', () => {
    const result = runRules({ pages: [makePage()], site: SITE, config: CONFIG });
    expect(result.errors).toHaveLength(0);
  });

  it('survives malformed observations rather than aborting the audit', () => {
    // A page missing meta/vitals/security should degrade, not explode — this is
    // what keeps one bad page from costing the user the whole report.
    const broken = makePage({ meta: null, vitals: null, security: null, navigation: null });
    const result = runRules({ pages: [broken], site: SITE, config: CONFIG });
    expect(result.errors).toHaveLength(0);
  });

  it('produces findings from a page with real problems', () => {
    const page = makePage({
      pageErrors: [{ name: 'TypeError', message: 'boom', stack: null, atMs: 1 }],
      requests: [makeRequest({ url: 'https://example.com/api/x', resourceKind: 'fetch', status: 500 })],
    });
    const result = runRules({ pages: [page], site: SITE, config: CONFIG });
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });
});
