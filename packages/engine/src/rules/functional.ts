/**
 * Functional and reliability rules.
 *
 * These are the findings that matter most, because they describe things that
 * are broken rather than merely suboptimal. Note the confidence discipline
 * throughout: a 500 response is CONFIRMED, a click with no measurable effect is
 * only POSSIBLE. Stating the second as confidently as the first is how audit
 * tools lose the reader's trust.
 */

import { fingerprint, sanitizeDomSnippet, truncate, urlTemplate } from '@webqa/shared';
import type { RawFinding } from '@webqa/shared';
import { formatMs, occurrence, type PageRule, type SiteRule } from './types.js';
import { isBroken } from '../probes/link-checker.js';

/** Uncaught JavaScript exceptions during page load. */
export const jsExceptionRule: PageRule = {
  id: 'functional.js-exception',
  description: 'Uncaught JavaScript exception thrown during page load',
  run({ page }) {
    if (page.pageErrors.length === 0) return [];

    // Group by error identity, not by instance: the same error thrown in a
    // render loop is one bug, not four hundred.
    const groups = new Map<string, typeof page.pageErrors>();
    for (const error of page.pageErrors) {
      // Normalize the message so `Cannot read 'x' of undefined at line 42` and
      // the same error at line 43 collapse together.
      const signature = `${error.name}: ${error.message.replace(/\d+/g, 'N').slice(0, 120)}`;
      const bucket = groups.get(signature) ?? [];
      bucket.push(error);
      groups.set(signature, bucket);
    }

    const findings: RawFinding[] = [];
    for (const [signature, errors] of groups) {
      const first = errors[0]!;
      findings.push({
        ruleId: 'functional.js-exception',
        fingerprint: fingerprint('functional.js-exception', signature),
        title: `Uncaught JavaScript error: ${truncate(first.message, 80)}`,
        category: 'FUNCTIONAL',
        severity: 'HIGH',
        // The browser reported an uncaught exception. There is nothing to infer.
        confidence: 'CONFIRMED',
        description: `An uncaught ${first.name} was thrown while the page was loading.`,
        measuredFacts: [
          { label: 'Error type', value: first.name, source: 'Playwright pageerror event' },
          { label: 'Message', value: truncate(first.message, 200), source: 'Playwright pageerror event' },
          { label: 'Occurrences on this page', value: errors.length, source: 'Playwright pageerror event' },
          { label: 'Time after navigation', value: formatMs(first.atMs), source: 'Playwright pageerror event' },
        ],
        inference:
          'An uncaught exception aborts the JavaScript task that threw it. Any work scheduled after the throw point — event handlers, hydration, analytics, or rendering of dependent components — does not run. Users typically experience this as a control that silently does nothing or a section of the page that never appears.',
        technicalDetails: first.stack
          ? `Stack trace:\n${truncate(first.stack, 1200)}`
          : 'No stack trace was available from the browser.',
        impact:
          'Features depending on the code after the throw point will not work. The failure is silent — there is no error message for the user, so the page simply appears broken.',
        recommendation:
          'Reproduce with the browser console open and work back from the stack trace to the throwing statement. Where the exception is genuinely possible (an optional API field, a missing DOM node), guard it; where it is not, fix the invariant that was violated. Add error monitoring so this surfaces in production without a manual audit.',
        estimatedEffort: 'SMALL',
        reproduction: {
          steps: [
            `Open ${page.url} in Chromium with DevTools console visible`,
            'Observe the uncaught exception reported on load',
            `Error: ${truncate(first.message, 120)}`,
          ],
          environment: `${page.device} viewport, ${page.network} network profile`,
        },
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: truncate(first.message, 300),
            inlineEvidence: {
              kind: 'CONSOLE_LOG',
              caption: 'Uncaught exception as reported by the browser',
              data: { name: first.name, message: first.message, stack: first.stack, atMs: first.atMs },
            },
          }),
        ],
      });
    }
    return findings;
  },
};

/** Console errors that are not uncaught exceptions (logged failures). */
export const consoleErrorRule: PageRule = {
  id: 'functional.console-error',
  description: 'Errors written to the browser console',
  run({ page }) {
    const errors = page.console.filter((message) => message.level === 'error');
    if (errors.length === 0) return [];

    const groups = new Map<string, typeof errors>();
    for (const error of errors) {
      const signature = error.text.replace(/\d+/g, 'N').replace(/https?:\/\/\S+/g, 'URL').slice(0, 120);
      const bucket = groups.get(signature) ?? [];
      bucket.push(error);
      groups.set(signature, bucket);
    }

    const findings: RawFinding[] = [];
    for (const [signature, group] of groups) {
      const first = group[0]!;
      // A console error is a symptom; whether it breaks anything depends on
      // what logged it. LIKELY rather than CONFIRMED is the honest call.
      findings.push({
        ruleId: 'functional.console-error',
        fingerprint: fingerprint('functional.console-error', signature),
        title: `Console error: ${truncate(first.text, 80)}`,
        category: 'RELIABILITY',
        severity: 'MEDIUM',
        confidence: 'LIKELY',
        description: 'The page logged one or more errors to the browser console.',
        measuredFacts: [
          { label: 'Message', value: truncate(first.text, 200), source: 'Chromium console' },
          { label: 'Occurrences on this page', value: group.length, source: 'Chromium console' },
          ...(first.url ? [{ label: 'Source', value: truncate(first.url, 160), source: 'Chromium console' }] : []),
        ],
        inference:
          'Console errors are usually written by application code that has already detected a problem and handled it — a failed request, a missing configuration value, a third-party script that did not load. They do not always break a user-visible feature, but each one marks a code path that did not do what its author intended.',
        technicalDetails: `Logged from ${first.url ?? 'unknown source'}${first.lineNumber ? `:${first.lineNumber}` : ''} at ${formatMs(first.atMs)} after navigation start.`,
        impact:
          'Varies by cause. At minimum this indicates a degraded code path; at worst it is a feature failing quietly with the failure visible only to developers.',
        recommendation:
          'Trace the message to its source and decide whether it represents an expected condition (in which case it should not be logged at error level) or a genuine failure (in which case it should be fixed and monitored).',
        estimatedEffort: 'SMALL',
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: truncate(first.text, 300),
            inlineEvidence: {
              kind: 'CONSOLE_LOG',
              caption: `${group.length} console error(s) matching this signature`,
              data: group.slice(0, 5).map((error) => ({ text: error.text, url: error.url, atMs: error.atMs })),
            },
          }),
        ],
      });
    }
    return findings;
  },
};

/** Requests that returned 4xx/5xx or failed at the network layer. */
export const failedRequestRule: PageRule = {
  id: 'functional.failed-request',
  description: 'Network requests that failed or returned an error status',
  run({ page }) {
    const failed = page.requests.filter(
      (request) => request.failureText !== null || (request.status !== null && request.status >= 400),
    );
    if (failed.length === 0) return [];

    const findings: RawFinding[] = [];
    const grouped = new Map<string, typeof failed>();
    for (const request of failed) {
      const key = `${request.status ?? request.failureText}|${urlTemplate(request.url)}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(request);
      grouped.set(key, bucket);
    }

    for (const [, group] of grouped) {
      const request = group[0]!;
      const status = request.status;
      const isServerError = status !== null && status >= 500;
      const isApiCall = request.resourceKind === 'xhr' || request.resourceKind === 'fetch';

      // A 5xx on an API call the page depends on is the worst case; a 404 on a
      // third-party analytics beacon barely matters.
      let severity: RawFinding['severity'];
      if (isServerError && isApiCall && !request.isThirdParty) severity = 'CRITICAL';
      else if (isServerError) severity = 'HIGH';
      else if (isApiCall && !request.isThirdParty) severity = 'HIGH';
      else if (request.isThirdParty) severity = 'LOW';
      else severity = 'MEDIUM';

      const what = request.failureText
        ? `failed at the network layer (${request.failureText})`
        : `returned HTTP ${status}`;

      findings.push({
        ruleId: 'functional.failed-request',
        fingerprint: fingerprint('functional.failed-request', String(status ?? request.failureText), urlTemplate(request.url)),
        title: `${request.method} ${truncate(pathOf(request.url), 60)} ${what}`,
        category: isApiCall ? 'FUNCTIONAL' : 'RELIABILITY',
        severity,
        // The status code came off the wire.
        confidence: 'CONFIRMED',
        description: `A ${request.resourceKind} request ${what}.`,
        measuredFacts: [
          { label: 'URL', value: truncate(request.url, 200), source: 'Chromium network stack' },
          { label: 'Method', value: request.method, source: 'Chromium network stack' },
          { label: 'Status', value: status ?? 'no response', source: 'Chromium network stack' },
          { label: 'Resource type', value: request.resourceKind, source: 'Chromium network stack' },
          { label: 'Third party', value: request.isThirdParty ? 'yes' : 'no', source: 'Computed from request host' },
          ...(request.failureText ? [{ label: 'Failure', value: request.failureText, source: 'Chromium network stack' }] : []),
        ],
        inference: isServerError
          ? 'A 5xx status means the request reached the server and the server failed to process it. This is a backend defect, not a frontend one — the client is asking correctly and getting an error back.'
          : status === 404
            ? 'A 404 means the resource does not exist at the requested path. Either the reference is stale or the resource was moved or deleted without updating what points at it.'
            : 'The request did not complete successfully, so whatever depends on its payload will be missing or stale.',
        technicalDetails: [
          `Request: ${request.method} ${request.url}`,
          `Status: ${status ?? 'none'}${request.statusText ? ` ${request.statusText}` : ''}`,
          request.durationMs !== null ? `Duration: ${formatMs(request.durationMs)}` : null,
          request.redirectChain.length > 0 ? `Redirect chain: ${request.redirectChain.join(' → ')}` : null,
          `Occurrences on this page: ${group.length}`,
        ].filter(Boolean).join('\n'),
        impact: isApiCall
          ? 'Features backed by this endpoint will not render data, or will render a stale or empty state. Users usually see a blank section or a spinner that never resolves.'
          : `The ${request.resourceKind} did not load. Depending on what it was, this can mean missing styling, missing imagery, or missing functionality.`,
        recommendation: isServerError
          ? `Investigate the server-side exception behind ${pathOf(request.url)}. Check application logs for the corresponding request id and stack trace — the fix is on the backend.`
          : status === 404
            ? `Either restore the resource at ${pathOf(request.url)} or update the reference that points to it.`
            : 'Confirm the endpoint is correct and reachable, and add client-side handling so a failure degrades visibly rather than silently.',
        estimatedEffort: isServerError ? 'MEDIUM' : 'SMALL',
        reproduction: {
          steps: [
            `Open ${page.url} with the DevTools Network panel recording`,
            `Locate the ${request.method} request to ${truncate(pathOf(request.url), 80)}`,
            `Observe the ${status ?? 'failed'} response`,
          ],
          environment: `${page.device} viewport, ${page.network} network profile`,
        },
        occurrences: [
          occurrence({
            pageUrl: page.url,
            detail: `${request.method} ${truncate(request.url, 200)} → ${status ?? request.failureText}`,
            inlineEvidence: {
              kind: 'NETWORK_REQUEST',
              caption: 'Failing request as recorded by the browser',
              data: {
                url: request.url,
                method: request.method,
                status: request.status,
                failureText: request.failureText,
                resourceKind: request.resourceKind,
                responseHeaders: request.responseHeaders,
              },
            },
          }),
        ],
      });
    }

    return findings;
  },
};

/** Interaction results: the functional testing payoff. */
export const interactionRule: PageRule = {
  id: 'functional.interaction',
  description: 'Interactive controls that failed when clicked',
  run({ page }) {
    const findings: RawFinding[] = [];

    for (const interaction of page.interactions) {
      // An exception during interaction is unambiguous.
      if (interaction.outcome === 'THREW_EXCEPTION') {
        const error = interaction.pageErrors[0];
        findings.push({
          ruleId: 'functional.interaction-exception',
          fingerprint: fingerprint('functional.interaction-exception', interaction.label, error?.message.slice(0, 80) ?? ''),
          title: `"${truncate(interaction.label, 50)}" throws an exception when clicked`,
          category: 'FUNCTIONAL',
          severity: 'CRITICAL',
          confidence: 'CONFIRMED',
          description: `Clicking the ${interaction.elementKind} labelled "${interaction.label}" caused an uncaught JavaScript exception.`,
          measuredFacts: [
            { label: 'Control', value: interaction.label, source: 'Computed accessible name' },
            { label: 'Selector', value: interaction.selector, source: 'DOM extraction' },
            { label: 'Exception', value: truncate(error?.message ?? 'unknown', 200), source: 'Playwright pageerror event' },
            { label: 'Failed requests during interaction', value: interaction.failedRequests.length, source: 'Chromium network stack' },
          ],
          inference:
            'The click handler threw before completing. Whatever the control was supposed to do did not happen, and because the exception is uncaught there is no fallback path and no message to the user.',
          technicalDetails: [
            `Selector: ${interaction.selector}`,
            `Exception: ${error?.name}: ${error?.message}`,
            error?.stack ? `Stack:\n${truncate(error.stack, 800)}` : null,
            interaction.failedRequests.length > 0
              ? `Failed requests: ${interaction.failedRequests.map((r) => `${r.method} ${pathOf(r.url)} → ${r.status ?? r.failureText}`).join(', ')}`
              : null,
          ].filter(Boolean).join('\n'),
          impact:
            'The control is non-functional. Any user journey that depends on it is blocked at this step, with no error message and no alternative path.',
          recommendation:
            'Fix the exception in the click handler. Given the control is user-facing and currently fails silently, also add an error boundary or a visible failure state so a future regression is noticed by users rather than only by an audit.',
          estimatedEffort: 'SMALL',
          reproduction: {
            steps: [
              `Open ${page.url}`,
              `Click the ${interaction.elementKind} "${interaction.label}" (${interaction.selector})`,
              `Observe the uncaught exception: ${truncate(error?.message ?? '', 120)}`,
            ],
            environment: `${page.device} viewport, ${page.network} network profile`,
          },
          occurrences: [
            occurrence({
              pageUrl: page.url,
              selector: interaction.selector,
              detail: truncate(error?.message ?? '', 200),
              screenshotKey: interaction.screenshotKey,
              inlineEvidence: {
                kind: 'CONSOLE_LOG',
                caption: 'Exception thrown by the click handler',
                data: { errors: interaction.pageErrors, consoleErrors: interaction.consoleErrors },
              },
            }),
          ],
        });
        continue;
      }

      // A failed API call triggered by the click.
      if (interaction.failedRequests.length > 0) {
        const failed = interaction.failedRequests[0]!;
        const isServerError = failed.status !== null && failed.status >= 500;
        findings.push({
          ruleId: 'functional.interaction-api-failure',
          fingerprint: fingerprint('functional.interaction-api-failure', urlTemplate(failed.url), String(failed.status)),
          title: `"${truncate(interaction.label, 40)}" triggers a failing request (${failed.status ?? 'network error'})`,
          category: 'FUNCTIONAL',
          severity: isServerError ? 'CRITICAL' : 'HIGH',
          confidence: 'CONFIRMED',
          description: `Clicking "${interaction.label}" issued a request to ${pathOf(failed.url)} which ${failed.status ? `returned HTTP ${failed.status}` : `failed (${failed.failureText})`}.`,
          measuredFacts: [
            { label: 'Control', value: interaction.label, source: 'Computed accessible name' },
            { label: 'Request', value: `${failed.method} ${truncate(failed.url, 160)}`, source: 'Chromium network stack' },
            { label: 'Status', value: failed.status ?? failed.failureText ?? 'unknown', source: 'Chromium network stack' },
            { label: 'Navigation occurred', value: interaction.urlBefore === interaction.urlAfter ? 'no' : 'yes', source: 'Page URL before/after click' },
            { label: 'DOM mutations after click', value: interaction.domMutationCount, source: 'MutationObserver' },
          ],
          inference: isServerError
            ? 'The click reached the backend and the backend returned a server error. The user action was accepted by the UI but not completed by the system — the most damaging failure shape, because the interface may look like it succeeded.'
            : 'The request the control depends on did not succeed, so the action it represents did not complete.',
          technicalDetails: [
            `Control: ${interaction.selector}`,
            `Request: ${failed.method} ${failed.url}`,
            `Response: ${failed.status ?? 'none'}${failed.statusText ? ` ${failed.statusText}` : ''}`,
            `Outcome classification: ${interaction.outcome}`,
            `DOM mutations observed: ${interaction.domMutationCount}`,
          ].join('\n'),
          impact:
            'The user journey that runs through this control is broken. If the UI does not surface the failure, users will believe the action succeeded — which is worse than an obvious error.',
          recommendation: isServerError
            ? `Investigate the server-side error returned by ${pathOf(failed.url)} using your application logs. Separately, ensure the frontend surfaces a clear failure state instead of proceeding as if the call succeeded.`
            : `Confirm ${pathOf(failed.url)} is the correct endpoint and that the request shape matches what the server expects. Add explicit error handling on the client.`,
          estimatedEffort: 'MEDIUM',
          reproduction: {
            steps: [
              `Open ${page.url} with the DevTools Network panel recording`,
              `Click "${interaction.label}"`,
              `Observe ${failed.method} ${pathOf(failed.url)} returning ${failed.status ?? failed.failureText}`,
            ],
            environment: `${page.device} viewport, ${page.network} network profile`,
          },
          occurrences: [
            occurrence({
              pageUrl: page.url,
              selector: interaction.selector,
              detail: `${failed.method} ${truncate(failed.url, 160)} → ${failed.status ?? failed.failureText}`,
              screenshotKey: interaction.screenshotKey,
              inlineEvidence: {
                kind: 'NETWORK_REQUEST',
                caption: 'Request issued by the click',
                data: {
                  url: failed.url,
                  method: failed.method,
                  status: failed.status,
                  failureText: failed.failureText,
                  responseHeaders: failed.responseHeaders,
                },
              },
            }),
          ],
        });
        continue;
      }

      // Nothing observable happened. This is the honest-uncertainty case.
      if (interaction.outcome === 'NO_OBSERVABLE_EFFECT' && interaction.elementKind !== 'link') {
        findings.push({
          ruleId: 'functional.interaction-no-effect',
          fingerprint: fingerprint('functional.interaction-no-effect', interaction.elementKind, interaction.label),
          title: `"${truncate(interaction.label, 50)}" produced no observable effect when clicked`,
          category: 'FUNCTIONAL',
          severity: 'MEDIUM',
          // We watched four channels and saw nothing. That is suggestive, not
          // conclusive — a CSS-only transition would look identical to us.
          confidence: 'POSSIBLE',
          description: `Clicking the ${interaction.elementKind} labelled "${interaction.label}" produced no navigation, no network activity, and no meaningful DOM change.`,
          measuredFacts: [
            { label: 'Control', value: interaction.label, source: 'Computed accessible name' },
            { label: 'Selector', value: interaction.selector, source: 'DOM extraction' },
            { label: 'URL before', value: interaction.urlBefore, source: 'Page URL' },
            { label: 'URL after', value: interaction.urlAfter, source: 'Page URL' },
            { label: 'DOM mutations', value: interaction.domMutationCount, source: 'MutationObserver' },
            { label: 'Network requests', value: interaction.networkRequests.length, source: 'Chromium network stack' },
            { label: 'Observation window', value: formatMs(interaction.durationMs), source: 'Probe timing' },
          ],
          inference:
            'Four independent signals were monitored for roughly a second after the click — page URL, DOM mutations, network activity, and console output — and none changed. That is consistent with a broken handler, but it is not proof: a purely visual CSS transition, a change inside a canvas or shadow root, or an effect that takes longer than the observation window would all look the same from here.',
          technicalDetails: `Selector: ${interaction.selector}\nOutcome: ${interaction.outcome}\nObservation window: ${formatMs(interaction.durationMs)}\nMutations: ${interaction.domMutationCount}\nRequests: ${interaction.networkRequests.length}`,
          impact:
            'If the control is genuinely inert, users clicking it get no feedback and no result — the most frustrating class of UI failure, because there is nothing to report.',
          recommendation:
            'Verify manually. If the control is meant to do something, check that its event listener is attached (framework hydration failures are a common cause of exactly this symptom). If it works but only changes styling, no action is needed — consider adding an ARIA state change so assistive technology also perceives the effect.',
          estimatedEffort: 'SMALL',
          reproduction: {
            steps: [
              `Open ${page.url}`,
              `Click "${interaction.label}" (${interaction.selector})`,
              'Observe that the URL, DOM, and network panel are unchanged',
            ],
            environment: `${page.device} viewport, ${page.network} network profile`,
          },
          occurrences: [
            occurrence({
              pageUrl: page.url,
              selector: interaction.selector,
              detail: `No effect observed over ${formatMs(interaction.durationMs)}`,
              screenshotKey: interaction.screenshotKey,
            }),
          ],
        });
      }
    }

    return findings;
  },
};

/** Broken images, scripts, stylesheets and fonts. */
export const brokenResourceRule: PageRule = {
  id: 'functional.broken-resource',
  description: 'Sub-resources that failed to load',
  run({ page }) {
    const findings: RawFinding[] = [];

    const brokenImages = page.images.filter((image) => image.broken);
    if (brokenImages.length > 0) {
      findings.push({
        ruleId: 'functional.broken-image',
        fingerprint: fingerprint('functional.broken-image'),
        title: 'Images fail to load',
        category: 'FUNCTIONAL',
        severity: 'MEDIUM',
        confidence: 'CONFIRMED',
        description: `${brokenImages.length} image element(s) on this page failed to decode.`,
        measuredFacts: [
          { label: 'Broken images on this page', value: brokenImages.length, source: 'HTMLImageElement.naturalWidth === 0' },
          { label: 'Example source', value: truncate(brokenImages[0]?.src ?? '', 160), source: 'DOM extraction' },
        ],
        inference:
          'The browser reported `complete` with a natural width of zero, which is the definitive signal that an image was requested and could not be decoded — either the URL 404s or the bytes are not a valid image.',
        technicalDetails: brokenImages
          .slice(0, 10)
          .map((image) => `${image.selector} → ${truncate(image.src ?? '(no src)', 120)}`)
          .join('\n'),
        impact:
          'Users see a broken-image placeholder or empty space. Where the image carried product or brand content, the page reads as unmaintained.',
        recommendation:
          'Check each source URL resolves. Where images are user-supplied or come from a CMS, add an onerror fallback so a single missing asset degrades to a placeholder rather than a broken icon.',
        estimatedEffort: 'SMALL',
        occurrences: brokenImages.slice(0, 20).map((image) =>
          occurrence({
            pageUrl: page.url,
            selector: image.selector,
            detail: `src="${truncate(image.src ?? '', 160)}"`,
          }),
        ),
      });
    }

    // A failed script or stylesheet is more serious than a failed image.
    const criticalFailures = page.requests.filter(
      (request) =>
        (request.resourceKind === 'script' || request.resourceKind === 'stylesheet') &&
        (request.failureText !== null || (request.status !== null && request.status >= 400)),
    );

    if (criticalFailures.length > 0) {
      const kinds = [...new Set(criticalFailures.map((request) => request.resourceKind))];
      findings.push({
        ruleId: 'functional.broken-critical-resource',
        fingerprint: fingerprint('functional.broken-critical-resource', kinds.join(',')),
        title: `${kinds.join(' and ')} resources fail to load`,
        category: 'FUNCTIONAL',
        severity: 'HIGH',
        confidence: 'CONFIRMED',
        description: `${criticalFailures.length} ${kinds.join('/')} request(s) failed on this page.`,
        measuredFacts: criticalFailures.slice(0, 5).map((request) => ({
          label: `${request.resourceKind} ${pathOf(request.url)}`,
          value: request.status ?? request.failureText ?? 'failed',
          source: 'Chromium network stack',
        })),
        inference:
          'A stylesheet that fails to load leaves the page unstyled; a script that fails to load removes whatever behaviour it provided. Unlike an image, there is no graceful degradation unless the site was explicitly built for it.',
        technicalDetails: criticalFailures
          .slice(0, 10)
          .map((request) => `${request.resourceKind}: ${request.url} → ${request.status ?? request.failureText}`)
          .join('\n'),
        impact:
          'Missing styling or missing interactivity across the page. This is highly visible and typically affects every visitor equally.',
        recommendation:
          'Confirm the asset URLs are correct for the deployed environment — this failure pattern usually means a build output path or CDN reference did not survive deployment. Add a deployment smoke check that asserts the critical assets return 200.',
        estimatedEffort: 'SMALL',
        occurrences: criticalFailures.slice(0, 20).map((request) =>
          occurrence({
            pageUrl: page.url,
            detail: `${request.resourceKind}: ${truncate(request.url, 160)} → ${request.status ?? request.failureText}`,
          }),
        ),
      });
    }

    return findings;
  },
};

/** Links with no usable destination. */
export const emptyLinkRule: PageRule = {
  id: 'functional.empty-link',
  description: 'Anchors with no navigable target',
  run({ page }) {
    const empty = page.links.filter((link) => link.isEmptyTarget);
    if (empty.length === 0) return [];

    return [
      {
        ruleId: 'functional.empty-link',
        fingerprint: fingerprint('functional.empty-link'),
        title: 'Links with no destination',
        category: 'BEST_PRACTICES',
        severity: 'LOW',
        confidence: 'CONFIRMED',
        description: `${empty.length} anchor element(s) have an empty, "#", or javascript: href.`,
        measuredFacts: [
          { label: 'Anchors without a destination', value: empty.length, source: 'DOM extraction' },
          { label: 'Example', value: truncate(empty[0]?.text || empty[0]?.selector || '', 120), source: 'DOM extraction' },
        ],
        inference:
          'An anchor is a navigation element. When it carries no destination it is usually being used as a button with a JavaScript handler attached. That works for mouse users but breaks middle-click, right-click "open in new tab", and keyboard activation semantics, and it announces incorrectly to screen readers.',
        technicalDetails: empty
          .slice(0, 10)
          .map((link) => `${link.selector} — href="${link.href}" text="${truncate(link.text, 60)}"`)
          .join('\n'),
        impact:
          'Keyboard and assistive-technology users get a control that announces as a link but does not behave like one. Mouse users lose open-in-new-tab.',
        recommendation:
          'Where the element performs an action rather than navigating, use `<button type="button">`. Where it does navigate, give it a real href so the browser can do its job.',
        estimatedEffort: 'TRIVIAL',
        standardsRef: 'WCAG 2.1 — 4.1.2 Name, Role, Value',
        occurrences: empty.slice(0, 25).map((link) =>
          occurrence({
            pageUrl: page.url,
            selector: link.selector,
            detail: `href="${link.href}" text="${truncate(link.text, 80)}"`,
          }),
        ),
      },
    ];
  },
};

/** Broken links, evaluated site-wide from the link checker's results. */
export const brokenLinkRule: SiteRule = {
  id: 'functional.broken-link',
  description: 'Links pointing at URLs that return an error',
  run({ site }) {
    const broken = site.linkChecks.filter(isBroken);
    if (broken.length === 0) return [];

    const internal = broken.filter((check) => check.isInternal);
    const external = broken.filter((check) => !check.isInternal);
    const findings: RawFinding[] = [];

    const build = (group: typeof broken, isInternalGroup: boolean): RawFinding => ({
      ruleId: isInternalGroup ? 'functional.broken-internal-link' : 'functional.broken-external-link',
      fingerprint: fingerprint(isInternalGroup ? 'functional.broken-internal-link' : 'functional.broken-external-link'),
      title: isInternalGroup ? 'Broken internal links' : 'Broken external links',
      category: isInternalGroup ? 'FUNCTIONAL' : 'BEST_PRACTICES',
      severity: isInternalGroup ? 'HIGH' : 'LOW',
      confidence: 'CONFIRMED',
      description: `${group.length} ${isInternalGroup ? 'internal' : 'external'} link target(s) returned an error when requested.`,
      measuredFacts: [
        { label: 'Broken targets', value: group.length, source: 'HTTP HEAD/GET verification' },
        { label: 'Most common status', value: mostCommonStatus(group), source: 'HTTP HEAD/GET verification' },
        { label: 'Referring pages', value: new Set(group.flatMap((check) => check.referrers)).size, source: 'Crawl link graph' },
      ],
      inference: isInternalGroup
        ? 'Each of these URLs is linked from the site but does not resolve. Internal broken links are entirely within the owner\'s control, and they leak crawl budget as well as frustrating users.'
        : 'These external destinations no longer resolve. The site does not control them, but it does control whether it keeps pointing at them.',
      technicalDetails: group
        .slice(0, 20)
        .map((check) => `${check.status ?? check.failureText} — ${check.url}\n    linked from: ${check.referrers.slice(0, 3).join(', ')}`)
        .join('\n'),
      impact: isInternalGroup
        ? 'Users following these links hit an error page. Search engines treat a high internal-404 rate as a quality signal, so this also carries an SEO cost.'
        : 'Users following these links leave the site and land on an error. It reads as neglect.',
      recommendation: isInternalGroup
        ? 'Fix or redirect each target. Where content was intentionally removed, add a 301 to the closest equivalent rather than leaving a 404.'
        : 'Update or remove the outdated references. For links that must remain, consider an archive link.',
      estimatedEffort: 'SMALL',
      occurrences: group.slice(0, 50).flatMap((check) =>
        check.referrers.slice(0, 3).map((referrer) =>
          occurrence({
            pageUrl: referrer,
            detail: `→ ${truncate(check.url, 160)} returned ${check.status ?? check.failureText}`,
          }),
        ),
      ),
    });

    if (internal.length > 0) findings.push(build(internal, true));
    if (external.length > 0) findings.push(build(external, false));
    return findings;
  },
};

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function mostCommonStatus(checks: Array<{ status: number | null; failureText: string | null }>): string {
  const counts = new Map<string, number>();
  for (const check of checks) {
    const key = String(check.status ?? check.failureText ?? 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 'unknown';
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return `${best} (${bestCount}×)`;
}

export const functionalPageRules: PageRule[] = [
  jsExceptionRule,
  consoleErrorRule,
  failedRequestRule,
  interactionRule,
  brokenResourceRule,
  emptyLinkRule,
];

export const functionalSiteRules: SiteRule[] = [brokenLinkRule];
