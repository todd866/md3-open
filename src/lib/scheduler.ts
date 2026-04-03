/**
 * Spaced Repetition Scheduler — Pure Functions
 *
 * Four functions that implement stability-based scheduling:
 *
 * 1. calculateDecayedStrength — How well do you remember this right now?
 *    Uses power-law decay: R(t) = R0 * (1 + t/S)^(-0.5)
 *
 * 2. updateStabilityDays — How does this review change the memory's half-life?
 *    Success grows stability (1.4-1.6x), failure shrinks it (0.8x)
 *
 * 3. updateRetrievalStrength — What's the new retrieval probability after this review?
 *    Exponential moving average: blends decayed prior with review outcome
 *
 * 4. computeNextDueAt — When should we show this card again?
 *    Solves the decay equation for the threshold crossing time
 *
 * These are pure functions with no database dependencies — all scheduling
 * state is passed in and out as arguments, making the system testable
 * and the math auditable.
 */

// ─── 1. Memory Decay ──────────────────────────────────────────────

/**
 * Calculate time-decayed retrieval strength using power-law decay.
 *
 * Memory follows: R(t) = R0 * (1 + t/S)^(-0.5)
 * where S is stability (days until recall drops significantly)
 *
 * @param strength - Stored retrieval strength (0-1)
 * @param daysSinceReview - Days since last review
 * @param stabilityDays - Memory stability in days (higher = slower decay)
 * @returns Predicted current retrieval probability (0-1)
 */
export function calculateDecayedStrength(
  strength: number,
  daysSinceReview: number,
  stabilityDays: number = 3
): number {
  if (daysSinceReview <= 0) return strength;

  const decayFactor = Math.pow(1 + daysSinceReview / stabilityDays, -0.5);
  return strength * decayFactor;
}

// ─── 2. Stability Update ──────────────────────────────────────────

/**
 * Update stability (memory half-life) after a review.
 *
 * Intentionally simple: a single scalar that grows on success, shrinks on failure.
 * Not SM-2, not FSRS — just a multiplier that works.
 *
 * @param currentStabilityDays - Current stability value
 * @param quality - Review quality (0-5 scale)
 * @returns New stability value in days
 */
export function updateStabilityDays(
  currentStabilityDays: number,
  quality: number
): number {
  const minDays = 0.5;
  const maxDays = 60;

  const baseline = Number.isFinite(currentStabilityDays) && currentStabilityDays > 0
    ? currentStabilityDays
    : 3;

  // Failed review: shrink stability by 20%
  if (quality < 3) {
    return Math.max(minDays, baseline * 0.8);
  }

  // Successful review: grow stability by 1.4x (Good) to 1.6x (Easy)
  const multiplier = 1.4 + 0.1 * Math.max(0, quality - 3);
  return Math.min(maxDays, baseline * multiplier);
}

// ─── 3. Retrieval Strength Update ─────────────────────────────────

/**
 * Map review quality to a target retrieval strength.
 */
function qualityToTargetStrength(quality: number): number {
  if (quality >= 5) return 1.0;
  if (quality === 4) return 0.9;
  if (quality === 3) return 0.8;
  if (quality === 2) return 0.5;
  return 0.3; // wrong but seen — exposure still counts
}

/**
 * Update retrieval strength after a review.
 *
 * Uses exponential moving average (EMA) with recency weighting.
 * First review uses high alpha (0.9) because there's no meaningful
 * prior to blend with. Later reviews use a shrinking alpha (floor 0.3).
 *
 * @param storedStrength - Last saved retrieval strength
 * @param quality - Review quality (0-5)
 * @param totalReviews - Number of reviews before this one
 * @param daysSinceLastReview - Days since last review (for decay)
 * @param stabilityDays - Current stability (for decay calculation)
 * @returns New retrieval strength (0-1)
 */
export function updateRetrievalStrength(
  storedStrength: number,
  quality: number,
  totalReviews: number,
  daysSinceLastReview: number = 0,
  stabilityDays: number = 3
): number {
  // First, decay the stored strength to "right now"
  const decayedStrength = calculateDecayedStrength(
    storedStrength,
    daysSinceLastReview,
    stabilityDays
  );

  const targetStrength = qualityToTargetStrength(quality);

  // EMA alpha: high for first review, decaying for later reviews
  const alpha = totalReviews === 0
    ? 0.9
    : Math.min(0.7, Math.max(0.3, 0.7 / Math.sqrt(Math.max(1, totalReviews))));

  return decayedStrength + (targetStrength - decayedStrength) * alpha;
}

// ─── 4. Next Due Date ─────────────────────────────────────────────

/**
 * Compute when a card should next be reviewed.
 *
 * Solves the power-law decay equation for when strength drops to threshold:
 *   R(t) = R0 * (1 + t/S)^(-0.5) = threshold
 *   t = S * ((R0/threshold)^2 - 1)
 *
 * @param strength - Post-review retrieval strength
 * @param lastReviewDate - When the review happened
 * @param stabilityDays - Current stability value
 * @param threshold - Retrieval probability at which card becomes "due" (default 0.4)
 * @param now - Current time (for edge case: already below threshold)
 * @returns Date when card should next appear
 */
export function computeNextDueAt(
  strength: number,
  lastReviewDate: Date,
  stabilityDays: number,
  threshold: number = 0.4,
  now: Date = new Date()
): Date {
  if (!Number.isFinite(strength) || strength <= 0) return now;
  if (!Number.isFinite(stabilityDays) || stabilityDays <= 0) return now;
  if (!Number.isFinite(threshold) || threshold <= 0) return now;
  if (strength <= threshold) return now;

  const ratio = strength / threshold;
  const daysUntilDue = stabilityDays * (ratio * ratio - 1);
  if (!Number.isFinite(daysUntilDue) || daysUntilDue <= 0) return now;

  return new Date(lastReviewDate.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
}
