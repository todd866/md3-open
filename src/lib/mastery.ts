/**
 * Card Mastery and Retirement Logic
 *
 * Handles detection of mastered cards and graduation to retirement.
 * Different rules based on card complexity:
 *   - Trivial (1): 3 fast+correct answers -> mastered
 *   - Moderate (2): 5+ reviews with 0.8+ strength -> mastered
 *   - Complex (3): never auto-graduates (always in review pool)
 */

// Response time threshold — answers faster than this are "instant recall"
export const FAST_THRESHOLD_MS = 3000;

// Intervals for mastered cards (in days)
export const MASTERED_INTERVALS = {
  1: 180, // Trivial: 6 months
  2: 90,  // Moderate: 3 months
  3: 60,  // Complex: 2 months
} as const;

export type CardStatus = 'learning' | 'reviewing' | 'mastered';

export interface MasteryUpdate {
  status: CardStatus;
  consecutiveCorrectFast: number;
  avgResponseTimeMs: number | null;
  masteredAt: Date | null;
  nextDueInDays?: number;
}

/**
 * Check if a card should graduate to mastered status
 */
export function shouldGraduate(
  complexity: number,
  consecutiveCorrectFast: number,
  totalReviews: number,
  retrievalStrength: number
): boolean {
  switch (complexity) {
    case 1: // Trivial: 3 fast+correct answers
      return consecutiveCorrectFast >= 3;
    case 2: // Moderate: sustained performance
      return totalReviews >= 5 && retrievalStrength >= 0.8;
    case 3: // Complex: never auto-graduate
      return false;
    default:
      return false;
  }
}

/**
 * Update mastery state based on review result.
 * Returns the new status and any scheduling overrides.
 */
export function updateMasteryState(
  currentState: {
    status: CardStatus;
    consecutiveCorrectFast: number;
    avgResponseTimeMs: number | null;
    totalReviews: number;
  },
  review: {
    quality: number;
    responseTimeMs: number | null;
  },
  card: {
    complexity: number;
  },
  knowledge: {
    totalReviews: number;
    retrievalStrength: number;
  }
): MasteryUpdate {
  const isCorrect = review.quality >= 3;
  const isFast = review.responseTimeMs !== null && review.responseTimeMs < FAST_THRESHOLD_MS;

  // Update consecutive fast+correct counter
  let newConsecutiveCorrectFast = currentState.consecutiveCorrectFast;
  if (isCorrect && isFast) {
    newConsecutiveCorrectFast++;
  } else if (!isCorrect) {
    newConsecutiveCorrectFast = 0; // Reset on failure
  }
  // Note: correct but slow doesn't reset, just doesn't increment

  // Update rolling average response time
  let newAvgResponseTimeMs = currentState.avgResponseTimeMs;
  if (review.responseTimeMs !== null) {
    if (newAvgResponseTimeMs === null) {
      newAvgResponseTimeMs = review.responseTimeMs;
    } else {
      newAvgResponseTimeMs = Math.round(
        0.3 * review.responseTimeMs + 0.7 * newAvgResponseTimeMs
      );
    }
  }

  // Check if card should graduate
  const shouldGrad = shouldGraduate(
    card.complexity,
    newConsecutiveCorrectFast,
    knowledge.totalReviews,
    knowledge.retrievalStrength
  );

  // Determine new status
  let newStatus = currentState.status;
  let masteredAt: Date | null = null;
  let nextDueInDays: number | undefined;

  if (currentState.status === 'mastered' && !isCorrect) {
    // Demote mastered cards on failure
    newStatus = 'reviewing';
  } else if (shouldGrad && currentState.status !== 'mastered') {
    newStatus = 'mastered';
    masteredAt = new Date();
    nextDueInDays = MASTERED_INTERVALS[card.complexity as keyof typeof MASTERED_INTERVALS] || 90;
  } else if (currentState.status === 'learning' && isCorrect && knowledge.totalReviews >= 2) {
    newStatus = 'reviewing';
  }

  return {
    status: newStatus,
    consecutiveCorrectFast: newConsecutiveCorrectFast,
    avgResponseTimeMs: newAvgResponseTimeMs,
    masteredAt,
    nextDueInDays,
  };
}
