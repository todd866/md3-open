/**
 * Daily Target — total items to cover today (new + reviews)
 *
 * Accounts for:
 * 1. Consolidation buffer — stop introducing new cards 5 days before exam
 * 2. Review burden — failed cards come back, eating into daily capacity
 *
 * Returns null when no exam date or exam has passed.
 */

const MAX_DAILY_TARGET = 350;
const CONSOLIDATION_BUFFER = 5;

interface DailyTargetInput {
  unseenItems: number;
  daysToExam: number | null;
  estimatedDailyReviews?: number;
}

export interface DailyTargetResult {
  dailyTarget: number;
  newPerDay: number;
  reviewsPerDay: number;
  consolidationDays: number;
}

export function computeDailyTarget(input: DailyTargetInput): DailyTargetResult | null {
  const { unseenItems, daysToExam, estimatedDailyReviews = 0 } = input;
  if (daysToExam === null || daysToExam <= 0) return null;

  const effectiveDays = Math.max(daysToExam - CONSOLIDATION_BUFFER, 1);
  const newPerDay = Math.ceil(unseenItems / effectiveDays);
  const reviewsPerDay = Math.round(estimatedDailyReviews);
  const dailyTarget = Math.min(newPerDay + reviewsPerDay, MAX_DAILY_TARGET);

  return {
    dailyTarget,
    newPerDay,
    reviewsPerDay,
    consolidationDays: Math.min(CONSOLIDATION_BUFFER, daysToExam),
  };
}
