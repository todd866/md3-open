/**
 * Record Card Review — Core review recording logic
 *
 * Simplified from the production version: removes struggle tracking,
 * leech detection, scaffolding, and manifold clustering.
 * Keeps the essential flow: fetch card -> compute scheduling -> upsert progress.
 */

import { prisma } from '@/lib/prisma';
import {
  computeNextDueAt,
  updateRetrievalStrength,
  updateStabilityDays,
} from '@/lib/scheduler';
import { updateMasteryState, type CardStatus } from '@/lib/mastery';

const CARD_DUE_THRESHOLD = 0.4;

export type RecordCardReviewInput = {
  userId: string;
  cardId: string;
  quality: number;       // 0-5
  responseTimeMs?: number | null;
};

export type RecordCardReviewResult =
  | { ok: true; nextDueAt: Date; retrievalStrength: number; status: string }
  | { ok: false; status: number; error: string };

export async function recordCardReview(
  input: RecordCardReviewInput
): Promise<RecordCardReviewResult> {
  const { userId, cardId, quality } = input;
  const responseTimeMs = input.responseTimeMs ?? undefined;

  if (!userId) return { ok: false, status: 401, error: 'Authentication required' };
  if (!cardId || quality === undefined) return { ok: false, status: 400, error: 'cardId and quality are required' };
  if (quality < 0 || quality > 5) return { ok: false, status: 400, error: 'quality must be between 0 and 5' };

  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { id: true, complexity: true },
  });
  if (!card) return { ok: false, status: 404, error: 'Card not found' };

  const existingProgress = await prisma.cardProgress.findUnique({
    where: { cardId_userId: { cardId, userId } },
  });

  const now = new Date();
  const daysSinceLastReview = existingProgress?.lastReview
    ? (now.getTime() - existingProgress.lastReview.getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  // 1. Update stability (memory half-life)
  const currentStabilityDays = existingProgress?.stabilityDays ?? 3;
  const nextStabilityDays = updateStabilityDays(currentStabilityDays, quality);

  // 2. Update retrieval strength (recall probability)
  const currentStrength = existingProgress?.retrievalStrength ?? 0;
  const newRetrievalStrength = updateRetrievalStrength(
    currentStrength, quality,
    existingProgress?.totalReviews ?? 0,
    daysSinceLastReview, currentStabilityDays
  );

  // 3. Compute next due date
  const computedNextDueAt = computeNextDueAt(
    newRetrievalStrength, now,
    nextStabilityDays, CARD_DUE_THRESHOLD, now
  );

  // 4. Update mastery state
  const totalReviewsAfter = (existingProgress?.totalReviews ?? 0) + 1;
  const masteryUpdate = updateMasteryState(
    {
      status: (existingProgress?.status as CardStatus) || 'learning',
      consecutiveCorrectFast: existingProgress?.consecutiveCorrectFast ?? 0,
      avgResponseTimeMs: existingProgress?.avgResponseTimeMs ?? null,
      totalReviews: existingProgress?.totalReviews ?? 0,
    },
    { quality, responseTimeMs: responseTimeMs ?? null },
    { complexity: card.complexity },
    { totalReviews: totalReviewsAfter, retrievalStrength: newRetrievalStrength }
  );

  const finalNextDueAt = masteryUpdate.nextDueInDays
    ? new Date(now.getTime() + masteryUpdate.nextDueInDays * 24 * 60 * 60 * 1000)
    : computedNextDueAt;

  // 5. Upsert progress + daily stats in a transaction
  const progress = await prisma.$transaction(async (tx) => {
    const txProgress = await tx.cardProgress.upsert({
      where: { cardId_userId: { cardId, userId } },
      update: {
        stabilityDays: nextStabilityDays,
        nextDueAt: finalNextDueAt,
        lastReview: now,
        lastQuality: quality,
        totalReviews: { increment: 1 },
        correctCount: quality >= 3 ? { increment: 1 } : undefined,
        retrievalStrength: newRetrievalStrength,
        status: masteryUpdate.status,
        consecutiveCorrectFast: masteryUpdate.consecutiveCorrectFast,
        avgResponseTimeMs: masteryUpdate.avgResponseTimeMs,
        masteredAt: masteryUpdate.masteredAt,
      },
      create: {
        cardId, userId,
        stabilityDays: nextStabilityDays,
        nextDueAt: finalNextDueAt,
        lastReview: now,
        lastQuality: quality,
        totalReviews: 1,
        correctCount: quality >= 3 ? 1 : 0,
        retrievalStrength: newRetrievalStrength,
        status: masteryUpdate.status,
        consecutiveCorrectFast: masteryUpdate.consecutiveCorrectFast,
        avgResponseTimeMs: masteryUpdate.avgResponseTimeMs,
        masteredAt: masteryUpdate.masteredAt,
      },
    });

    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    await tx.dailyStats.upsert({
      where: { userId_date: { userId, date: today } },
      update: {
        cardsReviewed: { increment: 1 },
        cardsCorrect: quality >= 3 ? { increment: 1 } : undefined,
        studyTimeMs: responseTimeMs ? { increment: responseTimeMs } : undefined,
      },
      create: {
        userId, date: today,
        cardsReviewed: 1,
        cardsCorrect: quality >= 3 ? 1 : 0,
        studyTimeMs: responseTimeMs ?? 0,
      },
    });

    return txProgress;
  });

  return {
    ok: true,
    nextDueAt: progress.nextDueAt,
    retrievalStrength: progress.retrievalStrength,
    status: progress.status,
  };
}
