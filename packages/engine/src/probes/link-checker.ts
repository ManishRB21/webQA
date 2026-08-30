/**
 * Link and resource verification.
 *
 * Deliberately not done in the browser: opening 400 pages to check 400 links
 * would take an hour. A bounded pool of HEAD requests (falling back to GET,
 * because plenty of servers mishandle HEAD) covers the same ground in seconds.
 *
 * Politeness is a first-class concern — we are generating traffic against
 * someone else's infrastructure. Concurrency is capped per host, not globally,
 * so a page linking to 200 URLs on one domain does not look like a small DoS.
 */

import type { LinkCheckObservation, SsrfOptions } from '@webqa/shared';
import { redactUrl } from '@webqa/shared';
import { safeFetch } from '../crawl/discovery.js';
import type { Reporter } from '../logger.js';

export interface LinkCheckInput {
  /** Absolute URL → the pages that reference it. */
  targets: Map<string, Set<string>>;
  seedOrigin: string;
  ssrf: SsrfOptions;
  userAgent: string;
  reporter: Reporter;
  maxChecks: number;
  perHostConcurrency?: number;
  timeoutMs?: number;
}

export async function checkLinks(input: LinkCheckInput): Promise<LinkCheckObservation[]> {
  const perHost = input.perHostConcurrency ?? 3;
  const timeoutMs = input.timeoutMs ?? 12_000;

  // Group by host so we can bound concurrency per host rather than overall.
  const byHost = new Map<string, string[]>();
  let queued = 0;

  for (const url of input.targets.keys()) {
    if (queued >= input.maxChecks) break;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    const bucket = byHost.get(host) ?? [];
    bucket.push(url);
    byHost.set(host, bucket);
    queued += 1;
  }

  if (queued === 0) return [];
  input.reporter.info(`Verifying ${queued} link target(s) across ${byHost.size} host(s)`);

  const results: LinkCheckObservation[] = [];

  // Hosts are processed in parallel; URLs within a host are rate-limited.
  await Promise.all(
    [...byHost.entries()].map(async ([, urls]) => {
      const queue = [...urls];
      const workers = Array.from({ length: Math.min(perHost, queue.length) }, async () => {
        for (;;) {
          const url = queue.shift();
          if (!url) return;
          const observation = await checkOne(url, input, timeoutMs);
          results.push(observation);
        }
      });
      await Promise.all(workers);
    }),
  );

  const broken = results.filter((result) => isBroken(result)).length;
  if (broken > 0) input.reporter.warn(`${broken} broken link target(s) detected`);
  else input.reporter.success('No broken links detected');

  return results;
}

async function checkOne(
  url: string,
  input: LinkCheckInput,
  timeoutMs: number,
): Promise<LinkCheckObservation> {
  const referrers = [...(input.targets.get(url) ?? [])].slice(0, 20);
  const isInternal = safeOrigin(url) === input.seedOrigin;

  // HEAD first — cheap, and most servers answer it correctly.
  let result = await safeFetch(url, {
    ssrf: input.ssrf,
    userAgent: input.userAgent,
    method: 'HEAD',
    timeoutMs,
    maxRedirects: 5,
  });

  // Some servers return 405/501 for HEAD, or answer it wrongly. A 4xx/5xx from
  // HEAD is confirmed with a GET before we call the link broken — reporting a
  // working link as broken is the worst failure mode this checker has.
  if (!result.ok && (result.status === null || result.status >= 400)) {
    result = await safeFetch(url, {
      ssrf: input.ssrf,
      userAgent: input.userAgent,
      method: 'GET',
      timeoutMs,
      maxRedirects: 5,
      maxBytes: 32 * 1024,
    });
  }

  return {
    url: redactUrl(url),
    status: result.status,
    failureText: result.error,
    isInternal,
    referrers: referrers.map(redactUrl),
    redirectedTo: result.finalUrl !== url ? redactUrl(result.finalUrl) : null,
  };
}

export function isBroken(check: LinkCheckObservation): boolean {
  if (check.failureText) return true;
  return check.status !== null && check.status >= 400;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Build the link-check work list from crawled pages.
 * Internal links already visited are excluded — we have their real status from
 * the crawl and re-fetching would be wasted traffic.
 */
export function buildLinkTargets(options: {
  pages: Array<{ url: string; links: Array<{ absoluteUrl: string | null; isEmptyTarget: boolean }> }>;
  alreadyVisited: Set<string>;
  includeExternal: boolean;
  seedOrigin: string;
}): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();

  for (const page of options.pages) {
    for (const link of page.links) {
      if (!link.absoluteUrl || link.isEmptyTarget) continue;

      let normalized: string;
      try {
        const parsed = new URL(link.absoluteUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        parsed.hash = '';
        normalized = parsed.toString();
      } catch {
        continue;
      }

      const external = safeOrigin(normalized) !== options.seedOrigin;
      if (external && !options.includeExternal) continue;
      if (!external && options.alreadyVisited.has(normalized)) continue;

      const referrers = targets.get(normalized) ?? new Set<string>();
      referrers.add(page.url);
      targets.set(normalized, referrers);
    }
  }

  return targets;
}
