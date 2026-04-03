/**
 * Exam Date API
 *
 * GET  — Returns the user's current exam date (or default 30 days from now)
 * POST — Saves a new exam date { examDate: "2026-04-17" }
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getGuestUser } from '@/lib/api-utils';

export async function GET() {
  const userId = await getGuestUser();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { examDate: true },
  });

  const examDate = user?.examDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  return NextResponse.json({
    examDate: examDate.toISOString(),
    isDefault: !user?.examDate,
  });
}

export async function POST(request: NextRequest) {
  const userId = await getGuestUser();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { examDate } = body as { examDate?: string };
  if (!examDate) {
    return NextResponse.json({ error: 'examDate is required' }, { status: 400 });
  }

  const parsed = new Date(examDate);
  if (isNaN(parsed.getTime())) {
    return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { examDate: parsed },
  });

  return NextResponse.json({ examDate: parsed.toISOString() });
}
