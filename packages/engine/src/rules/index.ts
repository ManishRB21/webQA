/**
 * Rule registry and runner.
 *
 * Rules are isolated from each other: one throwing must not stop the rest, or
 * a single edge case in an SEO rule would cost the user their entire security
 * section. Failures are collected and surfaced rather than swallowed.
 */

import type { PageObservations, RawFinding, ResolvedAuditConfig, SiteObservations } from '@webqa/shared';
import { accessibilityPageRules } from './accessibility.js';
import { functionalPageRules, functionalSiteRules } from './functional.js';
import { performancePageRules } from './performance.js';
import { seoPageRules, seoSiteRules } from './seo.js';
import { securityPageRules, securitySiteRules } from './security.js';
import { uiPageRules } from './ui.js';
import type { PageRule, SiteRule } from './types.js';

export const PAGE_RULES: PageRule[] = [
  ...functionalPageRules,
  ...performancePageRules,
  ...accessibilityPageRules,
  ...seoPageRules,
  ...securityPageRules,
  ...uiPageRules,
];

export const SITE_RULES: SiteRule[] = [
  ...functionalSiteRules,
  ...seoSiteRules,
  ...securitySiteRules,
];

export interface RuleRunResult {
  findings: RawFinding[];
  errors: Array<{ ruleId: string; pageUrl: string | null; message: string }>;
}

export function runRules(input: {
  pages: PageObservations[];
  site: SiteObservations;
  config: ResolvedAuditConfig;
}): RuleRunResult {
  const findings: RawFinding[] = [];
  const errors: RuleRunResult['errors'] = [];
  const totalPages = input.pages.length;

  for (const page of input.pages) {
    for (const rule of PAGE_RULES) {
      try {
        findings.push(...rule.run({ page, site: input.site, config: input.config, totalPages }));
      } catch (error) {
        errors.push({
          ruleId: rule.id,
          pageUrl: page.url,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  for (const rule of SITE_RULES) {
    try {
      findings.push(...rule.run({ pages: input.pages, site: input.site, config: input.config, totalPages }));
    } catch (error) {
      errors.push({
        ruleId: rule.id,
        pageUrl: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { findings, errors };
}

export * from './types.js';
