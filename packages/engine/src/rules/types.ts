/**
 * Rule contracts.
 *
 * A rule is a pure function from observations to findings. That purity is the
 * point: rules are the system's judgement, so they must be testable without a
 * browser, a network, or an LLM. Give one a fixture and it returns findings.
 *
 * Two scopes:
 *   - PageRule  runs once per crawled page. Use for anything page-local.
 *   - SiteRule  runs once with every page. Use for anything requiring
 *               cross-page knowledge (duplicate titles, site-wide headers).
 */

import type {
  PageObservations,
  RawFinding,
  ResolvedAuditConfig,
  SiteObservations,
} from '@webqa/shared';

export interface RuleContext {
  config: ResolvedAuditConfig;
  site: SiteObservations;
  /** Total pages crawled, needed to express reach as a share of the site. */
  totalPages: number;
}

export interface PageRuleContext extends RuleContext {
  page: PageObservations;
}

export interface SiteRuleContext extends RuleContext {
  pages: PageObservations[];
}

export interface PageRule {
  id: string;
  description: string;
  run(context: PageRuleContext): RawFinding[];
}

export interface SiteRule {
  id: string;
  description: string;
  run(context: SiteRuleContext): RawFinding[];
}

/** Convenience for building an occurrence with the boilerplate filled in. */
export function occurrence(input: {
  pageUrl: string;
  selector?: string | null;
  domSnippet?: string | null;
  detail?: string | null;
  screenshotKey?: string | null;
  inlineEvidence?: { kind: 'CONSOLE_LOG' | 'NETWORK_REQUEST' | 'HEADERS' | 'METRIC'; caption: string; data: unknown } | null;
}): RawFinding['occurrences'][number] {
  const artifacts: RawFinding['occurrences'][number]['artifacts'] = [];
  const capturedAt = new Date().toISOString();

  if (input.screenshotKey) {
    artifacts.push({
      kind: 'SCREENSHOT',
      storageKey: input.screenshotKey,
      inline: null,
      caption: 'Screenshot captured at the moment of failure',
      capturedAt,
    });
  }

  if (input.inlineEvidence) {
    artifacts.push({
      kind: input.inlineEvidence.kind,
      storageKey: null,
      inline: input.inlineEvidence.data,
      caption: input.inlineEvidence.caption,
      capturedAt,
    });
  }

  return {
    pageUrl: input.pageUrl,
    selector: input.selector ?? null,
    domSnippet: input.domSnippet ?? null,
    detail: input.detail ?? null,
    artifacts,
    observedAt: capturedAt,
  };
}

/** Format a byte count for human-readable evidence lines. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Format milliseconds for human-readable evidence lines. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
