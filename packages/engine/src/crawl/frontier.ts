/**
 * The crawl frontier.
 *
 * A priority queue of URLs still to visit, plus every rule about what we are
 * willing to visit at all. Two failure modes drive the design:
 *
 *   - Crawling forever. A faceted-search page or a calendar generates infinite
 *     distinct URLs. Guards: normalization, trap detection, depth and page caps.
 *
 *   - Crawling the wrong things. A budget of 25 pages spent on paginated
 *     archive pages tells the user nothing. So the frontier is a PRIORITY
 *     queue: navigation links, short paths and recognisable key pages
 *     (checkout, pricing, contact) outrank a blog post from 2017.
 */

import {
  isNonPageResource,
  isSameSite,
  looksLikeCrawlTrap,
  normalizeUrl,
} from '@webqa/shared';

export interface FrontierEntry {
  url: string;
  normalizedUrl: string;
  depth: number;
  discoveredFrom: string | null;
  priority: number;
}

export interface FrontierOptions {
  seedUrl: string;
  maxDepth: number;
  includeSubdomains: boolean;
  includePaths: string[];
  excludePaths: string[];
  /** Paths disallowed by robots.txt, when we are respecting it. */
  disallowedPaths: string[];
  respectRobots: boolean;
}

export interface SkippedUrl {
  url: string;
  reason: string;
}

/**
 * Path segments that usually indicate a page worth spending budget on.
 * Deliberately commerce- and conversion-flavoured: those are the pages where a
 * functional bug actually costs the site owner money.
 */
const HIGH_VALUE_PATTERNS: Array<{ pattern: RegExp; boost: number }> = [
  { pattern: /\/(checkout|cart|basket|payment|billing)(\/|$)/i, boost: 90 },
  { pattern: /\/(pricing|plans|subscribe|upgrade)(\/|$)/i, boost: 70 },
  { pattern: /\/(login|signin|signup|register|account)(\/|$)/i, boost: 60 },
  { pattern: /\/(contact|support|help)(\/|$)/i, boost: 45 },
  { pattern: /\/(product|products|shop|store|item)(\/|$)/i, boost: 50 },
  { pattern: /\/(search|browse|category|collections?)(\/|$)/i, boost: 40 },
  { pattern: /\/(about|services|features|solutions)(\/|$)/i, boost: 35 },
  { pattern: /\/(docs|documentation|api)(\/|$)/i, boost: 30 },
];

/** Segments that are usually low-value for auditing purposes. */
const LOW_VALUE_PATTERNS: Array<{ pattern: RegExp; penalty: number }> = [
  { pattern: /\/(tag|tags|author|archive|archives)(\/|$)/i, penalty: 40 },
  { pattern: /\/(privacy|terms|legal|cookie-policy|gdpr)(\/|$)/i, penalty: 30 },
  { pattern: /\/\d{4}\/\d{2}(\/|$)/, penalty: 35 },
  { pattern: /\/(feed|rss|atom|amp)(\/|$)/i, penalty: 50 },
  { pattern: /\/(page|p)\/\d+(\/|$)/i, penalty: 25 },
];

export class Frontier {
  private readonly queue: FrontierEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly skipped: SkippedUrl[] = [];
  private readonly seedOrigin: string;

  constructor(private readonly options: FrontierOptions) {
    this.seedOrigin = safeOrigin(options.seedUrl);
  }

  /**
   * Offer a URL to the frontier. Returns true when it was accepted.
   * Every rejection is recorded with a reason so the report can explain what it
   * chose not to look at — an audit that silently skips half a site is worse
   * than one that says why.
   */
  add(rawUrl: string, depth: number, discoveredFrom: string | null): boolean {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      this.skip(rawUrl, 'not a usable http(s) URL');
      return false;
    }

    if (this.seen.has(normalized)) return false;

    if (depth > this.options.maxDepth) {
      this.skip(normalized, `beyond max depth (${this.options.maxDepth})`);
      this.seen.add(normalized);
      return false;
    }

    if (!isSameSite(normalized, this.options.seedUrl, this.options.includeSubdomains)) {
      this.skip(normalized, 'external host');
      this.seen.add(normalized);
      return false;
    }

    if (isNonPageResource(normalized)) {
      this.skip(normalized, 'binary or asset URL, not a page');
      this.seen.add(normalized);
      return false;
    }

    const trap = looksLikeCrawlTrap(normalized);
    if (trap) {
      this.skip(normalized, `crawl trap: ${trap}`);
      this.seen.add(normalized);
      return false;
    }

    const path = safePath(normalized);

    if (this.options.includePaths.length > 0) {
      const matches = this.options.includePaths.some((prefix) => path.startsWith(prefix));
      if (!matches) {
        this.skip(normalized, 'not matched by include-paths filter');
        this.seen.add(normalized);
        return false;
      }
    }

    if (this.options.excludePaths.some((prefix) => path.startsWith(prefix))) {
      this.skip(normalized, 'matched exclude-paths filter');
      this.seen.add(normalized);
      return false;
    }

    if (this.options.respectRobots && this.isDisallowed(path)) {
      this.skip(normalized, 'disallowed by robots.txt');
      this.seen.add(normalized);
      return false;
    }

    this.seen.add(normalized);
    this.queue.push({
      url: normalized,
      normalizedUrl: normalized,
      depth,
      discoveredFrom,
      priority: scoreUrl(normalized, depth, this.seedOrigin),
    });
    return true;
  }

  /** Pop the highest-priority URL. */
  next(): FrontierEntry | null {
    if (this.queue.length === 0) return null;
    let bestIndex = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      const candidate = this.queue[index]!;
      const best = this.queue[bestIndex]!;
      // Shallower wins ties: breadth-first gives a better site overview than
      // diving down one branch.
      if (candidate.priority > best.priority || (candidate.priority === best.priority && candidate.depth < best.depth)) {
        bestIndex = index;
      }
    }
    return this.queue.splice(bestIndex, 1)[0] ?? null;
  }

  get pending(): number {
    return this.queue.length;
  }

  get discovered(): number {
    return this.seen.size;
  }

  skippedUrls(): SkippedUrl[] {
    return [...this.skipped];
  }

  hasSeen(url: string): boolean {
    const normalized = normalizeUrl(url);
    return normalized ? this.seen.has(normalized) : false;
  }

  private skip(url: string, reason: string): void {
    // Cap the skip log; a faceted-search site can generate tens of thousands.
    if (this.skipped.length < 500) this.skipped.push({ url, reason });
  }

  /**
   * robots.txt matching.
   * Prefix semantics with `*` wildcard support — the two forms that account for
   * essentially all real-world rules.
   */
  private isDisallowed(path: string): boolean {
    for (const rule of this.options.disallowedPaths) {
      if (!rule) continue;
      if (rule.includes('*')) {
        const pattern = new RegExp(
          `^${rule.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}`,
        );
        if (pattern.test(path)) return true;
      } else if (path.startsWith(rule)) {
        return true;
      }
    }
    return false;
  }
}

/** Compute a crawl priority. Higher is crawled sooner. */
export function scoreUrl(url: string, depth: number, seedOrigin: string): number {
  let score = 100;

  // Depth is the strongest signal: the homepage and its immediate neighbours
  // are what most users actually see.
  score -= depth * 25;

  const path = safePath(url);

  // The root page is always the most important thing on a site.
  if (path === '/' || path === '') score += 120;

  const segments = path.split('/').filter(Boolean).length;
  score -= segments * 6;

  for (const { pattern, boost } of HIGH_VALUE_PATTERNS) {
    if (pattern.test(path)) {
      score += boost;
      break;
    }
  }

  for (const { pattern, penalty } of LOW_VALUE_PATTERNS) {
    if (pattern.test(path)) {
      score -= penalty;
      break;
    }
  }

  // Query strings usually mean a filtered variant of a page we already have.
  try {
    const params = new URL(url).searchParams;
    const count = [...params.keys()].length;
    if (count > 0) score -= 15 + count * 5;
  } catch { /* ignore */ }

  // Off-origin (subdomain) pages are secondary to the main host.
  if (safeOrigin(url) !== seedOrigin) score -= 20;

  return score;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
