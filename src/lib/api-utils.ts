/**
 * API Utilities — Cookie-based guest users for the open-source version.
 *
 * Each browser gets its own guest user via a cookie, so visitors don't
 * share review state. No login required.
 */

import { cookies } from 'next/headers';
import { prisma } from './prisma';

const GUEST_COOKIE = 'md3_guest_id';

/**
 * Get or create a guest user based on a browser cookie.
 * Each visitor gets their own isolated progress.
 */
export async function getGuestUser(): Promise<string> {
  const cookieStore = await cookies();
  const existingId = cookieStore.get(GUEST_COOKIE)?.value;

  // If we have a cookie, verify the user still exists
  if (existingId) {
    const user = await prisma.user.findUnique({
      where: { id: existingId },
      select: { id: true },
    });
    if (user) return user.id;
  }

  // Create a new guest user
  const user = await prisma.user.create({
    data: { name: `Guest-${Date.now().toString(36)}` },
    select: { id: true },
  });

  // Set cookie (1 year expiry, httpOnly so JS can't read it)
  cookieStore.set(GUEST_COOKIE, user.id, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
  });

  return user.id;
}
