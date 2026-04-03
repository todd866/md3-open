import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getGuestUser } from '@/lib/api-utils';

const VALID_TYPES = ['card', 'question', 'component'] as const;
const VALID_REASONS = ['incorrect', 'confusing', 'too easy', 'formatting', 'other'] as const;

const schema = z.object({
  type: z.enum(VALID_TYPES),
  id: z.string().max(100),
  reason: z.enum(VALID_REASONS),
  message: z.string().max(500).optional(),
});

/**
 * POST /api/content/flag
 *
 * Create a content issue from a user flag.
 * Rate-limited to 20 flags per user per hour.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getGuestUser();
    const body = await request.json();
    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    }

    const { type, id, reason, message } = parsed.data;

    // Rate limit: 20 flags per user per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentFlags = await prisma.contentIssue.count({
      where: { createdBy: userId, createdAt: { gte: oneHourAgo } },
    });
    if (recentFlags >= 20) {
      return NextResponse.json({ error: 'Too many flags — try again later' }, { status: 429 });
    }

    // Dedupe: don't create duplicate flags for same user + target + reason
    const existing = await prisma.contentIssue.findFirst({
      where: { createdBy: userId, targetType: type, targetId: id, issueType: reason, status: 'open' },
    });
    if (existing) {
      // Increment report count instead of creating a duplicate
      await prisma.contentIssue.update({
        where: { id: existing.id },
        data: { reportCount: { increment: 1 } },
      });
      return NextResponse.json({ success: true, deduplicated: true });
    }

    await prisma.contentIssue.create({
      data: {
        targetType: type,
        targetId: id,
        issueType: reason,
        createdBy: userId,
        metadata: message ? { message: message.slice(0, 500) } : undefined,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Flag creation failed:', error);
    return NextResponse.json({ error: 'Failed to create flag' }, { status: 500 });
  }
}
