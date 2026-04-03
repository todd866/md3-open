/**
 * Daily Target Tests — Unit tests for computeDailyTarget
 */

import { describe, it, expect } from 'vitest';
import { computeDailyTarget } from './daily-target';

describe('computeDailyTarget', () => {
  it('returns null when daysToExam is null', () => {
    const result = computeDailyTarget({
      unseenItems: 100,
      daysToExam: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when daysToExam is zero', () => {
    const result = computeDailyTarget({
      unseenItems: 100,
      daysToExam: 0,
    });
    expect(result).toBeNull();
  });

  it('returns null when daysToExam is negative (exam passed)', () => {
    const result = computeDailyTarget({
      unseenItems: 50,
      daysToExam: -3,
    });
    expect(result).toBeNull();
  });

  it('computes correct target from unseen items and days', () => {
    const result = computeDailyTarget({
      unseenItems: 100,
      daysToExam: 20,
    });
    expect(result).not.toBeNull();
    // effectiveDays = 20 - 5 (consolidation) = 15
    // newPerDay = ceil(100/15) = 7
    // reviewsPerDay = 0 (no estimated reviews)
    // dailyTarget = 7
    expect(result!.newPerDay).toBe(7);
    expect(result!.dailyTarget).toBe(7);
  });

  it('respects the consolidation buffer of 5 days', () => {
    const result = computeDailyTarget({
      unseenItems: 60,
      daysToExam: 10,
    });
    // effectiveDays = 10 - 5 = 5
    // newPerDay = ceil(60/5) = 12
    expect(result!.newPerDay).toBe(12);
    expect(result!.consolidationDays).toBe(5);
  });

  it('uses effectiveDays of 1 when exam is within consolidation window', () => {
    const result = computeDailyTarget({
      unseenItems: 30,
      daysToExam: 3,
    });
    // effectiveDays = max(3 - 5, 1) = 1
    // newPerDay = ceil(30/1) = 30
    expect(result!.newPerDay).toBe(30);
    expect(result!.consolidationDays).toBe(3); // min(5, 3)
  });

  it('includes estimated daily reviews in target', () => {
    const result = computeDailyTarget({
      unseenItems: 100,
      daysToExam: 20,
      estimatedDailyReviews: 10,
    });
    // newPerDay = ceil(100/15) = 7
    // reviewsPerDay = 10
    // dailyTarget = 7 + 10 = 17
    expect(result!.reviewsPerDay).toBe(10);
    expect(result!.dailyTarget).toBe(17);
  });

  it('caps daily target at 350', () => {
    const result = computeDailyTarget({
      unseenItems: 5000,
      daysToExam: 2,
      estimatedDailyReviews: 200,
    });
    // Would exceed 350 without the cap
    expect(result!.dailyTarget).toBeLessThanOrEqual(350);
    expect(result!.dailyTarget).toBe(350);
  });

  it('handles zero unseen items', () => {
    const result = computeDailyTarget({
      unseenItems: 0,
      daysToExam: 20,
      estimatedDailyReviews: 5,
    });
    expect(result!.newPerDay).toBe(0);
    expect(result!.dailyTarget).toBe(5);
  });
});
