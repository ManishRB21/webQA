/**
 * @webqa/engine — programmatic API.
 *
 * The CLI is a thin wrapper over `runAudit` + `renderHtmlReport`; anything the
 * CLI can do is available here for embedding in a server, a CI step, or a
 * scheduled job.
 */

export { runAudit, type AuditResult, type RunAuditInput } from './pipeline.js';
export { renderHtmlReport, type RenderOptions } from './report/html.js';
export { loadEngineConfig, clampAuditConfig, type EngineConfig } from './config.js';
export { Reporter, silentReporter, type ProgressEvent, type ProgressListener } from './logger.js';
export { EvidenceStore } from './store/evidence.js';

export { runRules, PAGE_RULES, SITE_RULES, type PageRule, type SiteRule } from './rules/index.js';
export { aggregate, dedupeFindings, correlateFindings, severityHistogram } from './analysis/aggregate.js';

export { AnthropicProvider } from './ai/anthropic.js';
export { NullProvider, type LlmProvider, type StructuredRequest, type StructuredResponse } from './ai/provider.js';
export { resolveAnthropicCredential, describeCredential, type ResolvedCredential, type CredentialSource } from './ai/credentials.js';
export { enrichFindings, generateExecutiveSummary, templateSummary } from './ai/enrich.js';

export { Frontier, scoreUrl } from './crawl/frontier.js';
export { preflight, fetchRobots, fetchSitemap, safeFetch, parseRobots } from './crawl/discovery.js';
export { probePage } from './probes/page-probe.js';
export { selectCandidates } from './probes/interactions.js';
export { checkLinks, buildLinkTargets, isBroken } from './probes/link-checker.js';
