/**
 * Tests for deduplication, scoring, interaction-candidate selection, and
 * robots parsing — the logic where a mistake would quietly corrupt the report
 * rather than crash it.
 */

import { describe, expect, it } from 'vitest';
import type { InteractiveElementObservation, RawFinding } from '@webqa/shared';
import { aggregate, dedupeFindings, severityHistogram } from './aggregate.js';
import { selectCandidates } from '../probes/interactions.js';
import { parseRobots } from '../crawl/discovery.js';
import { Frontier } from '../crawl/frontier.js';

function raw(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    ruleId: 'test.rule',
    fingerprint: 'fp-1',
    title: 'Test finding',
    category: 'SEO',
    severity: 'MEDIUM',
    confidence: 'CONFIRMED',
    description: 'A test finding',
    measuredFacts: [],
    inference: 'because',
    technicalDetails: 'details',
    impact: 'impact',
    recommendation: 'fix it',
    estimatedEffort: 'SMALL',
    occurrences: [
      { pageUrl: 'https://example.com/a', selector: null, domSnippet: null, detail: null, artifacts: [], observedAt: '2026-01-01T00:00:00Z' },
    ],
    ...overrides,
  };
}

describe('dedupeFindings', () => {
  it('collapses the same fingerprint across many pages into one finding', () => {
    const input = ['a', 'b', 'c', 'd', 'e'].map((page) =>
      raw({
        occurrences: [{ pageUrl: `https://example.com/${page}`, selector: 'img', domSnippet: null, detail: null, artifacts: [], observedAt: '2026-01-01T00:00:00Z' }],
      }),
    );

    const findings = dedupeFindings(input, 'audit-1');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.affectedPageCount).toBe(5);
    expect(findings[0]!.affectedElementCount).toBe(5);
  });

  it('counts elements and pages separately', () => {
    // Three elements on two pages = 3 elements, 2 pages.
    const findings = dedupeFindings(
      [
        raw({ occurrences: [
          { pageUrl: 'https://example.com/a', selector: 'img:nth-of-type(1)', domSnippet: null, detail: null, artifacts: [], observedAt: 'x' },
          { pageUrl: 'https://example.com/a', selector: 'img:nth-of-type(2)', domSnippet: null, detail: null, artifacts: [], observedAt: 'x' },
        ] }),
        raw({ occurrences: [
          { pageUrl: 'https://example.com/b', selector: 'img:nth-of-type(1)', domSnippet: null, detail: null, artifacts: [], observedAt: 'x' },
        ] }),
      ],
      'audit-1',
    );

    expect(findings[0]!.affectedPageCount).toBe(2);
    expect(findings[0]!.affectedElementCount).toBe(3);
  });

  it('keeps distinct fingerprints apart', () => {
    const findings = dedupeFindings([raw({ fingerprint: 'a' }), raw({ fingerprint: 'b' })], 'audit-1');
    expect(findings).toHaveLength(2);
  });

  it('keeps the worst severity when the same issue varies by page', () => {
    const findings = dedupeFindings(
      [raw({ severity: 'LOW' }), raw({ severity: 'CRITICAL' }), raw({ severity: 'MEDIUM' })],
      'audit-1',
    );
    expect(findings[0]!.severity).toBe('CRITICAL');
  });

  it('keeps the LOWEST confidence — uncertainty must not be averaged away', () => {
    const findings = dedupeFindings(
      [raw({ confidence: 'CONFIRMED' }), raw({ confidence: 'POSSIBLE' })],
      'audit-1',
    );
    expect(findings[0]!.confidence).toBe('POSSIBLE');
  });

  it('caps occurrences so one pathological rule cannot bloat the report', () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      raw({ occurrences: [{ pageUrl: `https://example.com/p${index}`, selector: null, domSnippet: null, detail: null, artifacts: [], observedAt: 'x' }] }),
    );
    const findings = dedupeFindings(many, 'audit-1');
    expect(findings[0]!.occurrences.length).toBeLessThanOrEqual(200);
  });
});

describe('aggregate', () => {
  it('orders findings by priority, worst first', () => {
    const { findings } = aggregate(
      [
        raw({ fingerprint: 'low', severity: 'LOW' }),
        raw({ fingerprint: 'crit', severity: 'CRITICAL' }),
        raw({ fingerprint: 'med', severity: 'MEDIUM' }),
      ],
      'audit-1',
      10,
    );
    expect(findings[0]!.severity).toBe('CRITICAL');
    expect(findings.at(-1)!.severity).toBe('LOW');
  });

  it('produces per-page scores that penalize the worst page hardest', () => {
    const { pageScores } = aggregate(
      [
        raw({ fingerprint: 'a', severity: 'CRITICAL', occurrences: [{ pageUrl: 'https://example.com/bad', selector: null, domSnippet: null, detail: null, artifacts: [], observedAt: 'x' }] }),
        raw({ fingerprint: 'b', severity: 'LOW', occurrences: [{ pageUrl: 'https://example.com/ok', selector: null, domSnippet: null, detail: null, artifacts: [], observedAt: 'x' }] }),
      ],
      'audit-1',
      2,
    );

    expect(pageScores.get('https://example.com/bad')!.healthScore)
      .toBeLessThan(pageScores.get('https://example.com/ok')!.healthScore);
  });

  it('gives a clean site a perfect score', () => {
    const { scores, findings } = aggregate([], 'audit-1', 5);
    expect(findings).toHaveLength(0);
    expect(scores.overall).toBe(100);
  });

  it('links related performance findings for navigation', () => {
    const { findings } = aggregate(
      [
        raw({ fingerprint: 'lcp', ruleId: 'performance.lcp', category: 'PERFORMANCE' }),
        raw({ fingerprint: 'payload', ruleId: 'performance.payload', category: 'PERFORMANCE' }),
      ],
      'audit-1',
      1,
    );
    const lcp = findings.find((finding) => finding.ruleId === 'performance.lcp')!;
    expect(lcp.relatedFingerprints).toContain('payload');
  });
});

describe('severityHistogram', () => {
  it('counts every severity bucket including empty ones', () => {
    const { findings } = aggregate(
      [raw({ fingerprint: 'a', severity: 'HIGH' }), raw({ fingerprint: 'b', severity: 'HIGH' })],
      'audit-1',
      1,
    );
    const histogram = severityHistogram(findings);
    expect(histogram.HIGH).toBe(2);
    expect(histogram.CRITICAL).toBe(0);
  });
});

// ── interaction safety ─────────────────────────────────────────────────────

function element(overrides: Partial<InteractiveElementObservation> = {}): InteractiveElementObservation {
  return {
    selector: 'button.a',
    tag: 'button',
    role: null,
    accessibleName: 'Continue',
    visible: true,
    enabled: true,
    inViewport: true,
    boundingBox: { x: 0, y: 0, width: 100, height: 40 },
    obscuredBy: null,
    ...overrides,
  };
}

describe('selectCandidates — destructive-action safety', () => {
  it.each([
    'Delete account',
    'Remove item',
    'Log out',
    'Sign Out',
    'Unsubscribe',
    'Buy now',
    'Place order',
    'Confirm payment',
    'Cancel subscription',
    'Send message',
    'Download invoice',
    'Deactivate',
  ])('never clicks a control labelled "%s"', (label) => {
    const candidates = selectCandidates([element({ accessibleName: label })], 10);
    expect(candidates).toHaveLength(0);
  });

  it('does click ordinary navigation and CTA controls', () => {
    const candidates = selectCandidates(
      [element({ accessibleName: 'Show more' }), element({ selector: 'button.b', accessibleName: 'Open menu' })],
      10,
    );
    expect(candidates.length).toBe(2);
  });

  it('skips invisible and disabled controls', () => {
    const candidates = selectCandidates(
      [
        element({ visible: false }),
        element({ selector: 'button.b', enabled: false }),
        element({ selector: 'button.c', boundingBox: null }),
      ],
      10,
    );
    expect(candidates).toHaveLength(0);
  });

  it('prioritizes a covered control — that is where real bugs live', () => {
    const candidates = selectCandidates(
      [
        element({ selector: 'button.plain', accessibleName: 'Plain' }),
        element({ selector: 'button.covered', accessibleName: 'Covered', obscuredBy: 'div.overlay' }),
      ],
      10,
    );
    expect(candidates[0]!.element.selector).toBe('button.covered');
  });

  it('prioritizes a control with no accessible name', () => {
    const candidates = selectCandidates(
      [element({ selector: 'button.named', accessibleName: 'Named' }), element({ selector: 'button.unnamed', accessibleName: '' })],
      10,
    );
    expect(candidates[0]!.element.selector).toBe('button.unnamed');
  });

  it('deduplicates structurally identical controls so a grid is not clicked 20 times', () => {
    const grid = Array.from({ length: 20 }, (_, index) =>
      element({ selector: `div.card:nth-of-type(${index + 1}) > button`, accessibleName: 'View' }),
    );
    expect(selectCandidates(grid, 20).length).toBeLessThan(5);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      element({ selector: `button.b${index}`, accessibleName: `Action ${index}` }),
    );
    expect(selectCandidates(many, 8)).toHaveLength(8);
  });
});

// ── robots.txt ─────────────────────────────────────────────────────────────

describe('parseRobots', () => {
  it('applies wildcard group rules', () => {
    const parsed = parseRobots('User-agent: *\nDisallow: /admin\nDisallow: /private\n', 'webQA');
    expect(parsed.disallow).toEqual(['/admin', '/private']);
  });

  it('extracts sitemap references', () => {
    const parsed = parseRobots('Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:\n', 'webQA');
    expect(parsed.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ignores rules that target a different agent', () => {
    const parsed = parseRobots('User-agent: BadBot\nDisallow: /\n', 'webQA');
    expect(parsed.disallow).toEqual([]);
  });

  it('applies rules that name our agent', () => {
    const parsed = parseRobots('User-agent: webqa\nDisallow: /secret\n', 'webQA-Auditor/0.1');
    expect(parsed.disallow).toEqual(['/secret']);
  });

  it('handles consecutive user-agent lines sharing one rule block', () => {
    const parsed = parseRobots('User-agent: Foo\nUser-agent: *\nDisallow: /x\n', 'webQA');
    expect(parsed.disallow).toEqual(['/x']);
  });

  it('strips comments', () => {
    const parsed = parseRobots('User-agent: *  # everyone\nDisallow: /a  # secret\n', 'webQA');
    expect(parsed.disallow).toEqual(['/a']);
  });
});

// ── frontier ───────────────────────────────────────────────────────────────

describe('Frontier', () => {
  const base = {
    seedUrl: 'https://example.com/',
    maxDepth: 2,
    includeSubdomains: false,
    includePaths: [],
    excludePaths: [],
    disallowedPaths: [],
    respectRobots: true,
  };

  it('accepts the seed and rejects an external host', () => {
    const frontier = new Frontier(base);
    expect(frontier.add('https://example.com/', 0, null)).toBe(true);
    expect(frontier.add('https://other.com/', 1, null)).toBe(false);
  });

  it('never queues the same URL twice', () => {
    const frontier = new Frontier(base);
    expect(frontier.add('https://example.com/a', 1, null)).toBe(true);
    expect(frontier.add('https://example.com/a', 1, null)).toBe(false);
    // Differing only by a tracking parameter is the same page.
    expect(frontier.add('https://example.com/a?utm_source=x', 1, null)).toBe(false);
  });

  it('enforces max depth', () => {
    const frontier = new Frontier(base);
    expect(frontier.add('https://example.com/deep', 3, null)).toBe(false);
  });

  it('honours robots.txt disallow rules', () => {
    const frontier = new Frontier({ ...base, disallowedPaths: ['/admin'] });
    expect(frontier.add('https://example.com/admin/users', 1, null)).toBe(false);
    expect(frontier.add('https://example.com/public', 1, null)).toBe(true);
  });

  it('ignores robots when told to', () => {
    const frontier = new Frontier({ ...base, disallowedPaths: ['/admin'], respectRobots: false });
    expect(frontier.add('https://example.com/admin', 1, null)).toBe(true);
  });

  it('applies include and exclude path filters', () => {
    const included = new Frontier({ ...base, includePaths: ['/blog'] });
    expect(included.add('https://example.com/blog/post', 1, null)).toBe(true);
    expect(included.add('https://example.com/shop', 1, null)).toBe(false);

    const excluded = new Frontier({ ...base, excludePaths: ['/private'] });
    expect(excluded.add('https://example.com/private/x', 1, null)).toBe(false);
  });

  it('rejects crawl traps and asset URLs, and records why', () => {
    const frontier = new Frontier(base);
    frontier.add('https://example.com/a/b/a/b/a/b', 1, null);
    frontier.add('https://example.com/file.pdf', 1, null);

    const reasons = frontier.skippedUrls().map((entry) => entry.reason).join(' ');
    expect(reasons).toContain('crawl trap');
    expect(reasons).toContain('not a page');
  });

  it('serves the homepage before deep pages', () => {
    const frontier = new Frontier(base);
    frontier.add('https://example.com/blog/2019/03/some-old-post', 2, null);
    frontier.add('https://example.com/', 0, null);
    expect(frontier.next()!.url).toBe('https://example.com/');
  });

  it('prioritizes conversion-critical paths over archive pages', () => {
    const frontier = new Frontier(base);
    frontier.add('https://example.com/tag/misc', 1, null);
    frontier.add('https://example.com/checkout', 1, null);
    expect(frontier.next()!.url).toContain('/checkout');
  });
});
