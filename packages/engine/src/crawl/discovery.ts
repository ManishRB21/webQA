/**
 * Pre-crawl discovery: preflight, robots.txt, sitemap.xml.
 *
 * Running this first pays off twice. Practically, a sitemap is a curated list
 * of pages the site owner thinks matter — far better crawl seeds than whatever
 * the homepage happens to link to. Ethically, robots.txt is how a site says
 * what it does not want crawled, and honouring it is the difference between an
 * auditor and a nuisance.
 *
 * Every fetch here goes through the SSRF guard, including redirects: a
 * `sitemap.xml` that 302s to `http://169.254.169.254/` is exactly the attack
 * this tool would otherwise enable.
 */

import { lookup } from 'node:dns/promises';
import type { RobotsObservation, SitemapObservation, SsrfOptions } from '@webqa/shared';
import { assertResolvedAddresses, checkUrlSyntax, redactUrl } from '@webqa/shared';
import type { Reporter } from '../logger.js';

export interface SafeFetchResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  finalUrl: string;
  error: string | null;
  headers: Record<string, string>;
}

/**
 * Fetch a URL with SSRF validation applied to the initial URL and to every
 * redirect hop.
 *
 * `redirect: 'manual'` is essential — the default `follow` would let the
 * platform chase a redirect into a private address before we could inspect it.
 */
export async function safeFetch(
  url: string,
  options: {
    ssrf: SsrfOptions;
    userAgent: string;
    timeoutMs?: number;
    method?: 'GET' | 'HEAD';
    maxRedirects?: number;
    maxBytes?: number;
  },
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;

  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const syntax = checkUrlSyntax(currentUrl, options.ssrf);
    if (!syntax.allowed) {
      return { ok: false, status: null, body: null, finalUrl: currentUrl, error: syntax.reason, headers: {} };
    }

    if (options.ssrf.enabled) {
      const hostname = new URL(currentUrl).hostname;
      try {
        const records = await lookup(hostname, { all: true, verbatim: true });
        const check = assertResolvedAddresses(hostname, records.map((r) => r.address), options.ssrf);
        if (!check.allowed) {
          return { ok: false, status: null, body: null, finalUrl: currentUrl, error: check.reason, headers: {} };
        }
      } catch (error) {
        return {
          ok: false,
          status: null,
          body: null,
          finalUrl: currentUrl,
          error: `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          headers: {},
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': options.userAgent, accept: '*/*' },
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') return;
        headers[key.toLowerCase()] = value;
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return { ok: false, status: response.status, body: null, finalUrl: currentUrl, error: 'redirect without Location', headers };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      let body: string | null = null;
      if ((options.method ?? 'GET') === 'GET') {
        const raw = await response.arrayBuffer();
        const slice = raw.byteLength > maxBytes ? raw.slice(0, maxBytes) : raw;
        body = new TextDecoder('utf-8', { fatal: false }).decode(slice);
      }

      return { ok: response.ok, status: response.status, body, finalUrl: currentUrl, error: null, headers };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: null,
        body: null,
        finalUrl: currentUrl,
        error: controller.signal.aborted ? `timed out after ${timeoutMs}ms` : message,
        headers: {},
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: null, body: null, finalUrl: currentUrl, error: 'too many redirects', headers: {} };
}

// ── robots.txt ─────────────────────────────────────────────────────────────

/**
 * Parse robots.txt.
 *
 * We honour the `*` user-agent group plus any group naming us specifically.
 * Group parsing follows the spec's rule that consecutive `User-agent:` lines
 * share the rules that follow them.
 */
export function parseRobots(text: string, ourAgent: string): { disallow: string[]; allow: string[]; sitemaps: string[] } {
  const disallow: string[] = [];
  const allow: string[] = [];
  const sitemaps: string[] = [];

  let currentAgents: string[] = [];
  let groupApplies = false;
  let expectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      currentAgents.push(value.toLowerCase());
      groupApplies = currentAgents.some(
        (agent) => agent === '*' || ourAgent.toLowerCase().includes(agent),
      );
      continue;
    }

    expectingAgents = false;
    if (!groupApplies) continue;

    if (field === 'disallow' && value) disallow.push(value);
    else if (field === 'allow' && value) allow.push(value);
  }

  return { disallow, allow, sitemaps };
}

export async function fetchRobots(
  origin: string,
  options: { ssrf: SsrfOptions; userAgent: string; reporter: Reporter },
): Promise<RobotsObservation> {
  const url = `${origin}/robots.txt`;
  const result = await safeFetch(url, { ssrf: options.ssrf, userAgent: options.userAgent, timeoutMs: 10_000 });

  if (!result.ok || !result.body) {
    options.reporter.debug(`No robots.txt at ${redactUrl(url)} (${result.status ?? result.error})`);
    return { found: false, url, status: result.status, sitemapUrls: [], disallowedPaths: [], raw: null };
  }

  const parsed = parseRobots(result.body, options.userAgent);
  options.reporter.success(
    `robots.txt found — ${parsed.disallow.length} disallow rule(s), ${parsed.sitemaps.length} sitemap reference(s)`,
  );

  return {
    found: true,
    url,
    status: result.status,
    sitemapUrls: parsed.sitemaps,
    disallowedPaths: parsed.disallow,
    raw: result.body.slice(0, 20_000),
  };
}

// ── sitemap.xml ────────────────────────────────────────────────────────────

/**
 * Extract URLs from a sitemap or sitemap index.
 * A regex rather than an XML parser: sitemaps are machine-generated and
 * uniform, and this avoids a parser dependency plus its XXE surface.
 */
function extractSitemapUrls(xml: string): { urls: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const pattern = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const value = match[1]?.trim();
    if (value) urls.push(value);
    if (urls.length >= 5000) break;
  }
  return { urls, isIndex };
}

export async function fetchSitemap(
  origin: string,
  candidateUrls: string[],
  options: { ssrf: SsrfOptions; userAgent: string; reporter: Reporter; maxUrls?: number },
): Promise<SitemapObservation> {
  const maxUrls = options.maxUrls ?? 1000;
  const candidates = candidateUrls.length > 0 ? candidateUrls : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  for (const candidate of candidates.slice(0, 5)) {
    const result = await safeFetch(candidate, {
      ssrf: options.ssrf,
      userAgent: options.userAgent,
      timeoutMs: 15_000,
      maxBytes: 10 * 1024 * 1024,
    });

    if (!result.ok || !result.body) continue;

    try {
      const { urls, isIndex } = extractSitemapUrls(result.body);
      if (urls.length === 0) continue;

      // A sitemap index points at more sitemaps — follow a bounded number.
      if (isIndex) {
        const collected: string[] = [];
        for (const child of urls.slice(0, 5)) {
          const childResult = await safeFetch(child, {
            ssrf: options.ssrf,
            userAgent: options.userAgent,
            timeoutMs: 15_000,
            maxBytes: 10 * 1024 * 1024,
          });
          if (childResult.ok && childResult.body) {
            collected.push(...extractSitemapUrls(childResult.body).urls);
          }
          if (collected.length >= maxUrls) break;
        }
        options.reporter.success(`Sitemap index found — ${collected.length} URL(s) across child sitemaps`);
        return {
          found: true,
          url: candidate,
          status: result.status,
          urlCount: collected.length,
          sampleUrls: collected.slice(0, maxUrls),
          parseError: null,
        };
      }

      options.reporter.success(`Sitemap found — ${urls.length} URL(s)`);
      return {
        found: true,
        url: candidate,
        status: result.status,
        urlCount: urls.length,
        sampleUrls: urls.slice(0, maxUrls),
        parseError: null,
      };
    } catch (error) {
      return {
        found: true,
        url: candidate,
        status: result.status,
        urlCount: 0,
        sampleUrls: [],
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  options.reporter.debug('No sitemap found');
  return { found: false, url: `${origin}/sitemap.xml`, status: null, urlCount: 0, sampleUrls: [], parseError: null };
}

// ── preflight ──────────────────────────────────────────────────────────────

export interface PreflightResult {
  reachable: boolean;
  status: number | null;
  finalUrl: string;
  error: string | null;
  /** True when the seed URL redirected to a different origin. */
  redirectedOffOrigin: boolean;
}

/** Confirm the target is reachable before we spend a browser launch on it. */
export async function preflight(
  url: string,
  options: { ssrf: SsrfOptions; userAgent: string; reporter: Reporter },
): Promise<PreflightResult> {
  const result = await safeFetch(url, {
    ssrf: options.ssrf,
    userAgent: options.userAgent,
    timeoutMs: 20_000,
    method: 'GET',
    maxBytes: 64 * 1024,
  });

  const redirectedOffOrigin = (() => {
    try {
      return new URL(url).origin !== new URL(result.finalUrl).origin;
    } catch {
      return false;
    }
  })();

  if (result.error) {
    options.reporter.error(`Target is not reachable: ${result.error}`);
    return { reachable: false, status: result.status, finalUrl: result.finalUrl, error: result.error, redirectedOffOrigin };
  }

  if (redirectedOffOrigin) {
    options.reporter.warn(
      `Seed URL redirected to a different origin: ${redactUrl(result.finalUrl)} — auditing the destination`,
    );
  }

  options.reporter.success(`Website reachable (HTTP ${result.status})`);
  return { reachable: true, status: result.status, finalUrl: result.finalUrl, error: null, redirectedOffOrigin };
}
