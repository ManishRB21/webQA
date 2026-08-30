/**
 * Passive collectors attached to a page before navigation.
 *
 * Each collector accumulates raw observations for the lifetime of one page
 * probe. They are deliberately passive — they record, they never assert. The
 * moment a collector starts deciding "this is a bug" the evidence chain breaks.
 */

import type { Page, Request, Response, ConsoleMessage } from 'playwright';
import type {
  ConsoleLevel,
  ConsoleObservation,
  NetworkObservation,
  PageErrorObservation,
  ResourceKind,
} from '@webqa/shared';
import { redactHeaders, redactText, redactUrl, truncate } from '@webqa/shared';

/** Map Playwright's resource type onto our narrower vocabulary. */
function toResourceKind(resourceType: string): ResourceKind {
  switch (resourceType) {
    case 'document': return 'document';
    case 'stylesheet': return 'stylesheet';
    case 'script': return 'script';
    case 'image': return 'image';
    case 'font': return 'font';
    case 'xhr': return 'xhr';
    case 'fetch': return 'fetch';
    case 'media': return 'media';
    case 'websocket': return 'websocket';
    case 'manifest': return 'manifest';
    default: return 'other';
  }
}

/** Response headers worth keeping. Everything else is noise in the evidence view. */
const INTERESTING_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'cache-control', 'expires',
  'etag', 'last-modified', 'age', 'vary', 'server', 'location',
  'strict-transport-security', 'content-security-policy',
  'content-security-policy-report-only', 'x-content-type-options',
  'x-frame-options', 'referrer-policy', 'permissions-policy',
  'cross-origin-opener-policy', 'cross-origin-resource-policy',
  'cross-origin-embedder-policy', 'access-control-allow-origin', 'timing-allow-origin',
]);

export class NetworkCollector {
  private readonly requests = new Map<Request, Partial<NetworkObservation> & { startedAtMs: number }>();
  private readonly finished: NetworkObservation[] = [];
  private navigationStart = Date.now();
  private pageHost = '';
  private sequence = 0;

  /** Requests observed since the last `markInteractionStart()` call. */
  private interactionMark: number | null = null;

  attach(page: Page, pageUrl: string): void {
    this.navigationStart = Date.now();
    try {
      this.pageHost = new URL(pageUrl).host;
    } catch {
      this.pageHost = '';
    }

    page.on('request', this.onRequest);
    page.on('response', this.onResponse);
    page.on('requestfinished', this.onRequestFinished);
    page.on('requestfailed', this.onRequestFailed);
  }

  detach(page: Page): void {
    page.off('request', this.onRequest);
    page.off('response', this.onResponse);
    page.off('requestfinished', this.onRequestFinished);
    page.off('requestfailed', this.onRequestFailed);
  }

  private readonly onRequest = (request: Request): void => {
    this.requests.set(request, {
      requestId: `req-${++this.sequence}`,
      startedAtMs: Date.now() - this.navigationStart,
    });
  };

  private readonly onResponse = (response: Response): void => {
    const entry = this.requests.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    entry.statusText = response.statusText();

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers())) {
      const lower = key.toLowerCase();
      if (INTERESTING_HEADERS.has(lower)) headers[lower] = truncate(value, 2000);
    }
    entry.responseHeaders = redactHeaders(headers);
    entry.mimeType = headers['content-type']?.split(';')[0]?.trim() ?? null;
    entry.fromCache = false;
  };

  private readonly onRequestFinished = (request: Request): void => {
    void this.finalize(request, null);
  };

  private readonly onRequestFailed = (request: Request): void => {
    void this.finalize(request, request.failure()?.errorText ?? 'unknown failure');
  };

  private async finalize(request: Request, failureText: string | null): Promise<void> {
    const entry = this.requests.get(request);
    if (!entry) return;
    this.requests.delete(request);

    const url = request.url();
    let origin = '';
    let isThirdParty = false;
    try {
      const parsed = new URL(url);
      origin = parsed.origin;
      isThirdParty = Boolean(this.pageHost) && parsed.host !== this.pageHost;
    } catch {
      origin = 'invalid';
    }

    // `sizes()` is only available for finished requests and can throw when the
    // page navigated away mid-flight.
    let transferSizeBytes: number | null = null;
    let resourceSizeBytes: number | null = null;
    let protocol: string | null = null;
    try {
      const sizes = await request.sizes();
      transferSizeBytes = sizes.responseBodySize + sizes.responseHeadersSize;
      resourceSizeBytes = sizes.responseBodySize;
    } catch {
      // Leave null — an unknown size is honest; a zero would be a lie the
      // payload-composition chart would then repeat.
    }
    try {
      const response = await request.response();
      if (response) {
        const timing = request.timing();
        protocol = (await response.serverAddr().catch(() => null)) ? null : null;
        if (timing && timing.responseEnd > 0 && timing.startTime > 0) {
          entry.durationMs = Math.max(0, timing.responseEnd - timing.requestStart);
        }
      }
    } catch {
      // ignore
    }

    const redirectChain: string[] = [];
    let redirected = request.redirectedFrom();
    let guard = 0;
    while (redirected && guard < 20) {
      redirectChain.unshift(redactUrl(redirected.url()));
      redirected = redirected.redirectedFrom();
      guard += 1;
    }

    this.finished.push({
      requestId: entry.requestId ?? `req-${++this.sequence}`,
      url: redactUrl(url),
      origin,
      method: request.method(),
      resourceKind: toResourceKind(request.resourceType()),
      status: entry.status ?? null,
      statusText: entry.statusText ?? null,
      failureText,
      transferSizeBytes,
      resourceSizeBytes,
      mimeType: entry.mimeType ?? null,
      durationMs: entry.durationMs ?? null,
      startedAtMs: entry.startedAtMs,
      fromCache: entry.fromCache ?? false,
      isThirdParty,
      responseHeaders: entry.responseHeaders ?? {},
      redirectChain,
      protocol,
    });
  }

  /** Wait briefly for in-flight `finalize` calls to settle. */
  async drain(waitMs = 500): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (this.requests.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  all(): NetworkObservation[] {
    return [...this.finished];
  }

  markInteractionStart(): void {
    this.interactionMark = this.finished.length;
  }

  /** Requests recorded since the last `markInteractionStart()`. */
  sinceInteractionStart(): NetworkObservation[] {
    if (this.interactionMark === null) return [];
    return this.finished.slice(this.interactionMark);
  }
}

export class ConsoleCollector {
  private readonly messages: ConsoleObservation[] = [];
  private readonly errors: PageErrorObservation[] = [];
  private navigationStart = Date.now();
  private messageMark = 0;
  private errorMark = 0;

  attach(page: Page): void {
    this.navigationStart = Date.now();
    page.on('console', this.onConsole);
    page.on('pageerror', this.onPageError);
  }

  detach(page: Page): void {
    page.off('console', this.onConsole);
    page.off('pageerror', this.onPageError);
  }

  private readonly onConsole = (message: ConsoleMessage): void => {
    // Cap retained messages — a page in a logging loop can emit thousands.
    if (this.messages.length >= 500) return;

    const type = message.type();
    const level: ConsoleLevel =
      type === 'error' ? 'error'
      : type === 'warning' ? 'warning'
      : type === 'info' ? 'info'
      : type === 'debug' ? 'debug'
      : 'log';

    const location = message.location();
    this.messages.push({
      level,
      text: truncate(redactText(message.text()), 1000),
      url: location.url ? redactUrl(location.url) : null,
      lineNumber: location.lineNumber ?? null,
      atMs: Date.now() - this.navigationStart,
    });
  };

  private readonly onPageError = (error: Error): void => {
    if (this.errors.length >= 200) return;
    this.errors.push({
      name: error.name || 'Error',
      message: truncate(redactText(error.message), 1000),
      stack: error.stack ? truncate(redactText(error.stack), 2000) : null,
      atMs: Date.now() - this.navigationStart,
    });
  };

  allMessages(): ConsoleObservation[] {
    return [...this.messages];
  }

  allErrors(): PageErrorObservation[] {
    return [...this.errors];
  }

  markInteractionStart(): void {
    this.messageMark = this.messages.length;
    this.errorMark = this.errors.length;
  }

  messagesSinceInteractionStart(): ConsoleObservation[] {
    return this.messages.slice(this.messageMark);
  }

  errorsSinceInteractionStart(): PageErrorObservation[] {
    return this.errors.slice(this.errorMark);
  }
}
