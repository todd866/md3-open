import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getGuestUser } from '@/lib/api-utils';

/**
 * GET /api/study/due-summary?rotation=example-rotation
 *
 * Returns count of due cards and total cards for a rotation.
 */
export async function GET(request: NextRequest) {
  const userId = await getGuestUser();
  const { searchParams } = request.nextUrl;
  const rotation = searchParams.get('rotation') || 'example-rotation';

  const now = new Date();

  const [totalCards, dueCount, reviewedCount] = await Promise.all([
    prisma.card.count({ where: { rotation } }),
    prisma.cardProgress.count({
      where: { userId, card: { rotation }, nextDueAt: { lte: now }, status: { not: 'mastered' } },
    }),
    prisma.cardProgress.count({
      where: { userId, card: { rotation } },
    }),
  ]);

  return NextResponse.json({
    rotation,
    totalCards,
    dueCount,
    reviewedCount,
    coveragePercent: totalCards > 0 ? Math.round((reviewedCount / totalCards) * 100) : 0,
  });
}
