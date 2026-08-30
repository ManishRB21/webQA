/**
 * Accessibility rules.
 *
 * Most of the work is done by axe-core, so the job here is translation rather
 * than detection: turn axe violations into findings with WCAG references,
 * severity that accounts for reach, and a fix that names the element.
 *
 * A handful of custom rules cover things axe deliberately does not check —
 * heading hierarchy quality and keyboard-reachability of covered controls.
 */

import { fingerprint, sanitizeDomSnippet, truncate } from '@webqa/shared';
import type { RawFinding } from '@webqa/shared';
import { occurrence, type PageRule } from './types.js';
import { severityFromImpact, wcagCriteriaFromTags } from '../probes/axe.js';

/** Human-readable remediation for the axe rules we see most often. */
const REMEDIATION: Record<string, string> = {
  'image-alt': 'Add an `alt` attribute describing the image\'s purpose. If the image is purely decorative, use `alt=""` so screen readers skip it — omitting the attribute entirely is what causes the failure, because assistive technology then falls back to reading the filename.',
  'color-contrast': 'Increase the contrast between the text and its background to at least 4.5:1 for body text (3:1 for text at 18pt/14pt-bold or larger). Adjusting the text colour is usually less disruptive than changing the background.',
  'link-name': 'Give the link discernible text. Where the link is an icon, add `aria-label` or visually-hidden text — a link that announces as "link" with no name is unusable by screen reader.',
  'button-name': 'Give the button an accessible name via its text content, `aria-label`, or `aria-labelledby`. Icon-only buttons need this without exception.',
  'form-field-multiple-labels': 'Ensure each form field has exactly one label association.',
  label: 'Associate a `<label for="…">` with the input, or wrap the input in a label. A placeholder is not a label — it disappears on focus and is not reliably announced.',
  'html-has-lang': 'Add a `lang` attribute to the `<html>` element so screen readers select the correct pronunciation rules.',
  'valid-lang': 'Correct the `lang` attribute to a valid BCP 47 language tag.',
  'duplicate-id': 'Make every `id` in the document unique. Duplicate ids break `aria-labelledby`, `for`, and fragment navigation in ways that are hard to trace.',
  'duplicate-id-active': 'Make ids on interactive elements unique — duplicates break label association and focus management.',
  'heading-order': 'Use heading levels in sequence without skipping. Screen reader users navigate by heading level, and a jump from h2 to h4 makes the document structure ambiguous.',
  'landmark-one-main': 'Add a single `<main>` landmark so keyboard and screen reader users can skip directly to the primary content.',
  region: 'Wrap all page content in landmark regions (`header`, `nav`, `main`, `footer`) so it can be navigated structurally.',
  'aria-required-attr': 'Add the ARIA attributes required by the role you have applied — an incomplete ARIA implementation is often worse than none.',
  'aria-valid-attr-value': 'Correct the ARIA attribute value; it currently references a non-existent id or uses an invalid token.',
  'aria-hidden-focus': 'An element with `aria-hidden="true"` must not contain focusable children — keyboard users can reach a control that screen readers cannot announce.',
  'nested-interactive': 'Remove the nested interactive element. Controls inside controls produce unpredictable behaviour in assistive technology.',
  bypass: 'Add a "skip to main content" link so keyboard users are not forced through the entire navigation on every page.',
  'meta-viewport': 'Remove `user-scalable=no` and any `maximum-scale` below 2 — preventing zoom locks out users with low vision.',
  tabindex: 'Avoid positive `tabindex` values; they override the natural focus order and are almost impossible to keep consistent.',
  'target-size': 'Increase the interactive target to at least 24×24 CSS pixels, or add spacing around it.',
};

export const axeViolationRule: PageRule = {
  id: 'accessibility.axe',
  description: 'WCAG violations detected by axe-core',
  run({ page }) {
    if (page.axeViolations.length === 0) return [];

    return page.axeViolations.map((violation): RawFinding => {
      const criteria = wcagCriteriaFromTags(violation.tags);
      const severity = severityFromImpact(violation.impact);
      const isBestPractice = violation.tags.includes('best-practice') && criteria.length === 0;

      return {
        ruleId: `accessibility.${violation.ruleId}`,
        // Fingerprint on the axe rule alone: every instance of "image without
        // alt text" is one fix to make, applied in many places.
        fingerprint: fingerprint('accessibility.axe', violation.ruleId),
        title: violation.help,
        category: 'ACCESSIBILITY',
        severity: isBestPractice && severity === 'HIGH' ? 'MEDIUM' : severity,
        // axe reports rule violations deterministically; contrast in particular
        // is computed, not estimated.
        confidence: 'CONFIRMED',
        description: violation.description,
        measuredFacts: [
          { label: 'axe rule', value: violation.ruleId, source: 'axe-core' },
          { label: 'Impact', value: violation.impact ?? 'unspecified', source: 'axe-core' },
          { label: 'Failing elements on this page', value: violation.nodes.length, source: 'axe-core' },
          ...(criteria.length > 0
            ? [{ label: 'WCAG criteria', value: criteria.join(', '), source: 'axe-core rule tags' }]
            : []),
        ],
        inference: criteria.length > 0
          ? `This is a failure of WCAG success criterion ${criteria.join(', ')}. ${violation.description} Users relying on assistive technology are affected directly; the failure is invisible to sighted mouse users, which is why it persists.`
          : `${violation.description} This is an accessibility best practice rather than a strict WCAG failure, but it materially affects how usable the page is with assistive technology.`,
        technicalDetails: [
          `Rule: ${violation.ruleId} (${violation.impact ?? 'unspecified'} impact)`,
          `Reference: ${violation.helpUrl}`,
          '',
          'Failing elements:',
          ...violation.nodes.slice(0, 8).map((node) => {
            const target = node.target.join(' ');
            const summary = node.failureSummary ? `\n    ${node.failureSummary.replace(/\n/g, '\n    ')}` : '';
            return `  ${target}${summary}`;
          }),
        ].join('\n'),
        impact: describeImpact(violation.ruleId, violation.impact),
        recommendation: REMEDIATION[violation.ruleId] ?? `${violation.help}. Full guidance: ${violation.helpUrl}`,
        estimatedEffort: violation.nodes.length > 20 ? 'MEDIUM' : 'SMALL',
        standardsRef: criteria.length > 0 ? `WCAG 2.1 — ${criteria.join(', ')}` : 'axe-core best practice',
        occurrences: violation.nodes.slice(0, 25).map((node) =>
          occurrence({
            pageUrl: page.url,
            selector: node.target.join(' '),
            domSnippet: sanitizeDomSnippet(node.html),
            detail: node.failureSummary ? truncate(node.failureSummary, 200) : null,
          }),
        ),
      };
    });
  },
};

function describeImpact(ruleId: string, impact: string | null): string {
  switch (ruleId) {
    case 'color-contrast':
      return 'Users with low vision, colour vision deficiency, or anyone reading on a phone in daylight cannot reliably read this text.';
    case 'image-alt':
      return 'Screen reader users receive no description of the image. Where the image conveys information — a chart, a product photo, an infographic — that information is simply unavailable to them.';
    case 'button-name':
    case 'link-name':
      return 'The control announces with no name, so a screen reader user has no way to know what activating it will do. In a list of links this makes the page unnavigable.';
    case 'label':
      return 'Screen reader users cannot tell what a form field expects, which makes the form unusable rather than merely awkward.';
    case 'bypass':
      return 'Keyboard users must tab through the entire navigation on every single page before reaching content.';
    case 'meta-viewport':
      return 'Users with low vision cannot zoom in, which can make the site completely unusable on a phone.';
    default:
      return impact === 'critical' || impact === 'serious'
        ? 'This blocks or seriously degrades use of the page for people relying on assistive technology.'
        : 'This degrades the experience for people using assistive technology, and may fail an accessibility audit or procurement requirement.';
  }
}

/** Heading structure: axe checks order, we check whether the outline is sane. */
export const headingStructureRule: PageRule = {
  id: 'accessibility.heading-structure',
  description: 'Missing or malformed heading outline',
  run({ page }) {
    const headings = page.meta?.headings ?? [];
    const findings: RawFinding[] = [];

    const h1s = headings.filter((heading) => heading.level === 1);

    if (headings.length > 0 && h1s.length === 0) {
      findings.push({
        ruleId: 'accessibility.no-h1',
        fingerprint: fingerprint('accessibility.no-h1'),
        title: 'Page has no top-level heading',
        category: 'ACCESSIBILITY',
        severity: 'MEDIUM',
        confidence: 'CONFIRMED',
        description: 'No `<h1>` element was found, so the page has no top-level heading.',
        measuredFacts: [
          { label: 'h1 elements', value: 0, source: 'DOM extraction' },
          { label: 'Total headings', value: headings.length, source: 'DOM extraction' },
          { label: 'First heading level found', value: `h${headings[0]?.level ?? '?'}`, source: 'DOM extraction' },
        ],
        inference:
          'The h1 is what a screen reader announces as the page\'s subject, and it is the first stop when navigating by heading. Without one, a user arriving on the page has no programmatic way to determine what it is about. It is also a signal search engines use to understand page topic.',
        technicalDetails: `Heading outline found:\n${headings.slice(0, 15).map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}h${h.level}: ${truncate(h.text, 70)}`).join('\n')}`,
        impact: 'Screen reader users cannot quickly determine the page subject, and the document outline is ambiguous.',
        recommendation: 'Add exactly one `<h1>` containing the page\'s main title. If a heading is already serving that role visually, change its element rather than adding a duplicate.',
        estimatedEffort: 'TRIVIAL',
        standardsRef: 'WCAG 2.1 — 1.3.1 Info and Relationships',
        occurrences: [occurrence({ pageUrl: page.url, detail: `${headings.length} headings, none at level 1` })],
      });
    }

    if (h1s.length > 1) {
      findings.push({
        ruleId: 'accessibility.multiple-h1',
        fingerprint: fingerprint('accessibility.multiple-h1'),
        title: 'Page has multiple top-level headings',
        category: 'ACCESSIBILITY',
        severity: 'LOW',
        confidence: 'CONFIRMED',
        description: `${h1s.length} \`<h1>\` elements were found on this page.`,
        measuredFacts: [
          { label: 'h1 elements', value: h1s.length, source: 'DOM extraction' },
          { label: 'Texts', value: h1s.slice(0, 3).map((h) => truncate(h.text, 40)).join(' | '), source: 'DOM extraction' },
        ],
        inference:
          'Multiple h1 elements make the document outline ambiguous — there is no single answer to "what is this page about". HTML5 sectioning was intended to make this valid, but no major screen reader implements the outline algorithm, so in practice it still causes confusion.',
        technicalDetails: h1s.map((h) => `h1: ${truncate(h.text, 90)}`).join('\n'),
        impact: 'Ambiguous document structure for assistive technology and for search engines.',
        recommendation: 'Keep one h1 as the page title and demote the others to h2 or lower according to their place in the content hierarchy.',
        estimatedEffort: 'TRIVIAL',
        standardsRef: 'WCAG 2.1 — 1.3.1 Info and Relationships',
        occurrences: [occurrence({ pageUrl: page.url, detail: `${h1s.length} h1 elements` })],
      });
    }

    return findings;
  },
};

/** Controls covered by another element — reachable by keyboard, not by mouse. */
export const obscuredControlRule: PageRule = {
  id: 'accessibility.obscured-control',
  description: 'Interactive controls covered by another element',
  run({ page }) {
    const obscured = page.interactiveElements.filter(
      (element) => element.visible && element.enabled && element.obscuredBy && element.inViewport,
    );
    if (obscured.length === 0) return [];

    return [
      {
        ruleId: 'accessibility.obscured-control',
        fingerprint: fingerprint('accessibility.obscured-control'),
        title: 'Interactive controls are covered by another element',
        category: 'UI_UX',
        severity: 'MEDIUM',
        // Hit-testing the centre point is a strong signal, but a control can be
        // legitimately covered by a transparent overlay it owns.
        confidence: 'LIKELY',
        description: `${obscured.length} visible control(s) have a different element on top of their centre point.`,
        measuredFacts: [
          { label: 'Covered controls', value: obscured.length, source: 'document.elementFromPoint at element centre' },
          ...obscured.slice(0, 4).map((element) => ({
            label: truncate(element.accessibleName || element.selector, 60),
            value: `covered by ${truncate(element.obscuredBy ?? '', 50)}`,
            source: 'document.elementFromPoint',
          })),
        ],
        inference:
          'Hit-testing each control\'s centre point returned a different element, meaning a click there lands on the overlay rather than the control. This is usually a sticky header, a cookie banner, or a chat widget positioned over interactive content. Note that a control deliberately wrapped in its own transparent overlay would also match this test, so verify before treating it as a defect.',
        technicalDetails: obscured
          .slice(0, 10)
          .map((element) => `${element.selector}\n    labelled: "${truncate(element.accessibleName, 50)}"\n    covered by: ${element.obscuredBy}`)
          .join('\n'),
        impact:
          'Users click the control and nothing happens, because the click is being absorbed by whatever sits on top. Keyboard users can still reach it, which makes the bug easy to miss in testing.',
        recommendation:
          'Check the stacking context and z-index of the covering element. Where the overlay is intentional (a cookie banner), ensure it does not extend past its visible bounds; where it is a sticky element, add scroll padding so it does not sit over interactive content.',
        estimatedEffort: 'SMALL',
        occurrences: obscured.slice(0, 20).map((element) =>
          occurrence({
            pageUrl: page.url,
            selector: element.selector,
            detail: `Covered by ${element.obscuredBy}`,
            screenshotKey: page.screenshots.viewportKey,
          }),
        ),
      },
    ];
  },
};

/** Form fields with no accessible label. */
export const unlabeledFieldRule: PageRule = {
  id: 'accessibility.unlabeled-field',
  description: 'Form fields with no accessible name',
  run({ page }) {
    const unlabeled = page.forms.flatMap((form) =>
      form.unlabeledFields.map((field) => ({ form, field })),
    );
    if (unlabeled.length === 0) return [];

    return [
      {
        ruleId: 'accessibility.unlabeled-field',
        fingerprint: fingerprint('accessibility.unlabeled-field'),
        title: 'Form fields have no accessible label',
        category: 'ACCESSIBILITY',
        severity: 'HIGH',
        confidence: 'CONFIRMED',
        description: `${unlabeled.length} form field(s) have no label, aria-label, aria-labelledby, or wrapping label element.`,
        measuredFacts: [
          { label: 'Unlabeled fields', value: unlabeled.length, source: 'Accessible-name computation' },
          { label: 'Forms affected', value: new Set(unlabeled.map((entry) => entry.form.selector)).size, source: 'DOM extraction' },
          ...unlabeled.slice(0, 4).map((entry) => ({
            label: entry.field.selector,
            value: `type=${entry.field.type}${entry.field.name ? ` name=${entry.field.name}` : ''}`,
            source: 'DOM extraction',
          })),
        ],
        inference:
          'The accessible-name computation was run for each field, checking `aria-label`, `aria-labelledby`, an associated `<label for>`, a wrapping `<label>`, and finally `placeholder`. These fields returned nothing from any of those sources, so a screen reader announces them as an unnamed edit field.',
        technicalDetails: unlabeled
          .slice(0, 12)
          .map((entry) => `${entry.field.selector} — type=${entry.field.type}${entry.field.name ? `, name="${entry.field.name}"` : ''} (form: ${entry.form.selector})`)
          .join('\n'),
        impact:
          'Screen reader users hear "edit, blank" with no indication of what to type. This does not make the form harder to use — it makes it impossible to complete without guessing.',
        recommendation:
          'Add a `<label for="fieldId">` for each field. Where the design has no room for a visible label, use `aria-label` or a visually-hidden label element. Do not rely on `placeholder` — it disappears the moment the user starts typing and is not consistently announced.',
        estimatedEffort: 'SMALL',
        standardsRef: 'WCAG 2.1 — 3.3.2 Labels or Instructions, 4.1.2 Name, Role, Value',
        occurrences: unlabeled.slice(0, 25).map((entry) =>
          occurrence({
            pageUrl: page.url,
            selector: entry.field.selector,
            detail: `type=${entry.field.type}${entry.field.name ? `, name=${entry.field.name}` : ''}`,
          }),
        ),
      },
    ];
  },
};

/** Controls with no accessible name at all. */
export const unnamedControlRule: PageRule = {
  id: 'accessibility.unnamed-control',
  description: 'Buttons and links with no discernible name',
  run({ page }) {
    const unnamed = page.interactiveElements.filter(
      (element) => element.visible && element.enabled && !element.accessibleName.trim(),
    );
    if (unnamed.length === 0) return [];

    return [
      {
        ruleId: 'accessibility.unnamed-control',
        fingerprint: fingerprint('accessibility.unnamed-control'),
        title: 'Interactive controls have no accessible name',
        category: 'ACCESSIBILITY',
        severity: 'HIGH',
        confidence: 'CONFIRMED',
        description: `${unnamed.length} visible interactive element(s) expose no accessible name.`,
        measuredFacts: [
          { label: 'Unnamed controls', value: unnamed.length, source: 'Accessible-name computation' },
          ...unnamed.slice(0, 5).map((element) => ({
            label: element.selector,
            value: `<${element.tag}>${element.role ? ` role="${element.role}"` : ''}`,
            source: 'DOM extraction',
          })),
        ],
        inference:
          'These are almost always icon-only controls — a hamburger menu, a close button, a search icon — where the icon is rendered as an SVG or a background image with no text alternative. Sighted users read the icon; assistive technology has nothing to read.',
        technicalDetails: unnamed
          .slice(0, 12)
          .map((element) => `<${element.tag}>${element.role ? ` role="${element.role}"` : ''} at ${element.selector}`)
          .join('\n'),
        impact:
          'A screen reader announces these as "button" or "link" with no name. In a page with several, the user cannot distinguish between them at all.',
        recommendation:
          'Add `aria-label` describing the action ("Close dialog", "Open navigation menu", "Search"), or include visually-hidden text inside the control. For SVG icons, `<title>` inside the SVG plus `role="img"` also works.',
        estimatedEffort: 'TRIVIAL',
        standardsRef: 'WCAG 2.1 — 4.1.2 Name, Role, Value',
        occurrences: unnamed.slice(0, 25).map((element) =>
          occurrence({
            pageUrl: page.url,
            selector: element.selector,
            detail: `<${element.tag}>${element.role ? ` role="${element.role}"` : ''} with no accessible name`,
          }),
        ),
      },
    ];
  },
};

export const accessibilityPageRules: PageRule[] = [
  axeViolationRule,
  headingStructureRule,
  obscuredControlRule,
  unlabeledFieldRule,
  unnamedControlRule,
];
