/**
 * The Finding model — the product's primary output.
 *
 * Design notes worth defending:
 *
 * 1. `evidence` is mandatory and typed. A finding with no evidence cannot be
 *    constructed, which is what keeps the AI layer honest.
 *
 * 2. The three explanation fields are deliberately separate:
 *      - `measuredFacts`   — what we literally observed. Never AI-authored.
 *      - `inference`       — why we believe that indicates a problem.
 *      - `recommendation`  — what an engineer should do about it.
 *    Merging these is how audit tools end up asserting speculation as fact.
 *
 * 3. `fingerprint` drives deduplication. "Missing alt text" on 214 elements
 *    across 37 pages is ONE finding with 214 occurrences — never 214 findings.
 */

import type {
  Category,
  ConfidenceLevel,
  EffortLevel,
  FindingStatus,
  Severity,
} from './common.js';

/** A pointer to a stored artifact (screenshot, HAR fragment, DOM snippet). */
export interface EvidenceArtifact {
  kind: 'SCREENSHOT' | 'DOM_SNIPPET' | 'CONSOLE_LOG' | 'NETWORK_REQUEST' | 'HEADERS' | 'METRIC' | 'TRACE';
  /** Storage key resolvable through the evidence storage driver. */
  storageKey: string | null;
  /** Small payloads are inlined rather than stored, to keep the report portable. */
  inline: unknown | null;
  caption: string;
  capturedAt: string;
}

/**
 * One place a finding was observed. A finding has 1..N occurrences.
 */
export interface FindingOccurrence {
  pageUrl: string;
  /** CSS selector for the offending element, when the finding is element-scoped. */
  selector: string | null;
  /** Trimmed outerHTML of the element, capped in length. */
  domSnippet: string | null;
  /** Free-form per-occurrence detail, e.g. the specific failing URL. */
  detail: string | null;
  artifacts: EvidenceArtifact[];
  observedAt: string;
}

/**
 * The numbers a finding was derived from. Rendered in the report as a
 * "how do we know" block, so the reader can check our arithmetic.
 */
export interface MeasuredFact {
  label: string;
  value: string | number;
  unit?: string;
  /** Where the number came from, e.g. `PerformanceObserver`, `CDP Network.responseReceived`. */
  source: string;
}

export interface FindingReproduction {
  steps: string[];
  /** Deterministic replay hint — device, network, viewport used when observed. */
  environment: string;
}

/**
 * The AI enrichment envelope. Kept as a distinct object so the UI can always
 * show which parts of a finding were machine-reasoned vs rule-derived, and so
 * a report can be regenerated with AI disabled.
 */
export interface AiEnrichment {
  provider: string;
  model: string;
  /** Plain-language explanation of what happened. */
  whatHappened: string;
  /** Why this matters to a real user. */
  userImpact: string;
  /** Why this matters to the business. */
  businessImpact: string;
  /** Most probable cause, phrased as a hypothesis when uncertain. */
  likelyRootCause: string;
  /** Concrete engineering action. */
  recommendation: string;
  estimatedEffort: EffortLevel;
  /** The model's own confidence, clamped against the rule's confidence. */
  confidence: ConfidenceLevel;
  /**
   * Set when the model believed the rule mis-scored severity. The pipeline
   * applies this only within a one-step adjustment — see `scoring/severity.ts`.
   */
  suggestedSeverity: Severity | null;
  /** Free-form caveats the model wants surfaced. */
  caveats: string[];
  generatedAt: string;
  /** Token accounting, for cost dashboards. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface Finding {
  id: string;
  auditId: string;
  /** Stable hash grouping identical issues across pages. */
  fingerprint: string;
  /** The rule that produced this finding, e.g. `network.broken-image`. */
  ruleId: string;

  title: string;
  category: Category;
  severity: Severity;
  confidence: ConfidenceLevel;
  /** 0..1 numeric confidence, shown as a percentage in the report. */
  confidenceScore: number;
  status: FindingStatus;

  /** One-sentence statement of the defect. */
  description: string;
  /** Facts, never speculation. Rendered under "How do we know". */
  measuredFacts: MeasuredFact[];
  /** Our reasoning from facts to problem. Rule-authored, AI may expand. */
  inference: string;
  /** Deeper technical context for the engineer who will fix it. */
  technicalDetails: string;
  /** Impact on users, in plain language. */
  impact: string;
  recommendation: string;
  estimatedEffort: EffortLevel;
  reproduction: FindingReproduction | null;
  /** WCAG criterion, CWE, or spec reference where one applies. */
  standardsRef: string | null;

  occurrences: FindingOccurrence[];
  /** Denormalized counts so the dashboard never has to load occurrences. */
  affectedPageCount: number;
  affectedElementCount: number;

  /** Fingerprints of findings that likely share a root cause. */
  relatedFingerprints: string[];

  ai: AiEnrichment | null;

  /**
   * Composite ranking score. Higher means "fix this sooner".
   * Computed by `scoring/priority.ts` from severity, confidence, reach, effort.
   */
  priorityScore: number;

  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a rule emits. The pipeline fills in ids, scores, and timestamps —
 * rules stay small and testable by only describing the defect.
 */
export interface RawFinding {
  ruleId: string;
  fingerprint: string;
  title: string;
  category: Category;
  severity: Severity;
  confidence: ConfidenceLevel;
  description: string;
  measuredFacts: MeasuredFact[];
  inference: string;
  technicalDetails: string;
  impact: string;
  recommendation: string;
  estimatedEffort: EffortLevel;
  reproduction?: FindingReproduction | null;
  standardsRef?: string | null;
  occurrences: FindingOccurrence[];
  relatedFingerprints?: string[];
  /**
   * Opt out of AI enrichment for noisy, self-explanatory findings
   * (e.g. "missing favicon") so we do not spend tokens on them.
   */
  skipAiEnrichment?: boolean;
}
