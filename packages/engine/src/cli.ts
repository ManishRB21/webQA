#!/usr/bin/env node
/**
 * webQA command-line interface.
 *
 *   npx webqa https://example.com
 *   npx webqa https://example.com --pages 50 --depth 3 --device mobile
 *
 * Writes `report.html` (self-contained) and `audit.json` (full evidence) into
 * the output directory, then prints the path.
 */

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditConfigSchema, type ResolvedAuditConfig } from '@webqa/shared';
import { loadEngineConfig, type EngineConfig } from './config.js';
import { describeCredential, resolveAnthropicCredential } from './ai/credentials.js';
import { Reporter } from './logger.js';
import { runAudit } from './pipeline.js';
import { EvidenceStore } from './store/evidence.js';
import { renderHtmlReport } from './report/html.js';

interface ParsedArgs {
  url: string | null;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let url: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
      const key = rawKey ?? '';
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else {
        const next = argv[index + 1];
        // Treat `--flag value` as a pair, `--flag` alone as a boolean.
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          index += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (!url) {
      url = arg;
    }
  }

  return { url, flags };
}

const HELP = `
webQA — automated black-box website audit

USAGE
  webqa <url> [options]

OPTIONS
  --pages <n>          Max pages to crawl            (default 25)
  --depth <n>          Max crawl depth               (default 2)
  --device <profile>   desktop | mobile              (default desktop)
  --network <profile>  fast | fast-4g | slow-4g      (default fast)
  --out <dir>          Output directory              (default ./webqa-results)

  --no-interactions    Skip functional click testing
  --no-ai              Skip AI enrichment (deterministic findings only)
  --no-external-links  Do not verify external links
  --no-robots          Ignore robots.txt disallow rules
  --subdomains         Follow links to subdomains
  --include <path>     Only crawl paths with this prefix (repeatable via comma)
  --exclude <path>     Never crawl paths with this prefix (repeatable via comma)

  --quiet              Only print the final summary
  --json               Print the result as JSON to stdout
  --auth               Show which Claude credential would be used, then exit
  --help               Show this message

AUTHENTICATION
  AI analysis reuses whatever Claude credentials this machine already has,
  checked in this order:
    1. ANTHROPIC_API_KEY
    2. ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN
    3. ant auth login profile   (via "ant auth print-credentials")
    4. Claude Code IDE / CLI login  (~/.claude/.credentials.json)
  Run "webqa --auth" to see which one is active.

ENVIRONMENT
  AI_MODEL             Model id (default claude-opus-5)
  AI_PROVIDER          anthropic | none
  SSRF_PROTECTION      Set to "false" only when auditing a trusted internal host

EXAMPLES
  webqa https://example.com
  webqa https://example.com --pages 50 --depth 3 --device mobile
  webqa https://shop.example.com --include /products --pages 100
`;

function fail(message: string): never {
  process.stderr.write(`\x1b[31mError:\x1b[0m ${message}\n`);
  process.exit(1);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { url, flags } = parseArgs(argv);

  if (flags.help || flags.h || (!url && argv.length === 0 && flags.auth !== true)) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (flags.auth === true) {
    printAuthStatus();
    process.exit(0);
  }

  if (!url) fail('No URL provided. Run `webqa --help` for usage.');

  // Accept `example.com` as well as a full URL — a bare host is what people type.
  const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  const deviceFlag = String(flags.device ?? 'desktop').toUpperCase();
  const networkFlag = String(flags.network ?? 'fast').toUpperCase().replace(/-/g, '_');

  const parsed = auditConfigSchema.safeParse({
    url: normalizedUrl,
    maxPages: flags.pages ? Number(flags.pages) : 25,
    maxDepth: flags.depth !== undefined ? Number(flags.depth) : 2,
    device: deviceFlag === 'MOBILE' ? 'MOBILE' : 'DESKTOP',
    network: ['FAST', 'FAST_4G', 'SLOW_4G'].includes(networkFlag) ? networkFlag : 'FAST',
    browser: 'CHROMIUM',
    respectRobots: flags['no-robots'] !== true,
    includeSubdomains: flags.subdomains === true,
    interactionTesting: flags['no-interactions'] !== true,
    lighthouse: false,
    aiAnalysis: flags['no-ai'] !== true,
    checkExternalLinks: flags['no-external-links'] !== true,
    activeSecurityScan: false,
    authorizationAttestation: null,
    includePaths: typeof flags.include === 'string' ? flags.include.split(',').map((s) => s.trim()).filter(Boolean) : [],
    excludePaths: typeof flags.exclude === 'string' ? flags.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [],
    label: null,
  });

  if (!parsed.success) {
    fail(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
  }

  const overrides: Partial<EngineConfig> = {};
  // --out is relative to where the user typed the command, not to npm's cwd.
  if (typeof flags.out === 'string') {
    overrides.outputDir = isAbsolute(flags.out)
      ? flags.out
      : resolve(process.env.INIT_CWD ?? process.cwd(), flags.out);
  }
  if (flags.quiet === true) overrides.verbose = false;

  const engine = loadEngineConfig(overrides);
  const reporter = new Reporter({
    verbose: flags.quiet !== true,
    colour: process.stderr.isTTY === true && !process.env.NO_COLOR,
  });

  reporter.info(`webQA — auditing ${normalizedUrl}`);

  // Always say which credential is in play. Silently falling back to a
  // deterministic report — or silently spending someone's subscription — are
  // both bad surprises.
  if (parsed.data.aiAnalysis) {
    const credential = engine.ai.credential;
    if (engine.ai.enabled) {
      reporter.success(`AI analysis enabled via ${describeCredential(credential)} · model ${engine.ai.model}`);
    } else if (credential.expired) {
      reporter.warn(
        `Found a Claude credential but it has expired (${credential.description}). Refresh your Claude login, or set ANTHROPIC_API_KEY. Continuing with deterministic analysis only.`,
      );
    } else {
      reporter.warn(
        'No Anthropic credentials found — continuing with deterministic analysis only. ' +
          'Sign in to Claude Code, run `ant auth login`, or set ANTHROPIC_API_KEY to enable AI root-cause analysis.',
      );
    }
  }

  const result = await runAudit({
    url: normalizedUrl,
    config: parsed.data as ResolvedAuditConfig,
    engine,
    reporter,
  });

  // ── write outputs ─────────────────────────────────────────────────────────
  const evidence = new EvidenceStore(engine.outputDir);
  const html = await renderHtmlReport({ result, evidence });

  const htmlPath = await evidence.writeText(result.auditId, 'report.html', html);
  const jsonPath = await evidence.writeJson(result.auditId, 'audit.json', {
    auditId: result.auditId,
    url: result.url,
    status: result.status,
    config: result.config,
    scores: result.scores,
    summary: result.summary,
    stats: result.stats,
    findings: result.findings,
    pages: result.pages,
    site: { ...result.site, linkChecks: result.site.linkChecks.slice(0, 500) },
    ruleErrors: result.ruleErrors,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  });

  // Full observations separately: it is large and most consumers never need it.
  await evidence.writeJson(result.auditId, 'observations.json', result.observations);

  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ auditId: result.auditId, status: result.status, scores: result.scores, stats: result.stats, reportPath: htmlPath }, null, 2)}\n`,
    );
  }

  printSummary(result, htmlPath, jsonPath);
  process.exit(result.status === 'FAILED' ? 1 : 0);
}

/**
 * `webqa --auth` — report which credential would be used, without running an
 * audit. Prints the source and expiry only; the token itself is never shown.
 */
function printAuthStatus(): void {
  const credential = resolveAnthropicCredential();
  const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
  const dim = (text: string): string => `\x1b[90m${text}\x1b[0m`;

  const lines: string[] = ['', bold('  Claude credential resolution'), ''];

  if (credential.source === 'none') {
    lines.push(
      `  ${'\x1b[31m'}✗\x1b[0m  No credentials found.`,
      '',
      '  Any one of these will enable AI analysis:',
      dim('    • Sign in to Claude Code (the IDE extension or `claude` CLI)'),
      dim('    • Run `ant auth login`'),
      dim('    • export ANTHROPIC_API_KEY=sk-ant-...'),
      '',
      '  Without one, audits still run and produce a full report — findings and',
      '  prose are generated from the rule engine instead of a model.',
      '',
    );
  } else {
    const status = credential.expired ? `${'\x1b[31m'}✗ expired\x1b[0m` : `${'\x1b[32m'}✓ valid\x1b[0m`;
    lines.push(
      `  ${status}`,
      '',
      `  ${bold('Source')}     ${credential.source}`,
      `  ${bold('Detail')}     ${credential.description}`,
      `  ${bold('Auth mode')}  ${credential.mode === 'oauth' ? 'Authorization: Bearer (+ oauth beta header)' : 'x-api-key'}`,
    );
    if (credential.expiresAt !== null) {
      lines.push(`  ${bold('Expires')}    ${new Date(credential.expiresAt).toLocaleString()}`);
    }
    lines.push(
      '',
      dim(`  Model: ${process.env.AI_MODEL ?? 'claude-opus-5'}`),
      credential.expired
        ? '\n  \x1b[33mRefresh your Claude login before running an audit with AI analysis.\x1b[0m'
        : '',
      '',
    );
  }

  process.stdout.write(lines.filter((line) => line !== '').join('\n') + '\n');
}

function printSummary(
  result: Awaited<ReturnType<typeof runAudit>>,
  htmlPath: string,
  jsonPath: string,
): void {
  const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
  const dim = (text: string): string => `\x1b[90m${text}\x1b[0m`;
  const colour = (score: number): string =>
    score >= 85 ? '\x1b[32m' : score >= 60 ? '\x1b[33m' : '\x1b[31m';

  const lines: string[] = [
    '',
    bold('  ── Audit complete ' + '─'.repeat(48)),
    '',
    `  ${bold('Overall health')}   ${colour(result.scores.overall)}${result.scores.overall}\x1b[0m / 100`,
    '',
  ];

  for (const [category, score] of Object.entries(result.scores.categories)) {
    const label = category.replace('_', '/').padEnd(16);
    const filled = Math.round(score / 5);
    const bar = '█'.repeat(filled) + dim('░'.repeat(20 - filled));
    lines.push(`  ${dim(label)} ${colour(score)}${bar}\x1b[0m ${String(score).padStart(3)}`);
  }

  const histogram = result.stats.findingsBySeverity;
  lines.push(
    '',
    `  ${bold('Findings')}         ${result.findings.length} distinct issue(s)`,
    `                   \x1b[31m${histogram.CRITICAL ?? 0} critical\x1b[0m · \x1b[31m${histogram.HIGH ?? 0} high\x1b[0m · \x1b[33m${histogram.MEDIUM ?? 0} medium\x1b[0m · ${histogram.LOW ?? 0} low · ${histogram.INFO ?? 0} info`,
    '',
    `  ${bold('Crawled')}          ${result.stats.pagesCrawled} page(s) in ${Math.round(result.stats.durationMs / 1000)}s`,
    `  ${bold('Interactions')}     ${result.stats.interactionsTested} control(s) tested`,
    `  ${bold('Links checked')}    ${result.stats.linksChecked} (${result.stats.brokenLinks} broken)`,
    '',
  );

  const top = result.findings.slice(0, 5);
  if (top.length > 0) {
    lines.push(`  ${bold('Top priorities')}`);
    for (const [index, finding] of top.entries()) {
      const severityColour =
        finding.severity === 'CRITICAL' || finding.severity === 'HIGH' ? '\x1b[31m'
        : finding.severity === 'MEDIUM' ? '\x1b[33m' : '\x1b[90m';
      lines.push(
        `    ${index + 1}. ${severityColour}${finding.severity.padEnd(8)}\x1b[0m ${finding.title}`,
        `       ${dim(`${finding.affectedPageCount} page(s) · ${finding.confidence.toLowerCase()} · ${finding.estimatedEffort.toLowerCase()} fix`)}`,
      );
    }
    lines.push('');
  }

  lines.push(
    `  ${bold('Report')}           ${htmlPath}`,
    `  ${dim('Data')}             ${jsonPath}`,
    '',
    dim(`  Open the report:  start "" "${htmlPath}"   (Windows)`),
    dim(`                    open "${htmlPath}"        (macOS)`),
    '',
  );

  process.stderr.write(lines.join('\n'));
}

// Run when invoked directly (not when imported).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`\x1b[31mFatal:\x1b[0m ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
