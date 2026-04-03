/**
 * Record MCQ Response API
 *
 * POST { questionId, selectedOption, isCorrect, responseTimeMs }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getGuestUser } from '@/lib/api-utils';

const schema = z.object({
  questionId: z.string(),
  selectedOption: z.string(),
  responseTimeMs: z.number().int().min(0).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const userId = await getGuestUser();
    const body = await request.json();
    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    }

    const { questionId, selectedOption, responseTimeMs } = parsed.data;

    // Derive correctness server-side — don't trust the client
    const question = await prisma.question.findUnique({
      where: { id: questionId },
      select: { options: true },
    });

    if (!question) {
      return NextResponse.json({ error: 'Question not found' }, { status: 404 });
    }

    const options = question.options as Array<{ label: string; isCorrect?: boolean }>;
    const selected = options.find(o => o.label === selectedOption);
    const isCorrect = selected?.isCorrect === true;

    await prisma.questionResponse.create({
      data: {
        userId,
        questionId,
        selectedOption,
        isCorrect,
        responseTimeMs: responseTimeMs ?? 0,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to record MCQ response:', error);
    return NextResponse.json({ error: 'Failed to record response' }, { status: 500 });
  }
}
