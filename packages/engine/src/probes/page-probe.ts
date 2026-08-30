/**
 * The page probe — one page in, one `PageObservations` bundle out.
 *
 * Ordering matters and is not arbitrary:
 *
 *   1. Attach collectors and inject the vitals script BEFORE navigating, or we
 *      miss the events we came to measure.
 *   2. Navigate, then settle. "Settle" is deliberately not `networkidle`,
 *      which never fires on sites with polling or open websockets.
 *   3. Extract the DOM and read vitals while the page is still pristine.
 *   4. Screenshot.
 *   5. Interact LAST, because interaction mutates the page and would poison
 *      every measurement above it.
 */

import type { BrowserContext, Page } from 'playwright';
import type {
  DeviceProfile,
  NavigationObservation,
  NetworkProfile,
  PageObservations,
  SecurityHeaderObservation,
} from '@webqa/shared';
import { redactUrl } from '@webqa/shared';
import type { EngineConfig } from '../config.js';
import type { Reporter } from '../logger.js';
import { BrowserSession, withTimeout } from '../browser/session.js';
import { ConsoleCollector, NetworkCollector } from '../browser/collectors.js';
import { VITALS_INIT_SCRIPT, extractDom, readVitals } from '../browser/in-page.js';
import { runAxe } from './axe.js';
import { probeInteractions } from './interactions.js';
import type { EvidenceStore } from '../store/evidence.js';

export interface PageProbeInput {
  url: string;
  depth: number;
  discoveredFrom: string | null;
  device: DeviceProfile;
  network: NetworkProfile;
  interactionTesting: boolean;
}

export interface PageProbeDeps {
  session: BrowserSession;
  config: EngineConfig;
  reporter: Reporter;
  evidence: EvidenceStore;
  auditId: string;
}

export async function probePage(input: PageProbeInput, deps: PageProbeDeps): Promise<PageObservations> {
  const { session, config, reporter, evidence } = deps;
  const startedAt = new Date().toISOString();

  const observations: PageObservations = {
    url: input.url,
    depth: input.depth,
    discoveredFrom: input.discoveredFrom,
    device: input.device,
    network: input.network,
    startedAt,
    finishedAt: startedAt,
    probeError: null,
    navigation: null,
    meta: null,
    vitals: null,
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
    security: null,
    lighthouse: null,
    screenshots: { viewportKey: null, fullPageKey: null },
  };

  let context: BrowserContext | null = null;
  const networkCollector = new NetworkCollector();
  const consoleCollector = new ConsoleCollector();

  try {
    context = await session.createContext({
      device: input.device,
      network: input.network,
      userAgent: config.userAgent,
      navigationTimeoutMs: config.limits.navigationTimeoutMs,
    });

    // Inject before any page script runs.
    await context.addInitScript(VITALS_INIT_SCRIPT);

    const page = await context.newPage();
    await session.applyNetworkProfile(page, input.network);

    networkCollector.attach(page, input.url);
    consoleCollector.attach(page);

    // Coverage must be started before navigation to capture the initial bundle.
    let coverageStarted = false;
    try {
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await page.coverage.startCSSCoverage({ resetOnNavigation: false });
      coverageStarted = true;
    } catch {
      // Coverage is Chromium-only and best-effort.
    }

    // ── navigate ──────────────────────────────────────────────────────────
    const navigationStart = Date.now();
    const response = await page
      .goto(input.url, { waitUntil: 'domcontentloaded', timeout: config.limits.navigationTimeoutMs })
      .catch((error: Error) => {
        observations.probeError = `Navigation failed: ${error.message}`;
        return null;
      });

    if (observations.probeError) {
      reporter.warn(`Could not load ${redactUrl(input.url)}`, { reason: observations.probeError });
    }

    await settle(page, config.limits.navigationTimeoutMs);
    const loadDurationMs = Date.now() - navigationStart;

    // ── navigation + TLS ──────────────────────────────────────────────────
    const finalUrl = page.url();
    const redirectChain: Array<{ url: string; status: number }> = [];
    try {
      let previous = response?.request().redirectedFrom();
      let guard = 0;
      while (previous && guard < 20) {
        const previousResponse = await previous.response().catch(() => null);
        redirectChain.unshift({
          url: redactUrl(previous.url()),
          status: previousResponse?.status() ?? 0,
        });
        previous = previous.redirectedFrom();
        guard += 1;
      }
    } catch { /* ignore */ }

    let tls: NavigationObservation['tls'] = null;
    try {
      // securityDetails() exposes plain properties, and the validity fields are
      // Unix seconds rather than milliseconds.
      const security = await response?.securityDetails();
      if (security) {
        tls = {
          protocol: security.protocol ?? null,
          issuer: security.issuer ?? null,
          subjectName: security.subjectName ?? null,
          validFrom: security.validFrom ? new Date(security.validFrom * 1000).toISOString() : null,
          validTo: security.validTo ? new Date(security.validTo * 1000).toISOString() : null,
        };
      }
    } catch { /* ignore */ }

    // ── vitals ────────────────────────────────────────────────────────────
    const vitalsResult = await page.evaluate(readVitals).catch(() => null);
    if (vitalsResult) {
      observations.vitals = vitalsResult.vitals;
      observations.longTasks = vitalsResult.longTasks;
    }

    observations.navigation = {
      requestedUrl: redactUrl(input.url),
      finalUrl: redactUrl(finalUrl),
      status: response?.status() ?? null,
      redirectChain,
      crossOriginRedirect: safeOrigin(input.url) !== safeOrigin(finalUrl),
      timing: {
        ttfbMs: observations.vitals?.ttfbMs ?? null,
        domContentLoadedMs: observations.vitals?.domContentLoadedMs ?? null,
        loadEventMs: observations.vitals?.loadEventMs ?? loadDurationMs,
      },
      tls,
    };

    // ── DOM ───────────────────────────────────────────────────────────────
    const dom = await page
      .evaluate(extractDom, { maxLinks: 400, maxImages: 200, maxInteractive: 150 })
      .catch((error: Error) => {
        reporter.debug(`DOM extraction failed on ${redactUrl(input.url)}: ${error.message}`);
        return null;
      });

    if (dom) {
      observations.meta = dom.meta;
      observations.links = dom.links;
      observations.images = dom.images;
      observations.forms = dom.forms;
      observations.interactiveElements = dom.interactive;
      observations.layout = dom.layout;
    }

    // ── accessibility ─────────────────────────────────────────────────────
    observations.axeViolations = await runAxe(page).catch(() => []);

    // ── coverage ──────────────────────────────────────────────────────────
    if (coverageStarted) {
      try {
        const [js, css] = await Promise.all([
          page.coverage.stopJSCoverage(),
          page.coverage.stopCSSCoverage(),
        ]);
        for (const entry of js) {
          const total = entry.source?.length ?? 0;
          if (total === 0) continue;
          const used = entry.functions.reduce(
            (sum, fn) => sum + fn.ranges.filter((r) => r.count > 0).reduce((s, r) => s + (r.endOffset - r.startOffset), 0),
            0,
          );
          observations.coverage.push({
            url: redactUrl(entry.url),
            kind: 'script',
            totalBytes: total,
            usedBytes: Math.min(used, total),
            unusedRatio: total > 0 ? Math.max(0, 1 - Math.min(used, total) / total) : 0,
          });
        }
        for (const entry of css) {
          const total = entry.text?.length ?? 0;
          if (total === 0) continue;
          const used = entry.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
          observations.coverage.push({
            url: redactUrl(entry.url),
            kind: 'stylesheet',
            totalBytes: total,
            usedBytes: Math.min(used, total),
            unusedRatio: total > 0 ? Math.max(0, 1 - Math.min(used, total) / total) : 0,
          });
        }
      } catch { /* ignore */ }
    }

    // ── security posture (passive) ────────────────────────────────────────
    observations.security = await collectSecurity(page, response, finalUrl);

    // ── screenshots ───────────────────────────────────────────────────────
    try {
      const viewportShot = await page.screenshot({ type: 'jpeg', quality: 72, timeout: 15_000 });
      observations.screenshots.viewportKey = await evidence.putScreenshot(
        deps.auditId, finalUrl, 'viewport', viewportShot,
      );
    } catch { /* a screenshot failure must not fail the probe */ }

    // ── interactions (last: this mutates the page) ────────────────────────
    if (input.interactionTesting && !observations.probeError) {
      observations.interactions = await probeInteractions({
        page,
        pageUrl: finalUrl,
        elements: observations.interactiveElements,
        networkCollector,
        consoleCollector,
        evidence,
        auditId: deps.auditId,
        maxInteractions: config.limits.maxInteractionsPerPage,
        reporter,
      });

      // INP only exists once something has actually been interacted with.
      const postInteraction = await page.evaluate(readVitals).catch(() => null);
      if (postInteraction && observations.vitals) {
        observations.vitals.inpMs = postInteraction.vitals.inpMs;
      }
    }

    await networkCollector.drain(800);
    observations.requests = networkCollector.all();
    observations.console = consoleCollector.allMessages();
    observations.pageErrors = consoleCollector.allErrors();

    networkCollector.detach(page);
    consoleCollector.detach(page);
  } catch (error) {
    observations.probeError = error instanceof Error ? error.message : String(error);
    reporter.warn(`Probe error on ${redactUrl(input.url)}`, { reason: observations.probeError });
  } finally {
    await context?.close().catch(() => undefined);
    observations.finishedAt = new Date().toISOString();
  }

  return observations;
}

/**
 * Wait for the page to be usefully "done".
 *
 * `networkidle` is unreliable on real sites — analytics beacons, polling, and
 * websockets mean it may never fire. Instead: wait for load with a short
 * budget, then give client-rendered content a fixed grace period. Predictable
 * beats theoretically-correct-but-hangs.
 */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 15_000) }).catch(() => undefined);
  await page
    .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs / 3, 5_000) })
    .catch(() => undefined);
  // Grace period for frameworks that hydrate after load.
  await page.waitForTimeout(600);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function collectSecurity(
  page: Page,
  response: Awaited<ReturnType<Page['goto']>>,
  finalUrl: string,
): Promise<SecurityHeaderObservation> {
  const isHttps = finalUrl.startsWith('https://');
  const headers: Record<string, string> = {};

  try {
    const raw = response ? await response.allHeaders() : {};
    for (const [key, value] of Object.entries(raw)) {
      const lower = key.toLowerCase();
      // Cookies are excluded outright — we record their flags below instead.
      if (lower === 'set-cookie' || lower === 'cookie') continue;
      headers[lower] = value.slice(0, 4000);
    }
  } catch { /* ignore */ }

  // Cookie *flags* are a legitimate security finding; cookie *values* are
  // somebody's session. We keep the former and never touch the latter.
  const cookies: SecurityHeaderObservation['cookies'] = [];
  try {
    for (const cookie of await page.context().cookies()) {
      cookies.push({
        name: cookie.name,
        domain: cookie.domain,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite ?? null,
      });
    }
  } catch { /* ignore */ }

  return {
    url: redactUrl(finalUrl),
    isHttps,
    headers,
    cookies,
    mixedContentUrls: [],
    thirdPartyScriptOrigins: [],
  };
}
