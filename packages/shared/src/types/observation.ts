/**
 * Observations are the raw, factual output of the deterministic probes.
 *
 * The single most important invariant in this system:
 *
 *   Observations are FACTS. Findings are INTERPRETATION.
 *
 * A probe never decides that something is a bug — it records what the browser
 * did. The rule engine reads observations and produces findings. The AI layer
 * reads findings (plus their supporting observations) and enriches them. This
 * ordering is what makes the report defensible: every claim traces back to a
 * concrete observation with a timestamp.
 */

import type { DeviceProfile, NetworkProfile } from './common.js';

// ── Network ────────────────────────────────────────────────────────────────

export type ResourceKind =
  | 'document'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'xhr'
  | 'fetch'
  | 'media'
  | 'websocket'
  | 'manifest'
  | 'other';

export interface NetworkObservation {
  requestId: string;
  url: string;
  /** Origin of the request URL, precomputed for third-party analysis. */
  origin: string;
  method: string;
  resourceKind: ResourceKind;
  /** Null when the request never produced a response (aborted / DNS failure). */
  status: number | null;
  statusText: string | null;
  /** Playwright's failure text, e.g. `net::ERR_CONNECTION_REFUSED`. */
  failureText: string | null;
  /** Transfer size in bytes as reported by the protocol layer, when known. */
  transferSizeBytes: number | null;
  /** Decoded body size in bytes, when known. */
  resourceSizeBytes: number | null;
  mimeType: string | null;
  /** Milliseconds from navigation start to response end. */
  durationMs: number | null;
  startedAtMs: number;
  fromCache: boolean;
  /** True when the request host differs from the page host. */
  isThirdParty: boolean;
  /** Selected response headers, lower-cased keys. Cookies are stripped. */
  responseHeaders: Record<string, string>;
  /** Chain of redirect URLs that led here, if any. */
  redirectChain: string[];
  /** HTTP protocol version if the CDP layer reported it, e.g. `h2`, `http/1.1`. */
  protocol: string | null;
}

// ── Console + runtime errors ───────────────────────────────────────────────

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'log' | 'debug';

export interface ConsoleObservation {
  level: ConsoleLevel;
  text: string;
  /** Source location when the browser provided one. */
  url: string | null;
  lineNumber: number | null;
  /** Milliseconds since navigation start. */
  atMs: number;
}

export interface PageErrorObservation {
  name: string;
  message: string;
  stack: string | null;
  atMs: number;
}

// ── Navigation + transport ─────────────────────────────────────────────────

export interface NavigationObservation {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  redirectChain: Array<{ url: string; status: number }>;
  /** True when the final URL's origin differs from the requested one. */
  crossOriginRedirect: boolean;
  timing: {
    ttfbMs: number | null;
    domContentLoadedMs: number | null;
    loadEventMs: number | null;
  };
  /** Populated for HTTPS only. */
  tls: {
    protocol: string | null;
    issuer: string | null;
    subjectName: string | null;
    validFrom: string | null;
    validTo: string | null;
  } | null;
}

// ── Web vitals + performance ───────────────────────────────────────────────

export interface WebVitalsObservation {
  /** Largest Contentful Paint, ms. */
  lcpMs: number | null;
  /** The element selector responsible for LCP — the key to actionable advice. */
  lcpElement: string | null;
  /** The resource URL behind the LCP element, when it is an image. */
  lcpResourceUrl: string | null;
  /** First Contentful Paint, ms. */
  fcpMs: number | null;
  /** Cumulative Layout Shift, unitless. */
  cls: number | null;
  /** The largest single shift's contributing elements. */
  clsSources: string[];
  /** Interaction to Next Paint, ms. Only present when an interaction occurred. */
  inpMs: number | null;
  /** Time To First Byte, ms. */
  ttfbMs: number | null;
  /** Total Blocking Time, ms — derived from long tasks. */
  tbtMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
}

export interface LongTaskObservation {
  startTimeMs: number;
  durationMs: number;
  /** Attribution container name when the browser supplies it. */
  attribution: string | null;
}

export interface CoverageObservation {
  url: string;
  kind: 'script' | 'stylesheet';
  totalBytes: number;
  usedBytes: number;
  /** 0..1 — fraction of bytes never executed / never matched. */
  unusedRatio: number;
}

// ── DOM + content ──────────────────────────────────────────────────────────

export interface HeadingObservation {
  level: number;
  text: string;
}

export interface LinkObservation {
  href: string;
  /** Resolved absolute URL, or null when the href could not be resolved. */
  absoluteUrl: string | null;
  text: string;
  isInternal: boolean;
  /** True for `href=""`, `href="#"`, or `javascript:void(0)`. */
  isEmptyTarget: boolean;
  rel: string | null;
  target: string | null;
  selector: string;
}

export interface ImageObservation {
  src: string | null;
  absoluteUrl: string | null;
  alt: string | null;
  /** True when the alt attribute is entirely absent (distinct from alt=""). */
  altMissing: boolean;
  width: number | null;
  height: number | null;
  naturalWidth: number | null;
  naturalHeight: number | null;
  loading: string | null;
  /** True when the browser reports the image failed to decode. */
  broken: boolean;
  /** True when the element is inside the initial viewport. */
  inViewport: boolean;
  selector: string;
}

export interface FormObservation {
  selector: string;
  action: string | null;
  method: string | null;
  fieldCount: number;
  /** Fields with no accessible label of any kind. */
  unlabeledFields: Array<{ selector: string; type: string; name: string | null }>;
  hasSubmitControl: boolean;
}

export interface InteractiveElementObservation {
  selector: string;
  tag: string;
  role: string | null;
  /** Computed accessible name, empty string when there is none. */
  accessibleName: string;
  visible: boolean;
  enabled: boolean;
  inViewport: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  /** True when another element sits on top of this element's center point. */
  obscuredBy: string | null;
}

export interface MetaObservation {
  title: string | null;
  /** Number of <title> elements found — more than one is a bug. */
  titleCount: number;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  langAttribute: string | null;
  charset: string | null;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  /** Parsed JSON-LD blocks; invalid JSON is recorded in `structuredDataErrors`. */
  structuredData: unknown[];
  structuredDataErrors: string[];
  headings: HeadingObservation[];
  /** IDs that appear more than once in the document. */
  duplicateIds: string[];
  /** Landmark roles present on the page. */
  landmarks: string[];
  htmlBytes: number;
  wordCount: number;
}

// ── Layout / visual ────────────────────────────────────────────────────────

export type LayoutIssueKind =
  | 'HORIZONTAL_OVERFLOW'
  | 'ELEMENT_OUTSIDE_VIEWPORT'
  | 'OVERLAPPING_INTERACTIVE'
  | 'CLIPPED_TEXT'
  | 'TINY_TAP_TARGET'
  | 'LARGE_BLANK_AREA';

export interface LayoutObservation {
  kind: LayoutIssueKind;
  selector: string;
  detail: string;
  /** Measured numbers backing the claim, e.g. `{ documentWidth, viewportWidth }`. */
  measurements: Record<string, number>;
}

// ── Accessibility ──────────────────────────────────────────────────────────

export interface AxeNodeObservation {
  target: string[];
  html: string;
  failureSummary: string | null;
}

export interface AxeViolationObservation {
  ruleId: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  description: string;
  help: string;
  helpUrl: string;
  /** WCAG success criteria tags, e.g. `wcag2a`, `wcag143`. */
  tags: string[];
  nodes: AxeNodeObservation[];
}

// ── Interaction testing ────────────────────────────────────────────────────

export type InteractionOutcome =
  | 'NAVIGATED'
  | 'DOM_CHANGED'
  | 'NETWORK_ACTIVITY'
  | 'NO_OBSERVABLE_EFFECT'
  | 'THREW_EXCEPTION'
  | 'TIMED_OUT'
  | 'NOT_ACTIONABLE';

export interface InteractionObservation {
  selector: string;
  label: string;
  elementKind: 'button' | 'link' | 'tab' | 'menu' | 'accordion' | 'modal-trigger' | 'submit';
  outcome: InteractionOutcome;
  /** Console errors captured strictly between click and settle. */
  consoleErrors: ConsoleObservation[];
  pageErrors: PageErrorObservation[];
  /** Requests issued strictly between click and settle. */
  networkRequests: NetworkObservation[];
  /** Requests above that returned >= 400. */
  failedRequests: NetworkObservation[];
  urlBefore: string;
  urlAfter: string;
  domMutationCount: number;
  durationMs: number;
  /** Screenshot key in evidence storage, captured on a non-clean outcome. */
  screenshotKey: string | null;
}

// ── Security posture (passive) ─────────────────────────────────────────────

export interface SecurityHeaderObservation {
  url: string;
  isHttps: boolean;
  /** Raw header values, lower-cased keys, cookies excluded. */
  headers: Record<string, string>;
  /** Cookie flags observed via CDP, values redacted. */
  cookies: Array<{
    name: string;
    domain: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: string | null;
  }>;
  /** http:// subresources loaded from an https:// page. */
  mixedContentUrls: string[];
  /** Distinct third-party script origins. */
  thirdPartyScriptOrigins: string[];
}

// ── Site-level (crawl scope, not per page) ─────────────────────────────────

export interface RobotsObservation {
  found: boolean;
  url: string;
  status: number | null;
  sitemapUrls: string[];
  /** Disallow rules that apply to our user-agent. */
  disallowedPaths: string[];
  raw: string | null;
}

export interface SitemapObservation {
  found: boolean;
  url: string;
  status: number | null;
  urlCount: number;
  /** Capped sample of URLs discovered, used to seed the crawl frontier. */
  sampleUrls: string[];
  parseError: string | null;
}

export interface LinkCheckObservation {
  url: string;
  status: number | null;
  failureText: string | null;
  isInternal: boolean;
  /** Pages on which this link was found. */
  referrers: string[];
  redirectedTo: string | null;
}

// ── Lighthouse (optional, bounded) ─────────────────────────────────────────

export interface LighthouseObservation {
  url: string;
  categories: Record<string, number | null>;
  audits: Record<
    string,
    { score: number | null; numericValue: number | null; displayValue: string | null }
  >;
}

// ── Per-page bundle ────────────────────────────────────────────────────────

/**
 * Everything a single page probe produced. This is the unit the rule engine
 * consumes, and the unit persisted as an evidence row.
 */
export interface PageObservations {
  url: string;
  /** Depth in the crawl tree; 0 is the seed URL. */
  depth: number;
  /** The page we followed a link from, when applicable. */
  discoveredFrom: string | null;
  device: DeviceProfile;
  network: NetworkProfile;
  startedAt: string;
  finishedAt: string;
  /** Set when the page could not be probed at all. */
  probeError: string | null;

  navigation: NavigationObservation | null;
  meta: MetaObservation | null;
  vitals: WebVitalsObservation | null;
  longTasks: LongTaskObservation[];
  coverage: CoverageObservation[];
  requests: NetworkObservation[];
  console: ConsoleObservation[];
  pageErrors: PageErrorObservation[];
  links: LinkObservation[];
  images: ImageObservation[];
  forms: FormObservation[];
  interactiveElements: InteractiveElementObservation[];
  layout: LayoutObservation[];
  axeViolations: AxeViolationObservation[];
  interactions: InteractionObservation[];
  security: SecurityHeaderObservation | null;
  lighthouse: LighthouseObservation | null;
  screenshots: {
    viewportKey: string | null;
    fullPageKey: string | null;
  };
}

/**
 * Observations that describe the site as a whole rather than one page.
 */
export interface SiteObservations {
  seedUrl: string;
  origin: string;
  robots: RobotsObservation | null;
  sitemap: SitemapObservation | null;
  linkChecks: LinkCheckObservation[];
  /** URLs discovered but skipped, with the reason — useful for transparency. */
  skipped: Array<{ url: string; reason: string }>;
}
