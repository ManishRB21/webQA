/**
 * Wire contracts shared by the API server and the React client.
 *
 * Keeping these in the shared package means a breaking API change fails the
 * frontend's typecheck rather than at runtime in a user's browser.
 */

import { z } from 'zod';
import { auditConfigSchema } from './audit.js';
import type { AuditRecord, AuditPageRecord, AuditStats } from './audit.js';
import type { Finding } from './finding.js';
import type { ReportDocument, AuditComparison } from './report.js';
import { CATEGORIES, CONFIDENCE_LEVELS, FINDING_STATUSES, SEVERITIES } from './common.js';

export const createAuditRequestSchema = auditConfigSchema;
export type CreateAuditRequest = z.input<typeof createAuditRequestSchema>;

export interface CreateAuditResponse {
  audit: AuditRecord;
  /** Convenience URL for the SSE progress stream. */
  eventsUrl: string;
}

export const listAuditsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  origin: z.string().optional(),
});
export type ListAuditsQuery = z.output<typeof listAuditsQuerySchema>;

export interface ListAuditsResponse {
  audits: AuditRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface GetAuditResponse {
  audit: AuditRecord;
}

export interface AuditStatusResponse {
  id: string;
  status: AuditRecord['status'];
  phase: AuditRecord['phase'];
  progress: number;
  stats: AuditStats | null;
  error: AuditRecord['error'];
}

export const listFindingsQuerySchema = z.object({
  severity: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter((s) => (SEVERITIES as readonly string[]).includes(s)) : undefined)),
  category: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter((s) => (CATEGORIES as readonly string[]).includes(s)) : undefined)),
  confidence: z
    .string()
    .optional()
    .transform((v) =>
      v ? v.split(',').filter((s) => (CONFIDENCE_LEVELS as readonly string[]).includes(s)) : undefined,
    ),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter((s) => (FINDING_STATUSES as readonly string[]).includes(s)) : undefined)),
  /** Filter to findings that occur on this exact page URL. */
  pageUrl: z.string().optional(),
  /** Free-text search across title and description. */
  q: z.string().max(200).optional(),
  sort: z.enum(['priority', 'severity', 'confidence', 'effort', 'reach']).default('priority'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  /** Omit occurrence arrays for a lighter list payload. */
  compact: z.coerce.boolean().default(false),
});
export type ListFindingsQuery = z.output<typeof listFindingsQuerySchema>;

export interface ListFindingsResponse {
  findings: Finding[];
  total: number;
  /** Facet counts so the filter UI can show "HIGH (12)" without a second query. */
  facets: {
    severity: Record<string, number>;
    category: Record<string, number>;
    confidence: Record<string, number>;
  };
  limit: number;
  offset: number;
}

export interface ListPagesResponse {
  pages: AuditPageRecord[];
  total: number;
}

export interface GetReportResponse {
  report: ReportDocument;
}

export interface GetComparisonResponse {
  comparison: AuditComparison;
}

export interface ScreenshotRef {
  key: string;
  url: string;
  pageUrl: string;
  kind: 'viewport' | 'fullpage' | 'evidence';
  capturedAt: string;
}

export interface ListScreenshotsResponse {
  screenshots: ScreenshotRef[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level validation details, when applicable. */
    details?: unknown;
  };
  requestId: string;
}

export const updateFindingSchema = z.object({
  status: z.enum(FINDING_STATUSES).optional(),
});
export type UpdateFindingRequest = z.infer<typeof updateFindingSchema>;
