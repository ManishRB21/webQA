/**
 * Engine configuration.
 *
 * Everything is resolvable from CLI flags or environment variables, with
 * defaults that produce a useful audit out of the box. The service must run
 * with zero external infrastructure — no database, no queue, no object store.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { DeviceProfile, NetworkProfile, ResolvedAuditConfig } from '@webqa/shared';
import { resolveAnthropicCredential, type ResolvedCredential } from './ai/credentials.js';

export interface EngineConfig {
  /** Where audit JSON and screenshots are written. */
  outputDir: string;
  /** Hard ceilings applied regardless of what was requested. */
  limits: {
    maxPages: number;
    maxDepth: number;
    /** Per-page wall-clock budget across navigation, probes and interactions. */
    pageBudgetMs: number;
    /** Whole-audit budget; the pipeline stops cleanly and reports what it has. */
    auditBudgetMs: number;
    navigationTimeoutMs: number;
    /** Politeness delay between requests to the same origin. */
    crawlDelayMs: number;
    /** Max interactive elements probed per page. */
    maxInteractionsPerPage: number;
    /** Max links verified across the whole audit. */
    maxLinkChecks: number;
  };
  ssrf: {
    enabled: boolean;
    allowlist: string[];
    allowedPorts: number[];
  };
  ai: {
    enabled: boolean;
    provider: 'anthropic' | 'openai' | 'none';
    model: string;
    /**
     * Resolved from the environment, the `ant` CLI, or an existing Claude Code
     * login — see `ai/credentials.ts`. Never requires a hand-pasted API key
     * when the machine already has Claude credentials.
     */
    credential: ResolvedCredential;
    baseUrl: string | null;
    /** Findings sent per enrichment request. */
    batchSize: number;
    /** Cap on enrichment requests, so a noisy site cannot run up a bill. */
    maxRequests: number;
  };
  userAgent: string;
  /** Emit verbose progress to stderr. */
  verbose: boolean;
  concurrency: number;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; webQA-Auditor/0.1; +https://github.com/your-org/webqa)';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function envList(name: string): string[] {
  const raw = process.env[name];
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Resolve a relative output path against the directory the user actually ran
 * the command from.
 *
 * npm sets the working directory to the *workspace package* when running a
 * script, so `npm run audit` from the repo root would otherwise drop results in
 * `packages/engine/webqa-results` — somewhere the user never looked. npm also
 * sets `INIT_CWD` to the original directory precisely so tools can correct for
 * this.
 */
function resolveOutputDir(configured: string): string {
  if (isAbsolute(configured)) return configured;
  return resolvePath(process.env.INIT_CWD ?? process.cwd(), configured);
}

export function loadEngineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const provider = (process.env.AI_PROVIDER ?? 'anthropic') as EngineConfig['ai']['provider'];
  // Resolve once at boot so the CLI can report which credential it found before
  // spending several minutes crawling.
  const credential = provider === 'anthropic' ? resolveAnthropicCredential() : null;

  const base: EngineConfig = {
    outputDir: resolveOutputDir(process.env.WEBQA_OUTPUT_DIR ?? './webqa-results'),
    limits: {
      maxPages: envInt('MAX_PAGES_HARD_LIMIT', 500),
      maxDepth: envInt('MAX_DEPTH_HARD_LIMIT', 5),
      pageBudgetMs: envInt('PAGE_TOTAL_BUDGET_MS', 90_000),
      auditBudgetMs: envInt('AUDIT_TOTAL_BUDGET_MS', 1_800_000),
      navigationTimeoutMs: envInt('PAGE_NAVIGATION_TIMEOUT_MS', 30_000),
      crawlDelayMs: envInt('CRAWL_DELAY_MS', 250),
      maxInteractionsPerPage: envInt('MAX_INTERACTIONS_PER_PAGE', 12),
      maxLinkChecks: envInt('MAX_LINK_CHECKS', 400),
    },
    ssrf: {
      enabled: envBool('SSRF_PROTECTION', true),
      allowlist: envList('SSRF_ALLOWLIST'),
      allowedPorts: [80, 443, 8080, 8443, 3000],
    },
    ai: {
      // Enabled only when a usable credential was actually found — a missing or
      // expired one degrades to a deterministic-only report rather than failing
      // the run several minutes in.
      enabled:
        envBool('AI_ENABLED', true) &&
        provider !== 'none' &&
        Boolean(credential?.value) &&
        credential?.expired !== true,
      provider,
      model: process.env.AI_MODEL ?? 'claude-opus-5',
      credential: credential ?? {
        mode: 'api-key',
        value: null,
        source: 'none',
        expiresAt: null,
        expired: false,
        description: 'no Anthropic credentials found',
      },
      baseUrl: process.env.OPENAI_BASE_URL ?? null,
      batchSize: envInt('AI_MAX_FINDINGS_PER_BATCH', 12),
      maxRequests: envInt('AI_MAX_REQUESTS', 8),
    },
    userAgent: process.env.USER_AGENT ?? DEFAULT_USER_AGENT,
    verbose: envBool('WEBQA_VERBOSE', true),
    concurrency: envInt('WEBQA_CONCURRENCY', 3),
  };

  return {
    ...base,
    ...overrides,
    limits: { ...base.limits, ...overrides.limits },
    ssrf: { ...base.ssrf, ...overrides.ssrf },
    ai: { ...base.ai, ...overrides.ai },
  };
}

/** Viewport and UA string per device profile. */
export const DEVICE_SETTINGS: Record<
  DeviceProfile,
  { width: number; height: number; deviceScaleFactor: number; isMobile: boolean; userAgent?: string }
> = {
  DESKTOP: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
  MOBILE: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

/**
 * Network throttling profiles, applied through CDP `Network.emulateNetworkConditions`.
 * Numbers follow the Lighthouse presets so results are comparable to it.
 */
export const NETWORK_SETTINGS: Record<
  NetworkProfile,
  { downloadKbps: number; uploadKbps: number; latencyMs: number } | null
> = {
  FAST: null,
  FAST_4G: { downloadKbps: 9000, uploadKbps: 9000, latencyMs: 85 },
  SLOW_4G: { downloadKbps: 1638, uploadKbps: 675, latencyMs: 150 },
};

/** Apply hard limits to a user-supplied audit config. */
export function clampAuditConfig(
  config: ResolvedAuditConfig,
  limits: EngineConfig['limits'],
): ResolvedAuditConfig {
  return {
    ...config,
    maxPages: Math.min(config.maxPages, limits.maxPages),
    maxDepth: Math.min(config.maxDepth, limits.maxDepth),
  };
}
