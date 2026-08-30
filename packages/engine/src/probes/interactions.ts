/**
 * Black-box functional testing.
 *
 * This is the part of the product that behaves like a QA engineer rather than a
 * linter, and it is also the part most able to do harm. Two principles govern
 * every decision here:
 *
 *   NEVER BE DESTRUCTIVE. We are clicking around a live production site owned
 *   by someone else. Anything that looks like it deletes, purchases, logs out,
 *   unsubscribes, or submits real data is skipped by name. When in doubt, skip.
 *   A missed finding is a disappointment; a deleted record is an incident.
 *
 *   MEASURE, DON'T GUESS. "The button did nothing" is only reportable if we can
 *   show what we watched: URL, DOM mutation count, network activity, console
 *   errors, all captured in a window that opens on click and closes on settle.
 *
 * Note the asymmetry in what we conclude. A JS exception or a 500 after a click
 * is CONFIRMED evidence of a defect. "No observable effect" is only POSSIBLE —
 * the change may have been a CSS transition we did not watch for, or a state
 * update with no DOM footprint. We say so rather than overclaiming.
 */

import type { Page } from 'playwright';
import type {
  InteractionObservation,
  InteractionOutcome,
  InteractiveElementObservation,
} from '@webqa/shared';
import { redactUrl, truncate } from '@webqa/shared';
import type { ConsoleCollector, NetworkCollector } from '../browser/collectors.js';
import type { EvidenceStore } from '../store/evidence.js';
import type { Reporter } from '../logger.js';

/**
 * Labels that suggest an irreversible or state-destroying action.
 * Matched case-insensitively against the element's accessible name.
 */
const DESTRUCTIVE_PATTERNS = [
  /\b(delete|remove|destroy|erase|wipe|purge|clear all)\b/i,
  /\b(log ?out|sign ?out|logout|signout)\b/i,
  /\b(unsubscribe|opt ?out|deactivate|close account|cancel (subscription|account|order|plan))\b/i,
  /\b(buy|purchase|pay|place order|complete order|confirm (order|payment|purchase))\b/i,
  /\b(publish|submit (application|report|review)|send (message|email|invite))\b/i,
  /\b(reset|restore defaults|revoke|disconnect|uninstall)\b/i,
  /\b(archive|block|ban|report abuse|flag)\b/i,
  /\b(download|export)\b/i,
  /\b(print)\b/i,
];

/** Attributes that mark an element as explicitly off-limits. */
const SKIP_ATTRIBUTE_PATTERNS = [/data-(no-?)?(test|audit)-skip/i, /data-destructive/i];

export interface InteractionProbeInput {
  page: Page;
  pageUrl: string;
  elements: InteractiveElementObservation[];
  networkCollector: NetworkCollector;
  consoleCollector: ConsoleCollector;
  evidence: EvidenceStore;
  auditId: string;
  maxInteractions: number;
  reporter: Reporter;
}

interface Candidate {
  element: InteractiveElementObservation;
  kind: InteractionObservation['elementKind'];
  /** Higher scores are probed first when the budget is tight. */
  priority: number;
}

/**
 * Choose what to click.
 *
 * Explicitly NOT "every clickable element". Clicking 150 things on 100 pages
 * would take hours, hammer the target site, and produce a report nobody reads.
 * We pick a small, high-signal sample: primary CTAs and navigation controls,
 * plus anything already suspicious (no accessible name, covered by another
 * element), because those are where real defects concentrate.
 */
export function selectCandidates(
  elements: InteractiveElementObservation[],
  limit: number,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const element of elements) {
    if (!element.visible || !element.enabled) continue;
    if (!element.boundingBox) continue;
    if (SKIP_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(element.selector))) continue;

    const name = element.accessibleName.trim();
    if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(name))) continue;

    let kind: Candidate['kind'] = 'button';
    let priority = 0;

    const role = element.role?.toLowerCase();
    if (role === 'tab') {
      kind = 'tab';
      priority = 60;
    } else if (role === 'menuitem') {
      kind = 'menu';
      priority = 40;
    } else if (element.tag === 'summary') {
      kind = 'accordion';
      priority = 55;
    } else if (element.tag === 'a') {
      kind = 'link';
      // An anchor with a real href is verified by the link checker instead;
      // only anchors acting as buttons are worth clicking.
      priority = 25;
    } else if (element.tag === 'button' || role === 'button') {
      kind = 'button';
      priority = 70;
    }

    // A control with no accessible name is already a finding; clicking it
    // tells us whether it is also non-functional.
    if (!name) priority += 25;
    // A covered control is the classic "why doesn't this work" bug.
    if (element.obscuredBy) priority += 35;
    // Above-the-fold controls are the ones users actually hit.
    if (element.inViewport) priority += 15;
    // Primary-CTA vocabulary.
    if (/\b(search|submit|apply|continue|next|start|get started|sign ?up|subscribe|add to cart|filter|show|load more|view|open|toggle|menu)\b/i.test(name)) {
      priority += 30;
    }

    candidates.push({ element, kind, priority });
  }

  // Deduplicate structurally-identical controls — clicking 20 cards in a grid
  // exercises exactly one code path.
  const seenShapes = new Set<string>();
  const deduped: Candidate[] = [];
  for (const candidate of candidates.sort((a, b) => b.priority - a.priority)) {
    const shape = `${candidate.kind}|${candidate.element.selector.replace(/:nth-of-type\(\d+\)/g, '')}`;
    if (seenShapes.has(shape)) continue;
    seenShapes.add(shape);
    deduped.push(candidate);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

export async function probeInteractions(input: InteractionProbeInput): Promise<InteractionObservation[]> {
  const { page, pageUrl, elements, networkCollector, consoleCollector, evidence, reporter } = input;

  const candidates = selectCandidates(elements, input.maxInteractions);
  if (candidates.length === 0) return [];

  const results: InteractionObservation[] = [];

  for (const candidate of candidates) {
    // Bail out if a previous interaction navigated us somewhere unexpected and
    // we could not get back — the remaining selectors no longer mean anything.
    if (page.isClosed()) break;
    if (page.url() !== pageUrl) {
      const recovered = await returnToPage(page, pageUrl);
      if (!recovered) break;
    }

    const observation = await probeOne(candidate, input);
    if (observation) results.push(observation);
  }

  reporter.debug(`Tested ${results.length} interaction(s) on ${redactUrl(pageUrl)}`);
  return results;
}

async function probeOne(
  candidate: Candidate,
  input: InteractionProbeInput,
): Promise<InteractionObservation | null> {
  const { page, pageUrl, networkCollector, consoleCollector, evidence, auditId } = input;
  const { element } = candidate;

  const locator = page.locator(element.selector).first();

  // Confirm the element is still there and actionable. SPAs re-render between
  // extraction and interaction all the time.
  const actionable = await locator
    .isVisible({ timeout: 1500 })
    .catch(() => false);

  if (!actionable) {
    return {
      selector: element.selector,
      label: element.accessibleName || '(no accessible name)',
      elementKind: candidate.kind,
      outcome: 'NOT_ACTIONABLE',
      consoleErrors: [],
      pageErrors: [],
      networkRequests: [],
      failedRequests: [],
      urlBefore: redactUrl(pageUrl),
      urlAfter: redactUrl(pageUrl),
      domMutationCount: 0,
      durationMs: 0,
      screenshotKey: null,
    };
  }

  // Start a mutation counter in the page so "did anything change?" is measured
  // rather than eyeballed.
  await page
    .evaluate(() => {
      const w = window as unknown as { __webqaMutations?: number; __webqaObserver?: MutationObserver };
      w.__webqaObserver?.disconnect();
      w.__webqaMutations = 0;
      const observer = new MutationObserver((records) => {
        w.__webqaMutations = (w.__webqaMutations ?? 0) + records.length;
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      w.__webqaObserver = observer;
    })
    .catch(() => undefined);

  networkCollector.markInteractionStart();
  consoleCollector.markInteractionStart();

  const urlBefore = page.url();
  const startedAt = Date.now();

  let outcome: InteractionOutcome = 'NO_OBSERVABLE_EFFECT';
  let navigated = false;

  try {
    // `trial: false` with a short timeout: we want the real click, but we do
    // not want to wait 30s for an element that will never become stable.
    await locator.click({ timeout: 4000, noWaitAfter: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    return {
      selector: element.selector,
      label: element.accessibleName || '(no accessible name)',
      elementKind: candidate.kind,
      outcome: message.toLowerCase().includes('timeout') ? 'TIMED_OUT' : 'NOT_ACTIONABLE',
      consoleErrors: consoleCollector.messagesSinceInteractionStart().filter((m) => m.level === 'error'),
      pageErrors: consoleCollector.errorsSinceInteractionStart(),
      networkRequests: networkCollector.sinceInteractionStart(),
      failedRequests: networkCollector.sinceInteractionStart().filter(isFailedRequest),
      urlBefore: redactUrl(urlBefore),
      urlAfter: redactUrl(page.url()),
      domMutationCount: 0,
      durationMs,
      screenshotKey: null,
    };
  }

  // Give the app a moment to react: navigate, fetch, or re-render.
  await page.waitForTimeout(900);
  await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => undefined);

  const urlAfter = page.url();
  navigated = urlAfter !== urlBefore;

  const domMutationCount = await page
    .evaluate(() => {
      const w = window as unknown as { __webqaMutations?: number; __webqaObserver?: MutationObserver };
      w.__webqaObserver?.disconnect();
      return w.__webqaMutations ?? 0;
    })
    .catch(() => 0);

  const consoleErrors = consoleCollector.messagesSinceInteractionStart().filter((m) => m.level === 'error');
  const pageErrors = consoleCollector.errorsSinceInteractionStart();
  const networkRequests = networkCollector.sinceInteractionStart();
  const failedRequests = networkRequests.filter(isFailedRequest);

  // Precedence matters: an exception is the strongest signal, then a failed
  // API call, then navigation, then any observable change at all.
  if (pageErrors.length > 0) outcome = 'THREW_EXCEPTION';
  else if (navigated) outcome = 'NAVIGATED';
  else if (failedRequests.length > 0) outcome = 'NETWORK_ACTIVITY';
  else if (domMutationCount > 2) outcome = 'DOM_CHANGED';
  else if (networkRequests.length > 0) outcome = 'NETWORK_ACTIVITY';
  else outcome = 'NO_OBSERVABLE_EFFECT';

  const durationMs = Date.now() - startedAt;

  // Capture a screenshot only when something looks wrong. Screenshotting every
  // click would produce thousands of near-identical images.
  let screenshotKey: string | null = null;
  const worthCapturing =
    outcome === 'THREW_EXCEPTION' ||
    outcome === 'NO_OBSERVABLE_EFFECT' ||
    failedRequests.length > 0;

  if (worthCapturing && !page.isClosed()) {
    try {
      const shot = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 8000 });
      screenshotKey = await evidence.putScreenshot(
        auditId,
        `${urlAfter}#${element.selector}`,
        'evidence',
        shot,
      );
    } catch { /* evidence is best-effort */ }
  }

  if (navigated) {
    await returnToPage(page, pageUrl);
  }

  return {
    selector: element.selector,
    label: truncate(element.accessibleName || '(no accessible name)', 120),
    elementKind: candidate.kind,
    outcome,
    consoleErrors,
    pageErrors,
    networkRequests,
    failedRequests,
    urlBefore: redactUrl(urlBefore),
    urlAfter: redactUrl(urlAfter),
    domMutationCount,
    durationMs,
    screenshotKey,
  };
}

function isFailedRequest(request: { status: number | null; failureText: string | null }): boolean {
  return (request.status !== null && request.status >= 400) || request.failureText !== null;
}

/** Navigate back to the page under test after an interaction moved us. */
async function returnToPage(page: Page, pageUrl: string): Promise<boolean> {
  try {
    await page.goBack({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => undefined);
    if (page.url() === pageUrl) return true;
    await page.goto(pageUrl, { timeout: 12_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    return page.url() === pageUrl;
  } catch {
    return false;
  }
}
