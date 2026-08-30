/**
 * Priority scoring — answers "what should I fix first?"
 *
 * The score is intentionally simple and explainable. A user who disagrees with
 * an ordering should be able to see exactly which term caused it, so we expose
 * the breakdown rather than returning a bare number.
 *
 *   priority = severityWeight × confidence × reachFactor × effortBonus
 *
 * `reachFactor` uses a logarithm because the difference between 1 and 10
 * affected pages matters far more than the difference between 90 and 100.
 */

import {
  CONFIDENCE_BASELINE,
  EFFORT_WEIGHT,
  type ConfidenceLevel,
  type EffortLevel,
  type Severity,
} from '../types/common.js';

const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 100,
  HIGH: 60,
  MEDIUM: 30,
  LOW: 12,
  INFO: 3,
};

export interface PriorityInput {
  severity: Severity;
  confidence: ConfidenceLevel;
  /** Explicit numeric confidence overrides the level's baseline when provided. */
  confidenceScore?: number;
  affectedPageCount: number;
  affectedElementCount: number;
  estimatedEffort: EffortLevel;
  /** Total pages crawled, used to express reach as a share of the site. */
  totalPages: number;
}

export interface PriorityBreakdown {
  score: number;
  severityWeight: number;
  confidenceFactor: number;
  reachFactor: number;
  effortBonus: number;
}

export function computePriority(input: PriorityInput): PriorityBreakdown {
  const severityWeight = SEVERITY_WEIGHT[input.severity];
  const confidenceFactor = input.confidenceScore ?? CONFIDENCE_BASELINE[input.confidence];

  // Reach: how much of the site is affected. Ranges roughly 1.0 → 2.5.
  const total = Math.max(1, input.totalPages);
  const share = Math.min(1, input.affectedPageCount / total);
  const reachFactor = 1 + Math.log10(1 + 9 * share) * 1.5;

  // Effort bonus rewards cheap wins without letting effort dominate severity.
  // A TRIVIAL fix gets 1.25x; a LARGE one gets 0.85x.
  const weight = EFFORT_WEIGHT[input.estimatedEffort];
  const effortBonus = 1.25 - Math.log2(weight) * 0.13;

  const score = severityWeight * confidenceFactor * reachFactor * effortBonus;

  return {
    score: Math.round(score * 100) / 100,
    severityWeight,
    confidenceFactor,
    reachFactor: Math.round(reachFactor * 1000) / 1000,
    effortBonus: Math.round(effortBonus * 1000) / 1000,
  };
}

/**
 * Clamp an AI-suggested severity to at most one step away from the rule's
 * severity.
 *
 * Rationale: rules observe evidence, models observe a summary of evidence. We
 * let the model nudge — a 500 on a marketing page is genuinely less severe
 * than a 500 on checkout, and the model may know that from the URL — but we do
 * not let it turn INFO into CRITICAL or vice versa on reasoning alone.
 */
export function clampSeverityAdjustment(ruleSeverity: Severity, suggested: Severity): Severity {
  const order: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  const base = order.indexOf(ruleSeverity);
  const want = order.indexOf(suggested);
  if (base < 0 || want < 0) return ruleSeverity;
  const delta = Math.max(-1, Math.min(1, want - base));
  return order[base + delta] ?? ruleSeverity;
}

/**
 * Likewise, a model may lower confidence freely (healthy skepticism) but may
 * only raise it one step, and never to CONFIRMED unless the rule already was.
 */
export function clampConfidenceAdjustment(
  ruleConfidence: ConfidenceLevel,
  suggested: ConfidenceLevel,
): ConfidenceLevel {
  const order: ConfidenceLevel[] = ['CONFIRMED', 'LIKELY', 'POSSIBLE'];
  const base = order.indexOf(ruleConfidence);
  const want = order.indexOf(suggested);
  if (base < 0 || want < 0) return ruleConfidence;
  // Lowering confidence (higher index) is always allowed.
  if (want > base) return suggested;
  // Raising is capped at one step and can never reach CONFIRMED from POSSIBLE.
  const raised = Math.max(base - 1, want);
  return order[raised] ?? ruleConfidence;
}
