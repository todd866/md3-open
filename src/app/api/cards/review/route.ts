import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getGuestUser } from '@/lib/api-utils';
import { recordCardReview } from '@/lib/review/record-card-review';

const reviewBodySchema = z.object({
  cardId: z.string().trim().min(1),
  quality: z.number().finite().min(0).max(5),
  responseTimeMs: z.number().int().nonnegative().optional(),
});

export async function POST(request: NextRequest) {
  const userId = await getGuestUser();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parseResult = reviewBodySchema.safeParse(rawBody);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parseResult.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const { cardId, quality, responseTimeMs } = parseResult.data;

  const result = await recordCardReview({ userId, cardId, quality, responseTimeMs });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    success: true,
    nextDueAt: result.nextDueAt,
    retrievalStrength: result.retrievalStrength,
    status: result.status,
  });
}
