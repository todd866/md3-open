/**
 * User Stats API
 *
 * GET — Returns study statistics for the guest user:
 *   - Total card reviews, total MCQ responses
 *   - MCQ accuracy (correct / total)
 *   - Current streak (consecutive days with activity)
 *   - Daily activity for the last 7 days
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getGuestUser } from '@/lib/api-utils';

export async function GET() {
  const userId = await getGuestUser();

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [totalCardReviews, mcqResponses, dailyStatsRows] = await Promise.all([
      // Total card reviews
      prisma.cardProgress.aggregate({
        where: { userId },
        _sum: { totalReviews: true },
      }),
      // MCQ responses (total and correct)
      prisma.questionResponse.findMany({
        where: { userId },
        select: { isCorrect: true },
      }),
      // Daily stats for last 7 days
      prisma.dailyStats.findMany({
        where: { userId, date: { gte: sevenDaysAgo } },
        orderBy: { date: 'asc' },
      }),
    ]);

    const totalReviews = totalCardReviews._sum.totalReviews ?? 0;
    const totalMcqs = mcqResponses.length;
    const correctMcqs = mcqResponses.filter(r => r.isCorrect).length;
    const accuracy = totalMcqs > 0 ? Math.round((correctMcqs / totalMcqs) * 100) : 0;

    // Count MCQs per day from questionResponses
    const mcqsByDay = await prisma.questionResponse.groupBy({
      by: ['createdAt'],
      where: { userId, createdAt: { gte: sevenDaysAgo } },
      _count: true,
    });
    const mcqCountsByDate = new Map<string, number>();
    for (const row of mcqsByDay) {
      const dateKey = new Date(row.createdAt).toISOString().slice(0, 10);
      mcqCountsByDate.set(dateKey, (mcqCountsByDate.get(dateKey) ?? 0) + row._count);
    }

    // Compute streak from BOTH card review days and MCQ days
    const cardDates = dailyStatsRows.map(d => d.date.toISOString().slice(0, 10));
    const mcqDates = [...mcqCountsByDate.keys()];
    const allActiveDates = new Set([...cardDates, ...mcqDates]);
    const streak = computeStreak(allActiveDates);

    // Build 7-day activity chart data
    const dailyActivity = buildDailyActivity(dailyStatsRows, now);
    for (const day of dailyActivity) {
      day.mcqs = mcqCountsByDate.get(day.date) ?? 0;
    }

    return NextResponse.json({
      totalReviews,
      totalMcqs,
      accuracy,
      streak,
      dailyActivity,
    });
  } catch (error) {
    console.error('User stats error:', error);
    return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 });
  }
}

/** Compute streak of consecutive days with study activity (cards OR MCQs) */
function computeStreak(activeDays: Set<string>): number {
  if (activeDays.size === 0) return 0;

  const daySet = activeDays;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let streak = 0;
  const check = new Date(today);

  // Allow starting from today or yesterday
  if (!daySet.has(check.toISOString().slice(0, 10))) {
    check.setDate(check.getDate() - 1);
    if (!daySet.has(check.toISOString().slice(0, 10))) return 0;
  }

  while (daySet.has(check.toISOString().slice(0, 10))) {
    streak++;
    check.setDate(check.getDate() - 1);
  }

  return streak;
}

/** Build a 7-day activity array with zero-filled gaps */
function buildDailyActivity(
  rows: Array<{ date: Date; cardsReviewed: number }>,
  now: Date
): Array<{ date: string; cards: number; mcqs: number }> {
  const result: Array<{ date: string; cards: number; mcqs: number }> = [];
  const rowMap = new Map(rows.map(r => [r.date.toISOString().slice(0, 10), r]));

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const row = rowMap.get(dateKey);
    result.push({
      date: dateKey,
      cards: row?.cardsReviewed ?? 0,
      mcqs: 0, // Filled in by caller
    });
  }

  return result;
}
