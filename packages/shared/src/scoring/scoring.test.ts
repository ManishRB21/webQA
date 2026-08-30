import { describe, expect, it } from 'vitest';
import {
  clampConfidenceAdjustment,
  clampSeverityAdjustment,
  computePriority,
} from './priority.js';
import { computeHealthScores, computePageScore, scoreBand, type ScorableFinding } from './health.js';
import { fingerprint, selectorShape, urlTemplate } from '../util/fingerprint.js';

describe('computePriority', () => {
  it('ranks a critical finding above a high one, all else equal', () => {
    const base = {
      confidence: 'CONFIRMED' as const,
      affectedPageCount: 1,
      affectedElementCount: 1,
      estimatedEffort: 'MEDIUM' as const,
      totalPages: 10,
    };
    const critical = computePriority({ ...base, severity: 'CRITICAL' });
    const high = computePriority({ ...base, severity: 'HIGH' });
    expect(critical.score).toBeGreaterThan(high.score);
  });

  it('ranks wider reach higher', () => {
    const base = {
      severity: 'MEDIUM' as const,
      confidence: 'CONFIRMED' as const,
      affectedElementCount: 1,
      estimatedEffort: 'MEDIUM' as const,
      totalPages: 100,
    };
    const wide = computePriority({ ...base, affectedPageCount: 90 });
    const narrow = computePriority({ ...base, affectedPageCount: 1 });
    expect(wide.score).toBeGreaterThan(narrow.score);
  });

  it('penalizes low confidence', () => {
    const base = {
      severity: 'HIGH' as const,
      affectedPageCount: 5,
      affectedElementCount: 5,
      estimatedEffort: 'SMALL' as const,
      totalPages: 10,
    };
    const confirmed = computePriority({ ...base, confidence: 'CONFIRMED' });
    const possible = computePriority({ ...base, confidence: 'POSSIBLE' });
    expect(confirmed.score).toBeGreaterThan(possible.score);
  });

  it('favours cheap fixes without letting effort outrank severity', () => {
    const trivialLow = computePriority({
      severity: 'LOW',
      confidence: 'CONFIRMED',
      affectedPageCount: 1,
      affectedElementCount: 1,
      estimatedEffort: 'TRIVIAL',
      totalPages: 10,
    });
    const largeCritical = computePriority({
      severity: 'CRITICAL',
      confidence: 'CONFIRMED',
      affectedPageCount: 1,
      affectedElementCount: 1,
      estimatedEffort: 'LARGE',
      totalPages: 10,
    });
    expect(largeCritical.score).toBeGreaterThan(trivialLow.score);
  });
});

describe('clampSeverityAdjustment', () => {
  it('allows a one-step nudge', () => {
    expect(clampSeverityAdjustment('MEDIUM', 'HIGH')).toBe('HIGH');
    expect(clampSeverityAdjustment('MEDIUM', 'LOW')).toBe('LOW');
  });

  it('refuses a multi-step jump', () => {
    expect(clampSeverityAdjustment('INFO', 'CRITICAL')).toBe('LOW');
    expect(clampSeverityAdjustment('CRITICAL', 'INFO')).toBe('HIGH');
  });

  it('is a no-op when unchanged', () => {
    expect(clampSeverityAdjustment('HIGH', 'HIGH')).toBe('HIGH');
  });
});

describe('clampConfidenceAdjustment', () => {
  it('lets the model lower confidence freely', () => {
    expect(clampConfidenceAdjustment('CONFIRMED', 'POSSIBLE')).toBe('POSSIBLE');
  });

  it('will not promote POSSIBLE straight to CONFIRMED', () => {
    expect(clampConfidenceAdjustment('POSSIBLE', 'CONFIRMED')).toBe('LIKELY');
  });

  it('allows a single upward step', () => {
    expect(clampConfidenceAdjustment('LIKELY', 'CONFIRMED')).toBe('CONFIRMED');
  });
});

describe('computeHealthScores', () => {
  const finding = (over: Partial<ScorableFinding> = {}): ScorableFinding => ({
    category: 'PERFORMANCE',
    severity: 'MEDIUM',
    affectedPageCount: 1,
    confidenceScore: 0.95,
    ...over,
  });

  it('gives a clean site 100 across the board', () => {
    const scores = computeHealthScores([], 10);
    expect(scores.overall).toBe(100);
    expect(scores.categories.PERFORMANCE).toBe(100);
  });

  it('penalizes a critical finding heavily', () => {
    const scores = computeHealthScores([finding({ severity: 'CRITICAL' })], 10);
    expect(scores.categories.PERFORMANCE).toBeLessThan(70);
  });

  it('leaves untouched categories at 100', () => {
    const scores = computeHealthScores([finding({ category: 'SEO', severity: 'HIGH' })], 10);
    expect(scores.categories.SECURITY).toBe(100);
    expect(scores.categories.SEO).toBeLessThan(100);
  });

  it('never returns a negative score no matter how many findings', () => {
    const many = Array.from({ length: 200 }, () => finding({ severity: 'CRITICAL' }));
    const scores = computeHealthScores(many, 10);
    expect(scores.overall).toBeGreaterThanOrEqual(0);
    expect(scores.categories.PERFORMANCE).toBeGreaterThanOrEqual(0);
  });

  it('discounts low-confidence findings', () => {
    const sure = computeHealthScores([finding({ severity: 'HIGH', confidenceScore: 0.95 })], 10);
    const unsure = computeHealthScores([finding({ severity: 'HIGH', confidenceScore: 0.4 })], 10);
    expect(unsure.categories.PERFORMANCE).toBeGreaterThan(sure.categories.PERFORMANCE);
  });
});

describe('computePageScore / scoreBand', () => {
  it('bands scores as expected', () => {
    expect(scoreBand(95)).toBe('good');
    expect(scoreBand(70)).toBe('fair');
    expect(scoreBand(30)).toBe('poor');
  });

  it('scores a clean page at 100', () => {
    expect(computePageScore([])).toBe(100);
  });
});

describe('fingerprint', () => {
  it('is stable across calls', () => {
    expect(fingerprint('rule.a', 'x')).toBe(fingerprint('rule.a', 'x'));
  });

  it('ignores case and surrounding whitespace in discriminators', () => {
    expect(fingerprint('rule.a', ' X ')).toBe(fingerprint('rule.a', 'x'));
  });

  it('separates different discriminators', () => {
    expect(fingerprint('rule.a', 'x')).not.toBe(fingerprint('rule.a', 'y'));
  });

  it('skips null and empty discriminators', () => {
    expect(fingerprint('rule.a', null, 'x', undefined, '')).toBe(fingerprint('rule.a', 'x'));
  });
});

describe('urlTemplate', () => {
  it('collapses numeric ids', () => {
    expect(urlTemplate('https://x.com/product/12')).toBe(urlTemplate('https://x.com/product/9999'));
  });

  it('collapses uuids', () => {
    const a = urlTemplate('https://x.com/u/8f14e45f-ceea-467a-9f43-2b0d1e4f5a6b');
    const b = urlTemplate('https://x.com/u/00000000-0000-0000-0000-000000000000');
    expect(a).toBe(b);
  });

  it('keeps genuinely different paths apart', () => {
    expect(urlTemplate('https://x.com/product/1')).not.toBe(urlTemplate('https://x.com/article/1'));
  });
});

describe('selectorShape', () => {
  it('normalizes positional selectors', () => {
    expect(selectorShape('div:nth-child(7) > a')).toBe(selectorShape('div:nth-child(9) > a'));
  });

  it('normalizes generated ids', () => {
    expect(selectorShape('#react-aria-1 > span')).toBe(selectorShape('#react-aria-2 > span'));
  });
});
