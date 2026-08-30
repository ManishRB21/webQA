/**
 * Core vocabulary shared by every layer of the system.
 *
 * These enums are deliberately small and stable — they appear in the database,
 * on the wire, and in the UI. Adding a value is cheap; changing the meaning of
 * an existing one is not.
 */

/**
 * How badly this hurts. Assigned by rules (deterministically), then optionally
 * adjusted by AI enrichment within a bounded range — see `scoring/severity.ts`.
 */
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Ordering helper. Lower number = more severe, so `sort((a,b) => rank(a)-rank(b))`
 * puts the scariest thing first.
 */
export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

/**
 * How sure we are that this is actually a problem.
 *
 * This is the product's honesty mechanism. A rule that observed an HTTP 500
 * emits CONFIRMED. A rule that noticed a button produced no visible change
 * emits POSSIBLE, because the change may simply have been invisible to us.
 * The AI layer is explicitly forbidden from upgrading CONFIRMED-ness on
 * evidence it did not receive.
 */
export const CONFIDENCE_LEVELS = ['CONFIRMED', 'LIKELY', 'POSSIBLE'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Numeric confidence used for sorting and for the report's percentage display. */
export const CONFIDENCE_BASELINE: Record<ConfidenceLevel, number> = {
  CONFIRMED: 0.95,
  LIKELY: 0.75,
  POSSIBLE: 0.5,
};

export const CATEGORIES = [
  'FUNCTIONAL',
  'PERFORMANCE',
  'ACCESSIBILITY',
  'SEO',
  'SECURITY',
  'RELIABILITY',
  'UI_UX',
  'BEST_PRACTICES',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  FUNCTIONAL: 'Functional',
  PERFORMANCE: 'Performance',
  ACCESSIBILITY: 'Accessibility',
  SEO: 'SEO',
  SECURITY: 'Security',
  RELIABILITY: 'Reliability',
  UI_UX: 'UI / UX',
  BEST_PRACTICES: 'Best Practices',
};

/** Workflow state of a finding. Reserved for the triage features in the roadmap. */
export const FINDING_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED', 'REGRESSED'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Rough engineering cost, used for the "what should I fix first" ordering. */
export const EFFORT_LEVELS = ['TRIVIAL', 'SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Relative weight used when converting effort into a priority score. */
export const EFFORT_WEIGHT: Record<EffortLevel, number> = {
  TRIVIAL: 1,
  SMALL: 2,
  MEDIUM: 4,
  LARGE: 8,
  UNKNOWN: 4,
};

export const DEVICE_PROFILES = ['DESKTOP', 'MOBILE'] as const;
export type DeviceProfile = (typeof DEVICE_PROFILES)[number];

export const NETWORK_PROFILES = ['FAST', 'FAST_4G', 'SLOW_4G'] as const;
export type NetworkProfile = (typeof NETWORK_PROFILES)[number];

export const BROWSER_ENGINES = ['CHROMIUM'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
