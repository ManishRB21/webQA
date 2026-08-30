/**
 * The report — the assembled, presentation-ready view of an audit.
 *
 * This is a denormalized snapshot, generated once when the audit completes and
 * stored. Regenerating it from findings on every page load would be wasteful
 * and would let a report silently change after it was shared.
 */

import type { AuditRecord, AuditPageRecord, HealthScores } from './audit.js';
import type { Category, Severity } from './common.js';
import type { Finding } from './finding.js';

export interface ReportSection {
  category: Category;
  score: number;
  /** Two or three sentences summarizing this category's state. */
  narrative: string;
  /** Category-specific headline metrics for the overview cards. */
  highlights: Array<{ label: string; value: string; band?: 'good' | 'fair' | 'poor' }>;
  findingFingerprints: string[];
}

export interface PerformanceSummary {
  /** Median across probed pages. Medians, not means — one slow page skews a mean. */
  medianLcpMs: number | null;
  medianFcpMs: number | null;
  medianTtfbMs: number | null;
  medianCls: number | null;
  medianTbtMs: number | null;
  medianInpMs: number | null;
  /** Aggregate payload composition for the waterfall/treemap views. */
  payload: {
    totalBytes: number;
    byKind: Record<string, number>;
    thirdPartyBytes: number;
    requestCount: number;
    thirdPartyRequestCount: number;
  };
  /** Slowest pages by LCP, for the "top problematic pages" panel. */
  slowestPages: Array<{ url: string; lcpMs: number | null; totalBytes: number }>;
  renderBlockingResources: Array<{ url: string; kind: string; bytes: number | null }>;
  unusedBytes: { javascript: number; css: number };
}

export interface AccessibilitySummary {
  totalViolations: number;
  byImpact: Record<string, number>;
  /** Distinct axe rules violated, most frequent first. */
  topRules: Array<{ ruleId: string; help: string; nodeCount: number; pageCount: number }>;
  wcagCriteriaAffected: string[];
}

export interface SeoSummary {
  pagesMissingTitle: number;
  pagesMissingDescription: number;
  duplicateTitles: Array<{ title: string; urls: string[] }>;
  duplicateDescriptions: Array<{ description: string; urls: string[] }>;
  pagesMissingCanonical: number;
  brokenInternalLinks: number;
  imagesMissingAlt: number;
  hasSitemap: boolean;
  hasRobotsTxt: boolean;
  indexabilityIssues: Array<{ url: string; reason: string }>;
}

export interface SecuritySummary {
  httpsEnforced: boolean;
  headers: Array<{
    name: string;
    present: boolean;
    value: string | null;
    assessment: 'good' | 'weak' | 'missing';
    note: string;
  }>;
  mixedContentCount: number;
  insecureCookieCount: number;
  thirdPartyOrigins: string[];
  /** Set true when the user enabled and attested to active scanning. */
  activeScanPerformed: boolean;
}

export interface FunctionalSummary {
  interactionsTested: number;
  interactionsFailed: number;
  brokenLinks: number;
  brokenResources: { images: number; scripts: number; stylesheets: number; fonts: number };
  jsExceptionCount: number;
  failedApiCalls: Array<{ url: string; status: number | null; pageUrl: string; method: string }>;
}

export interface ReportDocument {
  audit: AuditRecord;
  scores: HealthScores;
  /** Generated last, after all findings exist. Explicitly labelled as AI-written. */
  executiveSummary: {
    text: string;
    generatedBy: 'AI' | 'TEMPLATE';
    topRisks: string[];
    quickWins: string[];
  };
  findings: Finding[];
  /** Findings grouped by severity, in priority order within each bucket. */
  findingsBySeverity: Record<Severity, string[]>;
  sections: ReportSection[];
  performance: PerformanceSummary;
  accessibility: AccessibilitySummary;
  seo: SeoSummary;
  security: SecuritySummary;
  functional: FunctionalSummary;
  pages: AuditPageRecord[];
  generatedAt: string;
  /** Bumped when the report format changes, so stored reports stay renderable. */
  schemaVersion: number;
}

export const REPORT_SCHEMA_VERSION = 1;

// ── Comparison / regression ────────────────────────────────────────────────

export interface MetricDelta {
  label: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  /** True when the change is a regression (worse), given the metric's direction. */
  isRegression: boolean;
  unit: string;
}

export interface AuditComparison {
  baselineAuditId: string;
  currentAuditId: string;
  scoreDeltas: {
    overall: MetricDelta;
    categories: Record<Category, MetricDelta>;
  };
  metricDeltas: MetricDelta[];
  /** Fingerprints present now but not in the baseline. */
  newFindings: string[];
  /** Fingerprints present in the baseline but gone now. */
  resolvedFindings: string[];
  /** Present in both, but with a worse severity or wider reach now. */
  worsenedFindings: string[];
  generatedAt: string;
}
