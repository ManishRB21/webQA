/**
 * URL normalization — the crawler's defence against infinite loops.
 *
 * Two URLs that render the same page must normalize to the same string, or the
 * crawler wastes its page budget re-probing identical content. The rules here
 * are conservative: we only strip things that are known-safe to strip, because
 * over-normalizing (e.g. dropping a `?page=2`) would silently skip real pages.
 */

/** Query parameters that never change page content. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'yclid',
  'ref',
  '_ga',
  '_gl',
  'ttclid',
  'li_fat_id',
  'vero_id',
  'wickedid',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
]);

/** Extensions we never want to spend a page budget on. */
const NON_PAGE_EXTENSIONS = new Set([
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.tiff',
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg', '.flac',
  '.css', '.js', '.mjs', '.map',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.dmg', '.exe', '.apk', '.deb', '.rpm', '.msi',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.rss', '.atom',
]);

export interface NormalizeOptions {
  /** Strip the fragment. Almost always correct; SPAs are handled separately. */
  stripFragment?: boolean;
  /** Remove known tracking parameters. */
  stripTrackingParams?: boolean;
  /** Sort remaining query parameters so order does not create duplicates. */
  sortQuery?: boolean;
  /** Drop a trailing slash on non-root paths. */
  stripTrailingSlash?: boolean;
  /** Lower-case the path. Unsafe on case-sensitive servers, so default false. */
  lowercasePath?: boolean;
}

const DEFAULTS: Required<NormalizeOptions> = {
  stripFragment: true,
  stripTrackingParams: true,
  sortQuery: true,
  stripTrailingSlash: true,
  lowercasePath: false,
};

/**
 * Produce a canonical form of a URL for deduplication.
 * Returns null when the input is not a usable http(s) URL.
 */
export function normalizeUrl(input: string, options: NormalizeOptions = {}): string | null {
  const opts = { ...DEFAULTS, ...options };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hostname = url.hostname.toLowerCase();
  // Drop default ports so http://x:80/ === http://x/
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  if (opts.stripFragment) url.hash = '';

  if (opts.stripTrackingParams) {
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
  }

  if (opts.sortQuery) {
    const entries = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted = new URLSearchParams();
    for (const [k, v] of entries) sorted.append(k, v);
    url.search = sorted.toString();
  }

  if (opts.lowercasePath) url.pathname = url.pathname.toLowerCase();

  if (opts.stripTrailingSlash && url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  // Collapse duplicate slashes, which some servers treat as equivalent.
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');

  return url.toString();
}

/** True when the URL points at a file we should not treat as a page. */
export function isNonPageResource(rawUrl: string): boolean {
  try {
    const { pathname } = new URL(rawUrl);
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot < 0) return false;
    const ext = pathname.slice(lastDot).toLowerCase();
    return NON_PAGE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

/** True when `candidate` is on the same registrable scope as `seed`. */
export function isSameSite(candidate: string, seed: string, includeSubdomains: boolean): boolean {
  try {
    const c = new URL(candidate);
    const s = new URL(seed);
    if (c.hostname === s.hostname) return true;
    if (!includeSubdomains) return false;
    // Naive but adequate: treat `foo.example.com` as inside `example.com`.
    const base = registrableSuffix(s.hostname);
    return c.hostname === base || c.hostname.endsWith(`.${base}`);
  } catch {
    return false;
  }
}

/**
 * Best-effort registrable domain. Not PSL-accurate — a full public-suffix list
 * is overkill for scope decisions where the failure mode is "crawl one extra
 * subdomain we own".
 */
export function registrableSuffix(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  // Handle common two-part TLDs (co.uk, com.au, ...).
  const twoPart = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);
  const secondLast = parts[parts.length - 2];
  if (secondLast && twoPart.has(secondLast) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * Detect URL shapes that indicate an infinite crawl trap:
 * repeated path segments, deep pagination, calendars, session ids.
 */
export function looksLikeCrawlTrap(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'unparseable';
  }

  const segments = url.pathname.split('/').filter(Boolean);

  // Same segment repeated 3+ times: /a/b/a/b/a/b
  const counts = new Map<string, number>();
  for (const seg of segments) {
    const n = (counts.get(seg) ?? 0) + 1;
    counts.set(seg, n);
    if (n >= 3) return `repeated path segment "${seg}"`;
  }

  if (segments.length > 12) return 'excessive path depth';

  // Calendar traps: /2019/04/12/... with a far-future or far-past year.
  const yearSeg = segments.find((s) => /^(19|20)\d{2}$/.test(s));
  if (yearSeg) {
    const year = Number(yearSeg);
    const now = new Date().getUTCFullYear();
    if (year < now - 30 || year > now + 2) return `calendar trap (year ${year})`;
  }

  // Session identifiers in the query string.
  for (const key of url.searchParams.keys()) {
    if (/^(phpsessid|jsessionid|sid|sessionid|session_id)$/i.test(key)) {
      return `session id parameter "${key}"`;
    }
  }

  // Deep pagination past a reasonable point.
  for (const [key, value] of url.searchParams.entries()) {
    if (/^(page|p|offset|start|from)$/i.test(key)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 50) return `deep pagination (${key}=${value})`;
    }
  }

  // Absurd query complexity usually means faceted-search explosion.
  if ([...url.searchParams.keys()].length > 8) return 'faceted search explosion';

  return null;
}

/** Resolve a possibly-relative href against a base URL. */
export function resolveUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('data:') ||
    lower.startsWith('sms:') ||
    lower.startsWith('blob:') ||
    lower === '#'
  ) {
    return null;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}
