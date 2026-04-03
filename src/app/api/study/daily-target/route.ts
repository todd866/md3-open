/**
 * Daily Target API
 *
 * GET ?rotation=example-rotation
 *
 * Returns daily study target based on exam date, coverage, and review burden.
 * Uses computeDailyTarget() to account for consolidation buffer and review load.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getGuestUser } from '@/lib/api-utils';
import { computeDailyTarget } from '@/lib/study/daily-target';

export async function GET(request: NextRequest) {
  const userId = await getGuestUser();
  const { searchParams } = request.nextUrl;
  const rotation = searchParams.get('rotation') || 'example-rotation';

  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    // Fetch all counts in parallel
    const [
      totalCards,
      totalQuestions,
      seenCards,
      seenQuestionRows,
      user,
      todayCardReviews,
      todayQuestionRows,
      dueReviews,
    ] = await Promise.all([
      prisma.card.count({ where: { rotation } }),
      prisma.question.count({ where: { rotation } }),
      prisma.cardProgress.count({
        where: { userId, card: { rotation }, totalReviews: { gt: 0 } },
      }),
      prisma.questionResponse.findMany({
        where: { userId, question: { rotation } },
        select: { questionId: true },
        distinct: ['questionId'],
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { examDate: true },
      }),
      prisma.cardProgress.count({
        where: { userId, card: { rotation }, lastReview: { gte: startOfDay } },
      }),
      prisma.questionResponse.findMany({
        where: { userId, question: { rotation }, createdAt: { gte: startOfDay } },
        select: { questionId: true },
        distinct: ['questionId'],
      }),
      // Estimate review burden: cards that were answered wrong recently
      prisma.cardProgress.count({
        where: {
          userId,
          card: { rotation },
          lastReview: { not: null },
          lastQuality: { lt: 3 },
        },
      }),
    ]);

    const seenQuestions = seenQuestionRows.length;
    const todayQuestionReviews = todayQuestionRows.length;
    const totalSeen = seenCards + seenQuestions;
    const totalItems = totalCards + totalQuestions;
    const unseenItems = totalItems - totalSeen;

    // Use user's exam date, or default to 30 days from now
    const examDate = user?.examDate ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const daysToExam = Math.max(0, Math.ceil((examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    // Estimate daily reviews: spread failed cards over remaining days
    const estimatedDailyReviews = daysToExam > 0
      ? Math.ceil((dueReviews * 2) / daysToExam)
      : 0;

    const result = computeDailyTarget({ unseenItems, daysToExam, estimatedDailyReviews });

    return NextResponse.json({
      dailyTarget: result?.dailyTarget ?? null,
      newPerDay: result?.newPerDay ?? null,
      reviewsPerDay: result?.reviewsPerDay ?? null,
      consolidationDays: result?.consolidationDays ?? null,
      coverage: {
        seen: totalSeen,
        total: totalItems,
        percent: totalItems > 0 ? Math.floor((totalSeen / totalItems) * 100) : 0,
        seenCards,
        totalCards,
        seenQuestions,
        totalQuestions,
      },
      daysToExam,
      examDate: examDate.toISOString(),
      todayReviewed: todayCardReviews + todayQuestionReviews,
    });
  } catch (error) {
    console.error('Daily target error:', error);
    return NextResponse.json({ error: 'Failed to compute daily target' }, { status: 500 });
  }
}
