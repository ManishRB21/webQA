/**
 * Deduplication, scoring, and correlation.
 *
 * Rules emit findings per page. This module turns that stream into the finding
 * set the report shows, and it is where the product's "50 pages, 1 issue"
 * promise is actually kept.
 *
 * Three passes:
 *   1. Merge by fingerprint      — one finding, many occurrences.
 *   2. Score                     — priority from severity × confidence × reach × effort.
 *   3. Correlate                 — link findings that plausibly share a cause.
 */

import { randomUUID } from 'node:crypto';
import {
  CONFIDENCE_BASELINE,
  SEVERITY_RANK,
  computeHealthScores,
  computePageScore,
  computePriority,
  type Finding,
  type HealthScores,
  type RawFinding,
  type Severity,
} from '@webqa/shared';

export interface AggregateResult {
  findings: Finding[];
  scores: HealthScores;
  pageScores: Map<string, { healthScore: number; findingCount: number; severityCounts: Record<string, number> }>;
}

/**
 * Merge findings that share a fingerprint.
 *
 * Merge policy:
 *   - severity: keep the worst seen (a rule that fired harder somewhere wins)
 *   - confidence: keep the LOWEST seen — if the same issue was uncertain on any
 *     page, the aggregate claim should carry that uncertainty
 *   - occurrences: concatenate, capped
 *   - narrative text: first writer wins, since rules emit identical prose per
 *     fingerprint by construction
 */
export function dedupeFindings(raw: RawFinding[], auditId: string): Finding[] {
  const merged = new Map<string, Finding>();
  const now = new Date().toISOString();

  for (const finding of raw) {
    const existing = merged.get(finding.fingerprint);

    if (!existing) {
      merged.set(finding.fingerprint, {
        id: randomUUID(),
        auditId,
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        title: finding.title,
        category: finding.category,
        severity: finding.severity,
        confidence: finding.confidence,
        confidenceScore: CONFIDENCE_BASELINE[finding.confidence],
        status: 'OPEN',
        description: finding.description,
        measuredFacts: finding.measuredFacts,
        inference: finding.inference,
        technicalDetails: finding.technicalDetails,
        impact: finding.impact,
        recommendation: finding.recommendation,
        estimatedEffort: finding.estimatedEffort,
        reproduction: finding.reproduction ?? null,
        standardsRef: finding.standardsRef ?? null,
        occurrences: [...finding.occurrences],
        affectedPageCount: 0,
        affectedElementCount: 0,
        relatedFingerprints: [...(finding.relatedFingerprints ?? [])],
        ai: null,
        priorityScore: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }

    // Worst severity wins.
    if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) {
      existing.severity = finding.severity;
    }

    // Lowest confidence wins — honesty over confidence inflation.
    if (CONFIDENCE_BASELINE[finding.confidence] < existing.confidenceScore) {
      existing.confidence = finding.confidence;
      existing.confidenceScore = CONFIDENCE_BASELINE[finding.confidence];
    }

    // Cap occurrences: the 500th instance of a missing alt attribute adds no
    // information and bloats the report.
    if (existing.occurrences.length < 200) {
      existing.occurrences.push(...finding.occurrences.slice(0, 200 - existing.occurrences.length));
    }

    for (const related of finding.relatedFingerprints ?? []) {
      if (!existing.relatedFingerprints.includes(related)) existing.relatedFingerprints.push(related);
    }

    // Prefer the longest technical detail — usually the most complete instance.
    if (finding.technicalDetails.length > existing.technicalDetails.length) {
      existing.technicalDetails = finding.technicalDetails;
    }
  }

  // Recompute reach from the merged occurrence lists.
  for (const finding of merged.values()) {
    finding.affectedPageCount = new Set(finding.occurrences.map((o) => o.pageUrl)).size;
    finding.affectedElementCount = finding.occurrences.length;
  }

  return [...merged.values()];
}

/**
 * Link findings that plausibly share a root cause.
 *
 * This is heuristic and deliberately conservative: correlations are shown as
 * "related", never asserted as causal. The value is navigational — a reader
 * looking at slow LCP should be able to jump straight to the oversized payload
 * finding without hunting for it.
 */
export function correlateFindings(findings: Finding[]): void {
  const byRule = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = byRule.get(finding.ruleId) ?? [];
    bucket.push(finding);
    byRule.set(finding.ruleId, bucket);
  }

  const link = (aRule: string, bRule: string): void => {
    const as = byRule.get(aRule) ?? [];
    const bs = byRule.get(bRule) ?? [];
    for (const a of as) {
      for (const b of bs) {
        if (a.fingerprint === b.fingerprint) continue;
        if (!a.relatedFingerprints.includes(b.fingerprint)) a.relatedFingerprints.push(b.fingerprint);
        if (!b.relatedFingerprints.includes(a.fingerprint)) b.relatedFingerprints.push(a.fingerprint);
      }
    }
  };

  // Performance chains: these genuinely tend to share a cause.
  link('performance.lcp', 'performance.payload');
  link('performance.lcp', 'performance.ttfb');
  link('performance.lcp', 'performance.render-blocking');
  link('performance.payload', 'performance.unused-script');
  link('performance.payload', 'performance.compression');
  link('performance.long-tasks', 'performance.unused-script');
  link('performance.cls', 'seo.image-alt');

  // A blank page and a load-time exception are very often the same bug.
  link('ui.empty-page', 'functional.js-exception');
  link('ui.empty-page', 'functional.broken-critical-resource');

  // Overflow findings describe the same underlying layout problem.
  link('ui.horizontal-overflow', 'ui.element-overflow');

  // An interaction that fails and a failing endpoint are usually one story.
  link('functional.interaction-api-failure', 'functional.failed-request');
  link('functional.interaction-exception', 'functional.js-exception');

  // Missing HTTPS makes every other transport finding worse.
  link('security.no-https', 'security.mixed-content');
  link('security.no-https', 'security.cookie-attributes');
}

export function aggregate(raw: RawFinding[], auditId: string, totalPages: number): AggregateResult {
  const findings = dedupeFindings(raw, auditId);
  correlateFindings(findings);

  for (const finding of findings) {
    const breakdown = computePriority({
      severity: finding.severity,
      confidence: finding.confidence,
      confidenceScore: finding.confidenceScore,
      affectedPageCount: finding.affectedPageCount,
      affectedElementCount: finding.affectedElementCount,
      estimatedEffort: finding.estimatedEffort,
      totalPages,
    });
    finding.priorityScore = breakdown.score;
  }

  findings.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });

  const scores = computeHealthScores(
    findings.map((finding) => ({
      category: finding.category,
      severity: finding.severity,
      affectedPageCount: finding.affectedPageCount,
      confidenceScore: finding.confidenceScore,
    })),
    totalPages,
  );

  return { findings, scores, pageScores: computePageScores(findings) };
}

/** Per-page health scores, computed from the findings that touch each page. */
export function computePageScores(
  findings: Finding[],
): Map<string, { healthScore: number; findingCount: number; severityCounts: Record<string, number> }> {
  const byPage = new Map<string, Finding[]>();

  for (const finding of findings) {
    // A finding counts once per page it occurs on, however many elements.
    for (const pageUrl of new Set(finding.occurrences.map((o) => o.pageUrl))) {
      const bucket = byPage.get(pageUrl) ?? [];
      bucket.push(finding);
      byPage.set(pageUrl, bucket);
    }
  }

  const result = new Map<string, { healthScore: number; findingCount: number; severityCounts: Record<string, number> }>();

  for (const [pageUrl, pageFindings] of byPage) {
    const severityCounts: Record<string, number> = {};
    for (const finding of pageFindings) {
      severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
    }

    result.set(pageUrl, {
      healthScore: computePageScore(
        pageFindings.map((finding) => ({
          category: finding.category,
          severity: finding.severity,
          affectedPageCount: 1,
          confidenceScore: finding.confidenceScore,
        })),
      ),
      findingCount: pageFindings.length,
      severityCounts,
    });
  }

  return result;
}

/** Severity histogram for the report header. */
export function severityHistogram(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
