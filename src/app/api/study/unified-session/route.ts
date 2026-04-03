import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getGuestUser } from '@/lib/api-utils';

/**
 * GET /api/study/unified-session?rotation=example-rotation&limit=20
 *
 * Returns a mixed session of due cards and questions for review.
 * Priority: overdue cards first, then new cards, then questions.
 */
export async function GET(request: NextRequest) {
  const userId = await getGuestUser();
  const { searchParams } = request.nextUrl;
  const rotation = searchParams.get('rotation') || 'example-rotation';
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);

  const now = new Date();

  // 1. Fetch due cards (cards with progress that are overdue)
  const dueCards = await prisma.card.findMany({
    where: {
      rotation,
      progress: {
        some: {
          userId,
          nextDueAt: { lte: now },
          status: { not: 'mastered' },
        },
      },
    },
    select: {
      id: true, front: true, back: true, backs: true, context: true,
      progress: { where: { userId }, select: { nextDueAt: true, retrievalStrength: true } },
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });

  // 2. Fetch new cards (never seen before)
  const newCards = await prisma.card.findMany({
    where: {
      rotation,
      progress: { none: { userId } },
    },
    select: { id: true, front: true, back: true, backs: true, context: true },
    take: Math.max(0, limit - dueCards.length),
    orderBy: { createdAt: 'asc' },
  });

  // 3. Fetch questions the user hasn't answered yet
  const remaining = Math.max(0, limit - dueCards.length - newCards.length);
  const answeredQuestionIds = await prisma.questionResponse.findMany({
    where: { userId },
    select: { questionId: true },
    distinct: ['questionId'],
  });
  const answeredSet = new Set(answeredQuestionIds.map(r => r.questionId));

  const questions = remaining > 0 ? await prisma.question.findMany({
    where: {
      rotation,
      id: { notIn: [...answeredSet] },
    },
    select: { id: true, stem: true, options: true, context: true },
    take: remaining,
    orderBy: { createdAt: 'asc' },
  }) : [];

  // Transform to review items
  const items = [
    ...dueCards.map(c => ({
      id: c.id,
      type: 'card' as const,
      front: c.front,
      back: c.back,
      backs: c.backs as string[] | undefined,
      context: c.context,
    })),
    ...newCards.map(c => ({
      id: c.id,
      type: 'card' as const,
      front: c.front,
      back: c.back,
      backs: c.backs as string[] | undefined,
      context: c.context,
    })),
    ...questions.map(q => ({
      id: q.id,
      type: 'question' as const,
      stem: q.stem,
      options: q.options as Array<{ label: string; text: string; isCorrect: boolean; explanation?: string }>,
      context: q.context,
    })),
  ];

  return NextResponse.json({ items, total: items.length });
}
