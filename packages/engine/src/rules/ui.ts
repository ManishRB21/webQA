/**
 * UI / layout rules, derived from in-page geometry measurements.
 */

import { fingerprint, truncate } from '@webqa/shared';
import type { LayoutObservation, RawFinding } from '@webqa/shared';
import { occurrence, type PageRule } from './types.js';

const LAYOUT_RULE_SPECS: Record<
  LayoutObservation['kind'],
  {
    ruleId: string;
    title: string;
    severity: RawFinding['severity'];
    confidence: RawFinding['confidence'];
    category: RawFinding['category'];
    inference: string;
    impact: string;
    recommendation: string;
    effort: RawFinding['estimatedEffort'];
    standardsRef?: string;
  }
> = {
  HORIZONTAL_OVERFLOW: {
    ruleId: 'ui.horizontal-overflow',
    title: 'Page scrolls horizontally',
    severity: 'HIGH',
    confidence: 'CONFIRMED',
    category: 'UI_UX',
    inference:
      'The document is wider than the viewport, so the browser adds a horizontal scrollbar. On desktop this is untidy; on a phone it is genuinely disruptive — vertical scrolling drifts sideways, content sits off-screen, and pinch-zoom becomes necessary to read anything. The usual cause is a single element with a fixed pixel width, a wide table, or an unconstrained image.',
    impact:
      'Content is cut off and users must scroll sideways to read it. On mobile this makes the page feel broken.',
    recommendation:
      'Find the offending element (the specific selectors are listed below), then constrain it: `max-width: 100%` on images and embeds, `overflow-x: auto` on wide tables so only the table scrolls, and replace fixed pixel widths with relative units.',
    effort: 'SMALL',
    standardsRef: 'WCAG 2.1 — 1.4.10 Reflow',
  },
  ELEMENT_OUTSIDE_VIEWPORT: {
    ruleId: 'ui.element-overflow',
    title: 'Elements extend beyond the viewport',
    severity: 'MEDIUM',
    confidence: 'CONFIRMED',
    category: 'UI_UX',
    inference:
      'These specific elements have a right edge past the viewport width. They are the direct cause of the horizontal scrollbar and are where the fix belongs.',
    impact: 'Content off the right edge of the screen is not visible without scrolling.',
    recommendation: 'Constrain each element with `max-width: 100%` or a responsive width, and check for fixed pixel widths inherited from a desktop-first stylesheet.',
    effort: 'SMALL',
    standardsRef: 'WCAG 2.1 — 1.4.10 Reflow',
  },
  OVERLAPPING_INTERACTIVE: {
    ruleId: 'ui.overlapping-interactive',
    title: 'Interactive elements overlap',
    severity: 'MEDIUM',
    confidence: 'LIKELY',
    category: 'UI_UX',
    inference:
      'Two interactive elements occupy overlapping space, so a click in the shared region is ambiguous and lands on whichever has the higher stacking order.',
    impact: 'Users activate the wrong control, which is confusing and can be destructive.',
    recommendation: 'Adjust layout so interactive targets do not overlap, and check z-index values in the affected stacking context.',
    effort: 'SMALL',
  },
  CLIPPED_TEXT: {
    ruleId: 'ui.clipped-text',
    title: 'Text is cut off by its container',
    severity: 'MEDIUM',
    confidence: 'LIKELY',
    category: 'UI_UX',
    inference:
      'The element\'s content is taller than its box and `overflow` is hidden, with no ellipsis to indicate deliberate truncation. This normally means a fixed height was set for one content length and longer content is now being silently cut. Where truncation is intentional, an ellipsis is expected — its absence is what makes this suspicious.',
    impact: 'Users cannot read content that is present in the page but visually cut off, with no indication anything is missing.',
    recommendation: 'Replace the fixed height with `min-height`, or allow the container to grow. If truncation is intended, add `text-overflow: ellipsis` so users know there is more.',
    effort: 'SMALL',
  },
  TINY_TAP_TARGET: {
    ruleId: 'ui.tiny-tap-target',
    title: 'Interactive targets are too small',
    severity: 'MEDIUM',
    confidence: 'CONFIRMED',
    category: 'ACCESSIBILITY',
    inference:
      'WCAG 2.2 sets a 24×24 CSS pixel minimum for pointer targets. Below that, users with motor impairments, larger fingers, or an unsteady grip miss the target repeatedly. The measurement here is of the rendered box, so it accounts for padding.',
    impact: 'Mis-taps and repeated attempts, particularly on touch devices and for users with reduced dexterity.',
    recommendation: 'Increase the target to at least 24×24 CSS pixels — usually by adding padding rather than changing the visual size of the icon — or ensure adequate spacing around it.',
    effort: 'SMALL',
    standardsRef: 'WCAG 2.2 — 2.5.8 Target Size (Minimum)',
  },
  LARGE_BLANK_AREA: {
    ruleId: 'ui.blank-area',
    title: 'Large blank region in the viewport',
    severity: 'LOW',
    confidence: 'POSSIBLE',
    category: 'UI_UX',
    inference:
      'A large area of the initial viewport contains no rendered content, which can indicate content that failed to load or a layout that has collapsed. It can equally be a deliberate design choice, so this needs visual confirmation.',
    impact: 'If unintentional, users see an empty page region where content should be.',
    recommendation: 'Confirm visually against the captured screenshot before acting.',
    effort: 'UNKNOWN',
  },
};

export const layoutRule: PageRule = {
  id: 'ui.layout',
  description: 'Layout problems measured in the rendered page',
  run({ page }) {
    if (page.layout.length === 0) return [];

    // Group by kind so one finding covers all instances of a problem type.
    const byKind = new Map<LayoutObservation['kind'], LayoutObservation[]>();
    for (const issue of page.layout) {
      const bucket = byKind.get(issue.kind) ?? [];
      bucket.push(issue);
      byKind.set(issue.kind, bucket);
    }

    const findings: RawFinding[] = [];

    for (const [kind, issues] of byKind) {
      const spec = LAYOUT_RULE_SPECS[kind];
      if (!spec) continue;
      const first = issues[0]!;

      // The mobile viewport is where overflow actually hurts.
      const severity =
        page.device === 'MOBILE' && (kind === 'HORIZONTAL_OVERFLOW' || kind === 'TINY_TAP_TARGET')
          ? spec.severity
          : kind === 'HORIZONTAL_OVERFLOW'
            ? 'MEDIUM'
            : spec.severity;

      findings.push({
        ruleId: spec.ruleId,
        fingerprint: fingerprint(spec.ruleId, page.device),
        title: `${spec.title}${page.device === 'MOBILE' ? ' on mobile' : ''}`,
        category: spec.category,
        severity,
        confidence: spec.confidence,
        description: first.detail,
        measuredFacts: [
          { label: 'Instances on this page', value: issues.length, source: 'In-page geometry measurement' },
          { label: 'Viewport', value: page.device === 'MOBILE' ? '390×844 (mobile)' : '1440×900 (desktop)', source: 'Probe configuration' },
          ...Object.entries(first.measurements).map(([label, value]) => ({
            label,
            value: typeof value === 'number' ? Math.round(value) : value,
            unit: 'px',
            source: 'getBoundingClientRect',
          })),
        ],
        inference: spec.inference,
        technicalDetails: issues
          .slice(0, 10)
          .map((issue) => `${issue.selector}\n    ${issue.detail}`)
          .join('\n'),
        impact: spec.impact,
        recommendation: spec.recommendation,
        estimatedEffort: spec.effort,
        ...(spec.standardsRef ? { standardsRef: spec.standardsRef } : {}),
        occurrences: issues.slice(0, 20).map((issue) =>
          occurrence({
            pageUrl: page.url,
            selector: issue.selector,
            detail: truncate(issue.detail, 200),
            screenshotKey: page.screenshots.viewportKey,
          }),
        ),
      });
    }

    return findings;
  },
};

/** A page whose body renders almost nothing is usually a failure, not a design. */
export const emptyPageRule: PageRule = {
  id: 'ui.empty-page',
  description: 'Page rendered with almost no content',
  run({ page }) {
    const wordCount = page.meta?.wordCount ?? 0;
    const status = page.navigation?.status ?? 0;

    // Only flag pages that returned a success status — a 404 page with little
    // content is behaving correctly.
    if (status < 200 || status >= 300) return [];
    if (wordCount > 25) return [];
    if (page.probeError) return [];

    const hasJsError = page.pageErrors.length > 0;
    const hasFailedScripts = page.requests.some(
      (request) => request.resourceKind === 'script' && (request.failureText !== null || (request.status ?? 0) >= 400),
    );

    return [{
      ruleId: 'ui.empty-page',
      fingerprint: fingerprint('ui.empty-page'),
      title: 'Page renders with almost no content',
      category: 'FUNCTIONAL',
      severity: hasJsError || hasFailedScripts ? 'HIGH' : 'MEDIUM',
      // A near-empty page is measurable; whether it is broken depends on
      // whether it was meant to be empty.
      confidence: hasJsError || hasFailedScripts ? 'LIKELY' : 'POSSIBLE',
      description: `The page returned HTTP ${status} but rendered only ${wordCount} words of visible text.`,
      measuredFacts: [
        { label: 'Visible words', value: wordCount, source: 'document.body.innerText' },
        { label: 'HTTP status', value: status, source: 'Navigation observation' },
        { label: 'JavaScript exceptions', value: page.pageErrors.length, source: 'Playwright pageerror event' },
        { label: 'Failed script requests', value: page.requests.filter((r) => r.resourceKind === 'script' && ((r.status ?? 0) >= 400 || r.failureText)).length, source: 'Chromium network stack' },
      ],
      inference: hasJsError
        ? 'The page returned a success status but rendered essentially nothing, and a JavaScript exception was thrown during load. For a client-rendered application this is the classic signature of a render that aborted before mounting — the server said "here is your page" and the client failed to build it.'
        : hasFailedScripts
          ? 'The page returned a success status but rendered essentially nothing, and one or more scripts failed to load. For a client-rendered application, a missing bundle produces exactly this result.'
          : 'The page returned a success status but has almost no visible text. This may be a genuinely sparse page — a gallery, a redirect stub, a canvas application — or content that failed to render. It needs visual confirmation.',
      technicalDetails: [
        `HTTP ${status} at ${page.url}`,
        `Visible text: ${wordCount} words`,
        page.pageErrors.length > 0 ? `Exceptions:\n${page.pageErrors.slice(0, 3).map((e) => `  ${e.name}: ${truncate(e.message, 120)}`).join('\n')}` : null,
      ].filter(Boolean).join('\n'),
      impact:
        'Users reaching this page see a blank or near-blank screen while the server reports success — so no error page is shown and nothing suggests anything is wrong.',
      recommendation: hasJsError || hasFailedScripts
        ? 'Fix the load-time failure identified above. Then add server-side rendering or a no-JavaScript fallback so a client-side failure does not produce a completely blank page.'
        : 'Confirm visually using the captured screenshot. If the page is genuinely meant to be sparse, no action is needed.',
      estimatedEffort: 'MEDIUM',
      occurrences: [
        occurrence({
          pageUrl: page.url,
          detail: `${wordCount} visible words, HTTP ${status}`,
          screenshotKey: page.screenshots.viewportKey,
        }),
      ],
    }];
  },
};

export const uiPageRules: PageRule[] = [layoutRule, emptyPageRule];
