/**
 * Audit lifecycle: configuration, status, progress events.
 */

import { z } from 'zod';
import type { BrowserEngine, Category, DeviceProfile, NetworkProfile } from './common.js';

export const AUDIT_STATUSES = [
  'QUEUED',
  'RUNNING',
  'ANALYZING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** Coarse phases surfaced to the progress UI. */
export const AUDIT_PHASES = [
  'PREFLIGHT',
  'DISCOVERY',
  'CRAWL',
  'INTERACTION',
  'LIGHTHOUSE',
  'LINK_CHECK',
  'ANALYSIS',
  'AI_ANALYSIS',
  'REPORT',
] as const;
export type AuditPhase = (typeof AUDIT_PHASES)[number];

export const AUDIT_PHASE_LABELS: Record<AuditPhase, string> = {
  PREFLIGHT: 'Checking reachability',
  DISCOVERY: 'Discovering robots.txt and sitemap',
  CRAWL: 'Crawling and probing pages',
  INTERACTION: 'Functional interaction testing',
  LIGHTHOUSE: 'Lighthouse performance analysis',
  LINK_CHECK: 'Verifying links and resources',
  ANALYSIS: 'Running rule engine',
  AI_ANALYSIS: 'AI root-cause analysis',
  REPORT: 'Generating report',
};

// ── Configuration ──────────────────────────────────────────────────────────

export const MAX_PAGES_CHOICES = [10, 25, 50, 100, 500] as const;
export const MAX_DEPTH_CHOICES = [1, 2, 3, 5] as const;

/**
 * Validated at the API boundary. Hard ceilings from env are applied on top of
 * this — a request for 500 pages is clamped by `MAX_PAGES_HARD_LIMIT`.
 */
export const auditConfigSchema = z.object({
  url: z.string().url().max(2048),
  maxPages: z.number().int().min(1).max(500).default(25),
  maxDepth: z.number().int().min(0).max(5).default(2),
  device: z.enum(['DESKTOP', 'MOBILE']).default('DESKTOP'),
  network: z.enum(['FAST', 'FAST_4G', 'SLOW_4G']).default('FAST'),
  browser: z.enum(['CHROMIUM']).default('CHROMIUM'),
  /** Honour robots.txt disallow rules while crawling. */
  respectRobots: z.boolean().default(true),
  /** Follow links to subdomains of the seed host. */
  includeSubdomains: z.boolean().default(false),
  /** Run bounded interaction tests (clicks, form probes). */
  interactionTesting: z.boolean().default(true),
  /** Run Lighthouse on a small sample of representative pages. */
  lighthouse: z.boolean().default(true),
  /** Send findings to the configured LLM for enrichment. */
  aiAnalysis: z.boolean().default(true),
  /** HEAD/GET every discovered link, including external ones. */
  checkExternalLinks: z.boolean().default(true),
  /**
   * Active security probing is OFF by default and requires explicit
   * authorization. The MVP ships passive checks only; this flag exists so the
   * data model and consent flow are in place before any active feature lands.
   */
  activeSecurityScan: z.boolean().default(false),
  /** Free-text attestation recorded when activeSecurityScan is enabled. */
  authorizationAttestation: z.string().max(500).nullable().default(null),
  /** Restrict the crawl to URLs matching these path prefixes. */
  includePaths: z.array(z.string().max(512)).max(50).default([]),
  /** Never crawl URLs matching these path prefixes. */
  excludePaths: z.array(z.string().max(512)).max(50).default([]),
  /** Optional label shown in the dashboard. */
  label: z.string().max(120).nullable().default(null),
});

export type AuditConfigInput = z.input<typeof auditConfigSchema>;
export type AuditConfig = z.output<typeof auditConfigSchema>;

/** Fully-resolved config after hard limits are applied by the API. */
export interface ResolvedAuditConfig extends Omit<AuditConfig, 'device' | 'network' | 'browser'> {
  device: DeviceProfile;
  network: NetworkProfile;
  browser: BrowserEngine;
}

// ── Records ────────────────────────────────────────────────────────────────

export interface AuditRecord {
  id: string;
  projectId: string | null;
  url: string;
  origin: string;
  label: string | null;
  status: AuditStatus;
  phase: AuditPhase | null;
  config: ResolvedAuditConfig;
  /** 0..100 overall progress estimate. */
  progress: number;
  scores: HealthScores | null;
  executiveSummary: string | null;
  /** Populated only when status is FAILED. */
  error: { message: string; code: string } | null;
  stats: AuditStats | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditStats {
  pagesCrawled: number;
  pagesFailed: number;
  requestsObserved: number;
  bytesTransferred: number;
  consoleErrors: number;
  interactionsTested: number;
  linksChecked: number;
  brokenLinks: number;
  findingsTotal: number;
  findingsBySeverity: Record<string, number>;
  durationMs: number;
}

/**
 * 0..100 per category plus a weighted overall. Computed deterministically in
 * `scoring/health.ts` so two audits of the same site are comparable.
 */
export interface HealthScores {
  overall: number;
  categories: Record<Category, number>;
}

export interface AuditPageRecord {
  id: string;
  auditId: string;
  url: string;
  normalizedUrl: string;
  depth: number;
  discoveredFrom: string | null;
  httpStatus: number | null;
  title: string | null;
  /** Per-page health score, same scale as the site score. */
  healthScore: number | null;
  findingCount: number;
  /** Denormalized severity histogram for the page list view. */
  severityCounts: Record<string, number>;
  loadTimeMs: number | null;
  bytesTransferred: number | null;
  screenshotKey: string | null;
  probeError: string | null;
  createdAt: string;
}

// ── Progress / log streaming ───────────────────────────────────────────────

export type AuditEventType =
  | 'status'
  | 'phase'
  | 'progress'
  | 'log'
  | 'page'
  | 'finding'
  | 'scores'
  | 'done'
  | 'error'
  | 'heartbeat';

export interface AuditEvent {
  type: AuditEventType;
  auditId: string;
  at: string;
  /** Human-readable line for the live log panel. Never contains secrets. */
  message?: string;
  level?: 'info' | 'warn' | 'error' | 'success';
  phase?: AuditPhase;
  status?: AuditStatus;
  progress?: number;
  /** Type-specific payload; kept loose because this is a UI-facing stream. */
  data?: unknown;
}
