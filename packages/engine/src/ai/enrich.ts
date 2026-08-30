/**
 * AI enrichment.
 *
 * The contract with the model, enforced structurally rather than by asking
 * nicely:
 *
 *   - It never sees the website. It sees a table of evidence we collected.
 *   - It cannot create findings. It can only annotate ones the rules produced.
 *   - It cannot promote a POSSIBLE finding to CONFIRMED, and it cannot move
 *     severity more than one step. Those clamps are applied in code after the
 *     response comes back, so a persuasive hallucination changes nothing.
 *
 * What the model is genuinely good at, and why it earns its place: turning a
 * measurement into an explanation of business impact, spotting that three
 * findings share one root cause, and writing the executive summary a human
 * would otherwise have to write.
 */

import { createHash } from 'node:crypto';
import {
  clampConfidenceAdjustment,
  clampSeverityAdjustment,
  CONFIDENCE_BASELINE,
  truncate,
  type AiEnrichment,
  type EffortLevel,
  type Finding,
  type HealthScores,
  type Severity,
} from '@webqa/shared';
import type { LlmProvider } from './provider.js';
import type { Reporter } from '../logger.js';

// ── Enrichment ─────────────────────────────────────────────────────────────

const ENRICHMENT_SYSTEM = `You are a senior software engineer reviewing the output of an automated website audit.

You are given findings that were produced by deterministic probes — a real browser loaded the site, and every number you see was measured, not estimated. Your job is to explain what the evidence means, not to look for new problems.

Rules you must follow:

1. NEVER invent evidence. You may only reason about the measurements provided. If the evidence does not support a conclusion, say so plainly.
2. Distinguish fact from inference. The "measuredFacts" you receive are observations. Anything you add beyond them is your interpretation and must be phrased as such ("this suggests", "the most likely cause is").
3. Be specific. "Optimise your images" is worthless. "The 1.8 MB hero image at /img/hero.jpg is 67% of the page payload and is the LCP element" is useful.
4. Respect the stated confidence. A finding marked POSSIBLE was flagged because the evidence was ambiguous. Do not write about it as though it were certain.
5. Estimate effort honestly from an engineer's perspective: TRIVIAL (a config line or attribute), SMALL (under an hour), MEDIUM (half a day), LARGE (multi-day, or requires architectural change).
6. Write for a mixed audience: an engineer needs the technical cause, a product manager needs the user impact. Keep each field tight — two or three sentences.

You may suggest a different severity if the evidence clearly warrants it (for example, a broken control on a checkout page matters more than the same control on a legal page). Your suggestion is advisory; it will be applied conservatively.`;

const ENRICHMENT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fingerprint: { type: 'string', description: 'Echo the fingerprint of the finding being annotated' },
          whatHappened: { type: 'string', description: 'Plain-language statement of what the evidence shows' },
          userImpact: { type: 'string', description: 'Concrete effect on a real visitor' },
          businessImpact: { type: 'string', description: 'Effect on conversion, trust, reach, or compliance' },
          likelyRootCause: { type: 'string', description: 'Most probable cause, phrased as a hypothesis when uncertain' },
          recommendation: { type: 'string', description: 'Specific engineering action, naming files/resources where known' },
          estimatedEffort: { type: 'string', enum: ['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN'] },
          confidence: { type: 'string', enum: ['CONFIRMED', 'LIKELY', 'POSSIBLE'] },
          suggestedSeverity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNCHANGED'] },
          caveats: { type: 'array', items: { type: 'string' }, description: 'Anything the reader should be careful about' },
        },
        required: [
          'fingerprint', 'whatHappened', 'userImpact', 'businessImpact',
          'likelyRootCause', 'recommendation', 'estimatedEffort', 'confidence',
          'suggestedSeverity', 'caveats',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

interface EnrichmentResponse {
  findings: Array<{
    fingerprint: string;
    whatHappened: string;
    userImpact: string;
    businessImpact: string;
    likelyRootCause: string;
    recommendation: string;
    estimatedEffort: string;
    confidence: string;
    suggestedSeverity: string;
    caveats: string[];
  }>;
}

/**
 * Serialize a finding for the model.
 *
 * Deliberately compact: evidence only, no scores or internal ids beyond the
 * fingerprint it must echo back. Occurrences are sampled — the model does not
 * need all 214 instances to understand the shape of the problem, and sending
 * them would cost tokens for nothing.
 */
function serializeFinding(finding: Finding, siteContext: string): string {
  const lines: string[] = [
    `### Finding: ${finding.fingerprint}`,
    `Title: ${finding.title}`,
    `Category: ${finding.category}`,
    `Rule severity: ${finding.severity}`,
    `Rule confidence: ${finding.confidence}`,
    `Reach: ${finding.affectedPageCount} page(s), ${finding.affectedElementCount} element(s)`,
    '',
    'MEASURED FACTS (observed, not inferred):',
    ...finding.measuredFacts.map(
      (fact) => `  - ${fact.label}: ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}   [source: ${fact.source}]`,
    ),
    '',
    `RULE'S INFERENCE: ${finding.inference}`,
    '',
    `TECHNICAL DETAIL:\n${truncate(finding.technicalDetails, 1200)}`,
  ];

  const sampleOccurrences = finding.occurrences.slice(0, 4);
  if (sampleOccurrences.length > 0) {
    lines.push('', `EXAMPLE OCCURRENCES (${sampleOccurrences.length} of ${finding.occurrences.length}):`);
    for (const item of sampleOccurrences) {
      lines.push(`  - ${item.pageUrl}${item.selector ? ` @ ${item.selector}` : ''}${item.detail ? ` — ${truncate(item.detail, 160)}` : ''}`);
    }
  }

  return lines.join('\n');
}

export interface EnrichmentOptions {
  provider: LlmProvider;
  findings: Finding[];
  siteUrl: string;
  batchSize: number;
  maxRequests: number;
  reporter: Reporter;
  /** Records every call for the report's AI audit trail. */
  onCall?: (record: {
    purpose: string;
    requestDigest: string;
    response: unknown;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
    error: string | null;
  }) => void;
}

export async function enrichFindings(options: EnrichmentOptions): Promise<number> {
  const { provider, findings, reporter } = options;

  // Enrich in priority order and stop at the request budget. If a site has 200
  // findings we spend the budget on the 40 that matter, not the last 40.
  const candidates = findings
    .filter((finding) => finding.severity !== 'INFO')
    .slice(0, options.batchSize * options.maxRequests);

  if (candidates.length === 0) return 0;

  const byFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));
  const siteContext = `Site under audit: ${options.siteUrl}`;
  let enriched = 0;
  let requests = 0;

  for (let index = 0; index < candidates.length; index += options.batchSize) {
    if (requests >= options.maxRequests) break;
    const batch = candidates.slice(index, index + options.batchSize);
    requests += 1;

    const user = [
      siteContext,
      '',
      `Annotate each of the ${batch.length} findings below. Return one entry per finding, echoing its fingerprint exactly.`,
      '',
      ...batch.map((finding) => serializeFinding(finding, siteContext)),
    ].join('\n\n');

    const digest = createHash('sha256').update(user).digest('hex').slice(0, 16);

    reporter.info(`AI analysis: batch ${requests}/${Math.min(options.maxRequests, Math.ceil(candidates.length / options.batchSize))} (${batch.length} findings)`);

    const response = await provider.complete<EnrichmentResponse>({
      system: ENRICHMENT_SYSTEM,
      user,
      schema: ENRICHMENT_SCHEMA as unknown as Record<string, unknown>,
      purpose: 'FINDING_ENRICHMENT',
      maxTokens: 8000,
    });

    options.onCall?.({
      purpose: 'FINDING_ENRICHMENT',
      requestDigest: digest,
      response: response.data,
      inputTokens: response.usage?.inputTokens ?? null,
      outputTokens: response.usage?.outputTokens ?? null,
      latencyMs: response.latencyMs,
      error: response.error,
    });

    if (!response.ok || !response.data) {
      reporter.warn(`AI enrichment batch failed: ${response.error ?? 'unknown error'}`);

      // Distinguish a batch-specific failure from an account-wide one. A rate
      // limit or a rejected credential will fail every remaining batch too, so
      // firing seven more requests just burns quota and delays the report.
      if (isAccountLevelFailure(response.error)) {
        reporter.warn('Skipping remaining AI batches — this failure affects every request, not just this batch.');
        break;
      }

      // Anything else is per-batch; the deterministic findings stand alone.
      continue;
    }

    for (const annotation of response.data.findings ?? []) {
      const finding = byFingerprint.get(annotation.fingerprint);
      if (!finding) continue; // The model echoed an id we did not send.

      const suggestedSeverity =
        annotation.suggestedSeverity && annotation.suggestedSeverity !== 'UNCHANGED'
          ? (annotation.suggestedSeverity as Severity)
          : null;

      const enrichment: AiEnrichment = {
        provider: provider.name,
        model: provider.model,
        whatHappened: annotation.whatHappened,
        userImpact: annotation.userImpact,
        businessImpact: annotation.businessImpact,
        likelyRootCause: annotation.likelyRootCause,
        recommendation: annotation.recommendation,
        estimatedEffort: normalizeEffort(annotation.estimatedEffort),
        confidence: clampConfidenceAdjustment(finding.confidence, normalizeConfidence(annotation.confidence)),
        suggestedSeverity,
        caveats: Array.isArray(annotation.caveats) ? annotation.caveats.slice(0, 5) : [],
        generatedAt: new Date().toISOString(),
        usage: response.usage,
      };

      finding.ai = enrichment;

      // Apply the clamped adjustments. The model informs; it does not decide.
      if (suggestedSeverity) {
        finding.severity = clampSeverityAdjustment(finding.severity, suggestedSeverity);
      }
      finding.confidence = enrichment.confidence;
      finding.confidenceScore = CONFIDENCE_BASELINE[enrichment.confidence];

      // Prefer the model's prose for impact and recommendation — this is the
      // part it genuinely does better than a template — but keep the rule's
      // measured facts and inference untouched.
      if (enrichment.userImpact) finding.impact = enrichment.userImpact;
      if (enrichment.recommendation) finding.recommendation = enrichment.recommendation;
      if (enrichment.estimatedEffort !== 'UNKNOWN') finding.estimatedEffort = enrichment.estimatedEffort;

      enriched += 1;
    }
  }

  reporter.success(`AI analysis complete — ${enriched} finding(s) enriched across ${requests} request(s)`);
  return enriched;
}

// ── Executive summary ──────────────────────────────────────────────────────

const SUMMARY_SYSTEM = `You write the executive summary at the top of a website audit report.

Your reader is a decision-maker: a CTO, an engineering lead, or a product owner. They will read your summary and nothing else before deciding what to do.

Requirements:
- Open with a direct assessment of the site's overall state. No preamble, no restating the question.
- Name the specific issues that matter most and say why, using the actual numbers from the evidence.
- Be honest about severity in both directions. If the site is in good shape, say so — inflating problems to seem useful destroys trust in the report.
- Separate "this is broken and costing you now" from "this is technical debt".
- Never invent findings. Everything you write must trace to the data provided.
- Three to five sentences for the summary. Concrete beats comprehensive.`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '3-5 sentence executive assessment' },
    topRisks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3 issues needing immediate attention, one line each',
    },
    quickWins: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3 high-value, low-effort fixes, one line each',
    },
  },
  required: ['summary', 'topRisks', 'quickWins'],
  additionalProperties: false,
} as const;

export interface SummaryResult {
  text: string;
  generatedBy: 'AI' | 'TEMPLATE';
  topRisks: string[];
  quickWins: string[];
}

export async function generateExecutiveSummary(options: {
  provider: LlmProvider;
  findings: Finding[];
  scores: HealthScores;
  siteUrl: string;
  pagesCrawled: number;
  reporter: Reporter;
  onCall?: EnrichmentOptions['onCall'];
}): Promise<SummaryResult> {
  const { findings, scores, reporter } = options;

  const critical = findings.filter((finding) => finding.severity === 'CRITICAL');
  const high = findings.filter((finding) => finding.severity === 'HIGH');

  const payload = [
    `Site: ${options.siteUrl}`,
    `Pages crawled: ${options.pagesCrawled}`,
    '',
    'HEALTH SCORES (0-100):',
    `  Overall: ${scores.overall}`,
    ...Object.entries(scores.categories).map(([category, score]) => `  ${category}: ${score}`),
    '',
    `FINDINGS: ${findings.length} total — ${critical.length} critical, ${high.length} high`,
    '',
    'TOP FINDINGS BY PRIORITY:',
    ...findings.slice(0, 15).map((finding, index) =>
      [
        `${index + 1}. [${finding.severity}/${finding.confidence}] ${finding.title}`,
        `   Category: ${finding.category} · Reach: ${finding.affectedPageCount} page(s) · Effort: ${finding.estimatedEffort}`,
        `   Evidence: ${finding.measuredFacts.slice(0, 3).map((fact) => `${fact.label}=${fact.value}`).join(', ')}`,
      ].join('\n'),
    ),
  ].join('\n');

  const response = await options.provider.complete<{ summary: string; topRisks: string[]; quickWins: string[] }>({
    system: SUMMARY_SYSTEM,
    user: payload,
    schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    purpose: 'EXECUTIVE_SUMMARY',
    maxTokens: 2000,
  });

  options.onCall?.({
    purpose: 'EXECUTIVE_SUMMARY',
    requestDigest: createHash('sha256').update(payload).digest('hex').slice(0, 16),
    response: response.data,
    inputTokens: response.usage?.inputTokens ?? null,
    outputTokens: response.usage?.outputTokens ?? null,
    latencyMs: response.latencyMs,
    error: response.error,
  });

  if (response.ok && response.data?.summary) {
    return {
      text: response.data.summary,
      generatedBy: 'AI',
      topRisks: (response.data.topRisks ?? []).slice(0, 3),
      quickWins: (response.data.quickWins ?? []).slice(0, 3),
    };
  }

  if (response.error && response.error !== 'AI analysis is disabled') {
    reporter.warn(`Executive summary generation failed: ${response.error} — using template`);
  }

  return templateSummary(findings, scores, options.pagesCrawled);
}

/**
 * Deterministic fallback summary.
 *
 * This exists so the report is never missing its most-read section just because
 * AI was unavailable. It is stated numerically rather than trying to imitate
 * prose it cannot produce.
 */
export function templateSummary(
  findings: Finding[],
  scores: HealthScores,
  pagesCrawled: number,
): SummaryResult {
  const critical = findings.filter((finding) => finding.severity === 'CRITICAL');
  const high = findings.filter((finding) => finding.severity === 'HIGH');

  const weakest = Object.entries(scores.categories).sort((a, b) => a[1] - b[1])[0];

  const parts: string[] = [];

  if (scores.overall >= 85) {
    parts.push(`This site scores ${scores.overall}/100 overall and is in good shape.`);
  } else if (scores.overall >= 60) {
    parts.push(`This site scores ${scores.overall}/100 overall — broadly healthy, with specific areas needing attention.`);
  } else {
    parts.push(`This site scores ${scores.overall}/100 overall, indicating significant issues across multiple areas.`);
  }

  parts.push(
    `Across ${pagesCrawled} page${pagesCrawled === 1 ? '' : 's'}, ${findings.length} distinct issue${findings.length === 1 ? '' : 's'} were identified` +
      (critical.length + high.length > 0
        ? `, including ${critical.length} critical and ${high.length} high-severity.`
        : ', none of them critical or high-severity.'),
  );

  if (weakest && weakest[1] < 70) {
    parts.push(`The weakest area is ${weakest[0].toLowerCase().replace('_', '/')} at ${weakest[1]}/100.`);
  }

  if (critical.length > 0) {
    parts.push(`The most urgent item is: ${critical[0]!.title}.`);
  } else if (high.length > 0) {
    parts.push(`The highest-priority item is: ${high[0]!.title}.`);
  }

  const quickWins = findings
    .filter((finding) => (finding.estimatedEffort === 'TRIVIAL' || finding.estimatedEffort === 'SMALL') && finding.severity !== 'INFO')
    .slice(0, 3)
    .map((finding) => `${finding.title} (${finding.estimatedEffort.toLowerCase()} fix, ${finding.affectedPageCount} page(s) affected)`);

  return {
    text: parts.join(' '),
    generatedBy: 'TEMPLATE',
    topRisks: [...critical, ...high].slice(0, 3).map((finding) => `${finding.title} — ${finding.affectedPageCount} page(s) affected`),
    quickWins,
  };
}

/**
 * True when a failure will repeat on every subsequent request — an exhausted
 * quota, a rejected credential, a model the account cannot reach.
 */
function isAccountLevelFailure(error: string | null): boolean {
  if (!error) return false;
  return /rate limit|authentication failed|access denied|quota/i.test(error);
}

function normalizeEffort(value: string): EffortLevel {
  const upper = (value ?? '').toUpperCase();
  return ['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN'].includes(upper)
    ? (upper as EffortLevel)
    : 'UNKNOWN';
}

function normalizeConfidence(value: string): 'CONFIRMED' | 'LIKELY' | 'POSSIBLE' {
  const upper = (value ?? '').toUpperCase();
  return upper === 'CONFIRMED' || upper === 'LIKELY' || upper === 'POSSIBLE' ? upper : 'POSSIBLE';
}
