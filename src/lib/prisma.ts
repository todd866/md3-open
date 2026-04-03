/**
 * Prisma Client — Database connection with soft-delete extension
 *
 * Uses the standard pg adapter (no Neon WebSocket). Configure via DATABASE_URL.
 *
 * The soft-delete extension automatically filters out cards with deletedAt set,
 * so queries always return only active cards unless you explicitly filter for deleted ones.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

  // ---------------------------------------------------------------------------
  // Soft-delete extension: auto-filter deleted cards from read queries.
  // Cards with deletedAt set are excluded from findMany/findFirst/count.
  // To include soft-deleted cards, explicitly filter: { deletedAt: { not: null } }
  // ---------------------------------------------------------------------------
  return base.$extends({
    query: {
      card: {
        async findMany({ args, query }) {
          if (!args.where || !('deletedAt' in args.where)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async findFirst({ args, query }) {
          if (!args.where || !('deletedAt' in args.where)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async findUnique({ args, query }) {
          if (!args.where || !('deletedAt' in args.where)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async count({ args, query }) {
          if (!args.where || !('deletedAt' in args.where)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

/** The runtime type of the extended Prisma client */
export type ExtendedPrismaClient = typeof prisma;

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
