/**
 * Accessibility scanning via axe-core.
 *
 * axe-core is injected as source text rather than imported into the page,
 * because the audited page has its own module system (or none) and we cannot
 * rely on anything being available there.
 *
 * We take axe's raw violations as observations, NOT as findings. The rule
 * engine decides severity — axe's own "impact" is a useful signal but it has no
 * knowledge of how many pages are affected or whether the element is in the
 * primary flow.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import type { AxeViolationObservation } from '@webqa/shared';
import { truncate } from '@webqa/shared';

const require = createRequire(import.meta.url);

let axeSource: string | null = null;

function loadAxeSource(): string {
  if (axeSource) return axeSource;
  const path = require.resolve('axe-core/axe.min.js');
  axeSource = readFileSync(path, 'utf8');
  return axeSource;
}

/** Rules we skip: noisy on real sites, or duplicated by our own layout checks. */
const DISABLED_RULES = [
  // Flags every iframe on the page; a third-party embed is not the site's bug.
  'frame-tested',
];

export async function runAxe(page: Page): Promise<AxeViolationObservation[]> {
  try {
    await page.evaluate(loadAxeSource());
  } catch {
    // Some pages have a CSP that blocks injected script evaluation entirely.
    // That is worth knowing but is not itself an accessibility result.
    return [];
  }

  try {
    const raw = await page.evaluate(
      async ({ disabled }) => {
        const axe = (window as unknown as { axe?: Record<string, unknown> }).axe;
        if (!axe || typeof (axe as { run?: unknown }).run !== 'function') return null;

        const rules: Record<string, { enabled: boolean }> = {};
        for (const id of disabled) rules[id] = { enabled: false };

        const results = await (
          axe as { run: (ctx: unknown, opts: unknown) => Promise<unknown> }
        ).run(document, {
          rules,
          resultTypes: ['violations'],
          // WCAG 2.0/2.1/2.2 A and AA, plus axe's own best-practice set.
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
          },
          // Frames often belong to third parties and time out.
          iframes: false,
        });

        return results as {
          violations: Array<{
            id: string;
            impact: string | null;
            description: string;
            help: string;
            helpUrl: string;
            tags: string[];
            nodes: Array<{ target: string[]; html: string; failureSummary?: string }>;
          }>;
        };
      },
      { disabled: DISABLED_RULES },
    );

    if (!raw?.violations) return [];

    return raw.violations.slice(0, 100).map((violation) => ({
      ruleId: violation.id,
      impact: (violation.impact as AxeViolationObservation['impact']) ?? null,
      description: truncate(violation.description ?? '', 500),
      help: truncate(violation.help ?? '', 300),
      helpUrl: violation.helpUrl ?? '',
      tags: violation.tags ?? [],
      // Cap nodes per violation: a table with 500 unlabelled cells produces
      // 500 nodes, and the 20th is as informative as the 500th.
      nodes: (violation.nodes ?? []).slice(0, 20).map((node) => ({
        target: node.target ?? [],
        html: truncate(node.html ?? '', 400),
        failureSummary: node.failureSummary ? truncate(node.failureSummary, 500) : null,
      })),
    }));
  } catch {
    return [];
  }
}

/** Extract the WCAG success criteria from axe's tag list, e.g. `wcag143` → `1.4.3`. */
export function wcagCriteriaFromTags(tags: string[]): string[] {
  const criteria: string[] = [];
  for (const tag of tags) {
    const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (match) criteria.push(`${match[1]}.${match[2]}.${match[3]}`);
  }
  return criteria;
}

/** Map axe's impact onto our severity vocabulary. */
export function severityFromImpact(impact: string | null): 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' {
  switch (impact) {
    case 'critical': return 'HIGH';
    case 'serious': return 'HIGH';
    case 'moderate': return 'MEDIUM';
    case 'minor': return 'LOW';
    default: return 'INFO';
  }
}
