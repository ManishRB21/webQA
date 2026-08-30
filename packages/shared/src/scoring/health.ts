/**
 * Health scoring — the 0..100 numbers at the top of the report.
 *
 * Approach: start every category at 100 and subtract a penalty per finding,
 * scaled by severity and by how much of the site is affected. Penalties are
 * summed then passed through a saturating curve so that a site with 40 medium
 * issues does not land at a meaningless 0.
 *
 * Why not Lighthouse-style weighted audits? Because our finding set is open —
 * new rules ship regularly — and a fixed weight table would need rebalancing
 * every time. A penalty model degrades gracefully as rules are added.
 */

import { CATEGORIES, type Category, type Severity } from '../types/common.js';
import type { HealthScores } from '../types/audit.js';

/** Base penalty points for a single finding, before reach scaling. */
const SEVERITY_PENALTY: Record<Severity, number> = {
  CRITICAL: 45,
  HIGH: 22,
  MEDIUM: 9,
  LOW: 3,
  INFO: 0.5,
};

/**
 * Category weights for the overall score. Functional and Performance dominate
 * because they are what users actually feel; Best Practices barely moves it.
 */
const CATEGORY_WEIGHT: Record<Category, number> = {
  FUNCTIONAL: 0.24,
  PERFORMANCE: 0.2,
  ACCESSIBILITY: 0.14,
  SEO: 0.12,
  SECURITY: 0.14,
  RELIABILITY: 0.08,
  UI_UX: 0.06,
  BEST_PRACTICES: 0.02,
};

export interface ScorableFinding {
  category: Category;
  severity: Severity;
  affectedPageCount: number;
  /** 0..1; a POSSIBLE finding should not tank a score like a CONFIRMED one. */
  confidenceScore: number;
}

/**
 * Saturating transform: maps accumulated penalty points to a 0..100 score.
 * 0 points → 100. 25 points → ~78. 100 points → ~37. 300 points → ~9.
 */
function penaltyToScore(points: number): number {
  const score = 100 * Math.exp(-points / 90);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function penaltyFor(finding: ScorableFinding, totalPages: number): number {
  const base = SEVERITY_PENALTY[finding.severity];
  // Reach multiplier: 1.0 for a single page, up to 2.0 for site-wide.
  const share = Math.min(1, finding.affectedPageCount / Math.max(1, totalPages));
  const reach = 1 + share;
  return base * reach * finding.confidenceScore;
}

export function computeHealthScores(
  findings: ScorableFinding[],
  totalPages: number,
): HealthScores {
  const penalties = {} as Record<Category, number>;
  for (const category of CATEGORIES) penalties[category] = 0;

  for (const finding of findings) {
    penalties[finding.category] += penaltyFor(finding, totalPages);
  }

  const categories = {} as Record<Category, number>;
  for (const category of CATEGORIES) {
    categories[category] = penaltyToScore(penalties[category]);
  }

  // Weighted mean of category scores.
  let weighted = 0;
  let weightSum = 0;
  for (const category of CATEGORIES) {
    const w = CATEGORY_WEIGHT[category];
    weighted += categories[category] * w;
    weightSum += w;
  }
  const overall = Math.round(weighted / weightSum);

  return { overall, categories };
}

/**
 * Per-page score. Same penalty curve, but reach is irrelevant (a page is one
 * page), so we use the raw severity penalty scaled by confidence.
 */
export function computePageScore(findings: ScorableFinding[]): number {
  let points = 0;
  for (const finding of findings) {
    points += SEVERITY_PENALTY[finding.severity] * finding.confidenceScore;
  }
  return penaltyToScore(points);
}

/** Bucket a score for UI colouring. */
export function scoreBand(score: number): 'good' | 'fair' | 'poor' {
  if (score >= 85) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}
