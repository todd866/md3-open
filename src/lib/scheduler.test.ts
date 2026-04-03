/**
 * Scheduler Tests — Pure function unit tests for the spaced repetition scheduler
 */

import { describe, it, expect } from 'vitest';
import {
  calculateDecayedStrength,
  updateStabilityDays,
  updateRetrievalStrength,
  computeNextDueAt,
} from './scheduler';

// ─── calculateDecayedStrength ─────────────────────────────────────

describe('calculateDecayedStrength', () => {
  it('returns full strength when no time has passed', () => {
    expect(calculateDecayedStrength(0.8, 0, 3)).toBe(0.8);
  });

  it('returns full strength for negative days', () => {
    expect(calculateDecayedStrength(0.8, -1, 3)).toBe(0.8);
  });

  it('decays strength over time', () => {
    const decayed = calculateDecayedStrength(1.0, 3, 3);
    // R(t) = 1.0 * (1 + 3/3)^(-0.5) = 1.0 * 2^(-0.5) ≈ 0.707
    expect(decayed).toBeCloseTo(0.707, 2);
  });

  it('decays more with longer time', () => {
    const short = calculateDecayedStrength(1.0, 1, 3);
    const long = calculateDecayedStrength(1.0, 10, 3);
    expect(long).toBeLessThan(short);
  });

  it('decays less with higher stability', () => {
    const lowStability = calculateDecayedStrength(1.0, 5, 2);
    const highStability = calculateDecayedStrength(1.0, 5, 20);
    expect(highStability).toBeGreaterThan(lowStability);
  });

  it('returns near zero for very old cards', () => {
    const ancient = calculateDecayedStrength(1.0, 365, 3);
    expect(ancient).toBeLessThan(0.1);
  });

  it('handles zero strength input', () => {
    expect(calculateDecayedStrength(0, 5, 3)).toBe(0);
  });
});

// ─── updateStabilityDays ──────────────────────────────────────────

describe('updateStabilityDays', () => {
  it('increases stability on a good review (quality >= 3)', () => {
    const result = updateStabilityDays(3, 3);
    expect(result).toBeGreaterThan(3);
  });

  it('increases stability more for easy reviews', () => {
    const good = updateStabilityDays(3, 3);
    const easy = updateStabilityDays(3, 5);
    expect(easy).toBeGreaterThan(good);
  });

  it('decreases stability on a failed review (quality < 3)', () => {
    const result = updateStabilityDays(3, 0);
    expect(result).toBeLessThan(3);
    // 3 * 0.8 = 2.4
    expect(result).toBeCloseTo(2.4, 2);
  });

  it('never goes below 0.5 days', () => {
    const result = updateStabilityDays(0.5, 0);
    expect(result).toBeGreaterThanOrEqual(0.5);
  });

  it('never exceeds 60 days', () => {
    const result = updateStabilityDays(55, 5);
    expect(result).toBeLessThanOrEqual(60);
  });

  it('handles invalid (NaN/0) input with default of 3', () => {
    const result = updateStabilityDays(0, 5);
    // Should treat 0 as default (3) then multiply
    expect(result).toBeGreaterThan(0);
  });
});

// ─── updateRetrievalStrength ──────────────────────────────────────

describe('updateRetrievalStrength', () => {
  it('returns high strength for first correct review', () => {
    const result = updateRetrievalStrength(0, 5, 0);
    // First review uses high alpha (0.9), target for quality 5 = 1.0
    // EMA: 0 + (1.0 - 0) * 0.9 = 0.9
    expect(result).toBeCloseTo(0.9, 1);
  });

  it('returns lower strength for first failed review', () => {
    const result = updateRetrievalStrength(0, 0, 0);
    // First review, target for quality 0 = 0.3
    // EMA: 0 + (0.3 - 0) * 0.9 = 0.27
    expect(result).toBeCloseTo(0.27, 1);
  });

  it('blends prior strength with new outcome on later reviews', () => {
    const result = updateRetrievalStrength(0.8, 3, 5, 1, 3);
    // Should blend decayed strength with target (0.8 for quality 3)
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('accounts for time decay before blending', () => {
    // Same strength and quality, but one with long gap
    const noGap = updateRetrievalStrength(0.8, 3, 5, 0, 3);
    const longGap = updateRetrievalStrength(0.8, 3, 5, 30, 3);
    // Long gap decays the prior more, so result should differ
    expect(longGap).toBeLessThan(noGap);
  });

  it('always returns a value between 0 and 1', () => {
    const result = updateRetrievalStrength(1.0, 5, 100, 0, 60);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// ─── computeNextDueAt ─────────────────────────────────────────────

describe('computeNextDueAt', () => {
  const now = new Date('2026-01-15T12:00:00Z');

  it('returns a future date for strong cards', () => {
    const due = computeNextDueAt(0.9, now, 5, 0.4, now);
    expect(due.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns further out for stronger cards', () => {
    const weak = computeNextDueAt(0.5, now, 5, 0.4, now);
    const strong = computeNextDueAt(0.9, now, 5, 0.4, now);
    expect(strong.getTime()).toBeGreaterThan(weak.getTime());
  });

  it('returns further out for more stable cards', () => {
    const lowStability = computeNextDueAt(0.8, now, 2, 0.4, now);
    const highStability = computeNextDueAt(0.8, now, 20, 0.4, now);
    expect(highStability.getTime()).toBeGreaterThan(lowStability.getTime());
  });

  it('returns now when strength is at or below threshold', () => {
    const due = computeNextDueAt(0.4, now, 5, 0.4, now);
    expect(due.getTime()).toBe(now.getTime());
  });

  it('returns now for zero strength', () => {
    const due = computeNextDueAt(0, now, 5, 0.4, now);
    expect(due.getTime()).toBe(now.getTime());
  });

  it('returns now for zero stability', () => {
    const due = computeNextDueAt(0.8, now, 0, 0.4, now);
    expect(due.getTime()).toBe(now.getTime());
  });

  it('returns now for NaN inputs', () => {
    const due = computeNextDueAt(NaN, now, 5, 0.4, now);
    expect(due.getTime()).toBe(now.getTime());
  });
});
