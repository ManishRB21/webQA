/**
 * The audit pipeline.
 *
 * Preflight → discovery → crawl+probe → link check → rules → aggregate →
 * AI enrichment → report.
 *
 * Two properties are load-bearing:
 *
 *   Always produce a report. Every stage after the crawl is wrapped so that a
 *   failure degrades the report rather than losing it. An audit that dies at
 *   the AI step having thrown away 40 pages of evidence is worthless.
 *
 *   Respect the budget. Both a per-page and a whole-audit wall clock are
 *   enforced. When time runs out the pipeline stops cleanly and reports what it
 *   has, saying so — it does not run until something kills it.
 */

import { randomUUID } from 'node:crypto';
import {
  normalizeUrl,
  type AuditPhase,
  type AuditStats,
  type Finding,
  type PageObservations,
  type ResolvedAuditConfig,
  type SiteObservations,
} from '@webqa/shared';
import { clampAuditConfig, type EngineConfig } from './config.js';
import { Reporter } from './logger.js';
import { BrowserSession } from './browser/session.js';
import { EvidenceStore } from './store/evidence.js';
import { Frontier } from './crawl/frontier.js';
import { fetchRobots, fetchSitemap, preflight } from './crawl/discovery.js';
import { probePage } from './probes/page-probe.js';
import { buildLinkTargets, checkLinks } from './probes/link-checker.js';
import { runRules } from './rules/index.js';
import { aggregate, severityHistogram } from './analysis/aggregate.js';
import { AnthropicProvider } from './ai/anthropic.js';
import { NullProvider, type LlmProvider } from './ai/provider.js';
import {
  enrichFindings,
  generateExecutiveSummary,
  templateSummary,
  type SummaryResult,
} from './ai/enrich.js';

export interface AuditResult {
  auditId: string;
  url: string;
  origin: string;
  config: ResolvedAuditConfig;
  status: 'COMPLETED' | 'FAILED' | 'PARTIAL';
  error: string | null;
  findings: Finding[];
  scores: import('@webqa/shared').HealthScores;
  summary: SummaryResult;
  pages: Array<{
    url: string;
    depth: number;
    httpStatus: number | null;
    title: string | null;
    healthScore: number;
    findingCount: number;
    severityCounts: Record<string, number>;
    loadTimeMs: number | null;
    bytesTransferred: number;
    screenshotKey: string | null;
    probeError: string | null;
  }>;
  observations: PageObservations[];
  site: SiteObservations;
  stats: AuditStats;
  aiCalls: Array<{ purpose: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number; error: string | null }>;
  ruleErrors: Array<{ ruleId: string; pageUrl: string | null; message: string }>;
  startedAt: string;
  finishedAt: string;
  activityLog: ReturnType<Reporter['history']>;
}

export interface RunAuditInput {
  url: string;
  config: ResolvedAuditConfig;
  engine: EngineConfig;
  reporter: Reporter;
  auditId?: string;
}

export async function runAudit(input: RunAuditInput): Promise<AuditResult> {
  const auditId = input.auditId ?? randomUUID().replace(/-/g, '').slice(0, 20);
  const startedAt = new Date();
  const { reporter, engine } = input;
  const config = clampAuditConfig(input.config, engine.limits);

  const evidence = new EvidenceStore(engine.outputDir);
  await evidence.init(auditId);

  const deadline = startedAt.getTime() + engine.limits.auditBudgetMs;
  const observations: PageObservations[] = [];
  let status: AuditResult['status'] = 'COMPLETED';
  let fatalError: string | null = null;

  const site: SiteObservations = {
    seedUrl: input.url,
    origin: safeOrigin(input.url),
    robots: null,
    sitemap: null,
    linkChecks: [],
    skipped: [],
  };

  const session = new BrowserSession(engine);
  const aiCalls: AuditResult['aiCalls'] = [];

  try {
    // ── 1. Preflight ────────────────────────────────────────────────────────
    setPhase(reporter, 'PREFLIGHT', 'Checking that the target is reachable');
    const flight = await preflight(input.url, {
      ssrf: engine.ssrf,
      userAgent: engine.userAgent,
      reporter,
    });

    if (!flight.reachable) {
      throw new Error(flight.error ?? 'Target is not reachable');
    }

    // Follow the seed URL's own redirect before crawling, so a site that
    // redirects http→https or apex→www is audited at its real address.
    const seedUrl = flight.finalUrl;
    site.seedUrl = seedUrl;
    site.origin = safeOrigin(seedUrl);

    // ── 2. Discovery ────────────────────────────────────────────────────────
    setPhase(reporter, 'DISCOVERY', 'Looking for robots.txt and sitemap.xml');
    site.robots = await fetchRobots(site.origin, {
      ssrf: engine.ssrf,
      userAgent: engine.userAgent,
      reporter,
    });
    site.sitemap = await fetchSitemap(site.origin, site.robots?.sitemapUrls ?? [], {
      ssrf: engine.ssrf,
      userAgent: engine.userAgent,
      reporter,
      maxUrls: config.maxPages * 3,
    });

    // ── 3. Crawl + probe ────────────────────────────────────────────────────
    setPhase(reporter, 'CRAWL', `Crawling up to ${config.maxPages} page(s), depth ${config.maxDepth}`);

    const frontier = new Frontier({
      seedUrl,
      maxDepth: config.maxDepth,
      includeSubdomains: config.includeSubdomains,
      includePaths: config.includePaths,
      excludePaths: config.excludePaths,
      disallowedPaths: site.robots?.disallowedPaths ?? [],
      respectRobots: config.respectRobots,
    });

    frontier.add(seedUrl, 0, null);

    // Seed from the sitemap — a curated list beats link-following.
    if (site.sitemap?.found) {
      let seeded = 0;
      for (const url of site.sitemap.sampleUrls) {
        if (seeded >= config.maxPages * 2) break;
        if (frontier.add(url, 1, site.sitemap.url)) seeded += 1;
      }
      if (seeded > 0) reporter.info(`Seeded ${seeded} URL(s) from the sitemap`);
    }

    await session.start();
    reporter.success('Browser launched');

    let crawled = 0;
    let failedPages = 0;

    while (crawled < config.maxPages) {
      if (Date.now() > deadline) {
        reporter.warn('Audit time budget reached — stopping the crawl and reporting what we have');
        status = 'PARTIAL';
        break;
      }

      const entry = frontier.next();
      if (!entry) break;

      reporter.info(`Crawling ${shortenUrl(entry.url)}`, { depth: entry.depth });

      const pageObservations = await probePage(
        {
          url: entry.url,
          depth: entry.depth,
          discoveredFrom: entry.discoveredFrom,
          device: config.device,
          network: config.network,
          interactionTesting: config.interactionTesting,
        },
        { session, config: engine, reporter, evidence, auditId },
      );

      observations.push(pageObservations);
      crawled += 1;
      if (pageObservations.probeError) failedPages += 1;

      // Feed newly-discovered internal links back into the frontier.
      let discovered = 0;
      for (const link of pageObservations.links) {
        if (!link.absoluteUrl || link.isEmptyTarget || !link.isInternal) continue;
        if (frontier.add(link.absoluteUrl, entry.depth + 1, entry.url)) discovered += 1;
      }

      const issues =
        pageObservations.pageErrors.length +
        pageObservations.console.filter((message) => message.level === 'error').length;

      reporter.debug(
        `  ${pageObservations.navigation?.status ?? '—'} · ${discovered} new link(s) · ${pageObservations.requests.length} request(s)` +
          (issues > 0 ? ` · ${issues} console error(s)` : '') +
          (pageObservations.interactions.length > 0 ? ` · ${pageObservations.interactions.length} interaction(s) tested` : ''),
      );

      // Politeness: we are generating traffic on someone else's server.
      if (engine.limits.crawlDelayMs > 0 && frontier.pending > 0) {
        await sleep(engine.limits.crawlDelayMs);
      }
    }

    site.skipped = frontier.skippedUrls().slice(0, 200);
    reporter.success(
      `Crawl complete — ${crawled} page(s) probed, ${frontier.discovered} URL(s) discovered, ${failedPages} failed`,
    );

    // ── 4. Link verification ────────────────────────────────────────────────
    if (Date.now() < deadline) {
      setPhase(reporter, 'LINK_CHECK', 'Verifying links and resources');
      const visited = new Set(observations.map((page) => normalizeUrl(page.url) ?? page.url));
      const targets = buildLinkTargets({
        pages: observations.map((page) => ({ url: page.url, links: page.links })),
        alreadyVisited: visited,
        includeExternal: config.checkExternalLinks,
        seedOrigin: site.origin,
      });

      site.linkChecks = await checkLinks({
        targets,
        seedOrigin: site.origin,
        ssrf: engine.ssrf,
        userAgent: engine.userAgent,
        reporter,
        maxChecks: engine.limits.maxLinkChecks,
      });
    } else {
      reporter.warn('Skipping link verification — time budget exhausted');
      status = 'PARTIAL';
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    status = observations.length > 0 ? 'PARTIAL' : 'FAILED';
    reporter.error(`Audit failed: ${fatalError}`);
  } finally {
    await session.close();
  }

  // ── 5. Rules ──────────────────────────────────────────────────────────────
  setPhase(reporter, 'ANALYSIS', 'Running the rule engine over collected evidence');
  const ruleResult = runRules({ pages: observations, site, config });
  if (ruleResult.errors.length > 0) {
    reporter.warn(`${ruleResult.errors.length} rule(s) errored and were skipped`);
  }
  reporter.success(`${ruleResult.findings.length} raw finding(s) produced by ${observations.length} page(s) of evidence`);

  // ── 6. Aggregate ──────────────────────────────────────────────────────────
  const { findings, scores, pageScores } = aggregate(
    ruleResult.findings,
    auditId,
    Math.max(1, observations.length),
  );
  const histogram = severityHistogram(findings);
  reporter.success(
    `Deduplicated to ${findings.length} distinct finding(s) — ` +
      `${histogram.CRITICAL} critical, ${histogram.HIGH} high, ${histogram.MEDIUM} medium, ${histogram.LOW} low`,
  );

  // ── 7. AI enrichment ──────────────────────────────────────────────────────
  const provider = createProvider(engine);
  let summary: SummaryResult;

  if (config.aiAnalysis && provider.name !== 'none') {
    setPhase(reporter, 'AI_ANALYSIS', `AI root-cause analysis via ${provider.name} (${provider.model})`);
    try {
      await enrichFindings({
        provider,
        findings,
        siteUrl: site.seedUrl,
        batchSize: engine.ai.batchSize,
        maxRequests: engine.ai.maxRequests,
        reporter,
        onCall: (record) => aiCalls.push({ ...record }),
      });
    } catch (error) {
      // Enrichment is strictly additive; failing it must not fail the audit.
      reporter.warn(`AI enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    summary = await generateExecutiveSummary({
      provider,
      findings,
      scores,
      siteUrl: site.seedUrl,
      pagesCrawled: observations.length,
      reporter,
      onCall: (record) => aiCalls.push({ ...record }),
    }).catch(() => templateSummary(findings, scores, observations.length));
  } else {
    if (config.aiAnalysis && !engine.ai.credential.value) {
      reporter.warn('AI analysis requested but no API key is configured — continuing with deterministic analysis only');
    }
    summary = templateSummary(findings, scores, observations.length);
  }

  // ── 8. Assemble ───────────────────────────────────────────────────────────
  setPhase(reporter, 'REPORT', 'Generating report');
  const finishedAt = new Date();

  const pages = observations.map((page) => {
    const score = pageScores.get(page.url) ?? { healthScore: 100, findingCount: 0, severityCounts: {} };
    return {
      url: page.url,
      depth: page.depth,
      httpStatus: page.navigation?.status ?? null,
      title: page.meta?.title ?? null,
      healthScore: score.healthScore,
      findingCount: score.findingCount,
      severityCounts: score.severityCounts,
      loadTimeMs: page.navigation?.timing.loadEventMs ?? null,
      bytesTransferred: page.requests.reduce((sum, request) => sum + (request.transferSizeBytes ?? 0), 0),
      screenshotKey: page.screenshots.viewportKey,
      probeError: page.probeError,
    };
  });

  const stats: AuditStats = {
    pagesCrawled: observations.length,
    pagesFailed: observations.filter((page) => page.probeError !== null).length,
    requestsObserved: observations.reduce((sum, page) => sum + page.requests.length, 0),
    bytesTransferred: pages.reduce((sum, page) => sum + page.bytesTransferred, 0),
    consoleErrors: observations.reduce(
      (sum, page) => sum + page.console.filter((message) => message.level === 'error').length + page.pageErrors.length,
      0,
    ),
    interactionsTested: observations.reduce((sum, page) => sum + page.interactions.length, 0),
    linksChecked: site.linkChecks.length,
    brokenLinks: site.linkChecks.filter(
      (check) => check.failureText !== null || (check.status !== null && check.status >= 400),
    ).length,
    findingsTotal: findings.length,
    findingsBySeverity: histogram,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };

  return {
    auditId,
    url: site.seedUrl,
    origin: site.origin,
    config,
    status,
    error: fatalError,
    findings,
    scores,
    summary,
    pages,
    observations,
    site,
    stats,
    aiCalls,
    ruleErrors: ruleResult.errors,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    activityLog: reporter.history(),
  };
}

function createProvider(engine: EngineConfig): LlmProvider {
  if (!engine.ai.enabled || !engine.ai.credential.value) return new NullProvider();
  if (engine.ai.provider === 'anthropic') {
    return new AnthropicProvider({ credential: engine.ai.credential, model: engine.ai.model });
  }
  // OpenAI and other providers plug in here — the interface is all the
  // pipeline knows about.
  return new NullProvider();
}

function setPhase(reporter: Reporter, phase: AuditPhase, message: string): void {
  reporter.setPhase(phase, message);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path.length > 60 ? `${path.slice(0, 57)}...` : path || '/';
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
