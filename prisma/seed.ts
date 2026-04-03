/**
 * Seed Script — Generates cards from MDX content and loads question bank
 *
 * Run with: npm run seed (or npx prisma db seed)
 *
 * 1. Parses MDX files in content/ to extract cloze-deletion cards
 * 2. Loads question bank JSON from question-bank/
 * 3. Creates a guest user if none exists
 * 4. Reports counts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { parseRotationContent } from '../src/lib/card-generator';

// ─── Database Connection ──────────────────────────────────────────

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// ─── Stable ID Generation ─────────────────────────────────────────

function computeStableId(card: {
  rotation: string;
  week: number | null;
  sourceFile?: string | null;
  sourceComponent: string;
  cardType: string;
  front: string;
  back: string;
}): string {
  const payload = JSON.stringify({
    rotation: card.rotation,
    week: card.week,
    sourceFile: card.sourceFile ?? null,
    sourceComponent: card.sourceComponent,
    cardType: card.cardType,
    front: card.front.trim().replace(/\s+/g, ' '),
    back: card.back.trim().replace(/\s+/g, ' '),
  });
  const digest = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `mdx:${digest}`;
}

// ─── Card Seeding ─────────────────────────────────────────────────

async function seedCards() {
  const contentDir = path.join(process.cwd(), 'content');
  const rotationDirs = fs.readdirSync(contentDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let totalCards = 0;
  let upsertedCards = 0;

  for (const rotation of rotationDirs) {
    const rotationDir = path.join(contentDir, rotation);
    const cards = parseRotationContent(rotationDir, rotation);
    totalCards += cards.length;

    for (const card of cards) {
      const stableId = computeStableId(card);

      await prisma.card.upsert({
        where: { stableId },
        update: {
          front: card.front,
          back: card.back,
          backs: card.backs ?? undefined,
          context: card.context,
          topics: card.topics,
          complexity: card.complexity,
          sourceFile: card.sourceFile,
          sourceComponent: card.sourceComponent,
          week: card.week,
        },
        create: {
          stableId,
          cardType: card.cardType,
          rotation: card.rotation,
          week: card.week,
          sourceFile: card.sourceFile,
          sourceComponent: card.sourceComponent,
          front: card.front,
          back: card.back,
          backs: card.backs ?? undefined,
          context: card.context,
          topics: card.topics,
          complexity: card.complexity,
        },
      });
      upsertedCards++;
    }

    if (cards.length > 0) {
      console.log(`  ${rotation}: ${cards.length} cards`);
    }
  }

  // Soft-delete cards that are no longer in source content
  const allCurrentStableIds = new Set<string>();
  for (const rotation of rotationDirs) {
    const rotationDir = path.join(contentDir, rotation);
    const cards = parseRotationContent(rotationDir, rotation);
    for (const card of cards) {
      allCurrentStableIds.add(computeStableId(card));
    }
  }

  const softDeleted = await prisma.card.updateMany({
    where: {
      stableId: { notIn: [...allCurrentStableIds] },
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });

  if (softDeleted.count > 0) {
    console.log(`  Soft-deleted ${softDeleted.count} cards no longer in source content`);
  }

  return { totalCards, upsertedCards };
}

// ─── Question Bank Seeding ────────────────────────────────────────

async function seedQuestions() {
  const bankDir = path.join(process.cwd(), 'question-bank');
  if (!fs.existsSync(bankDir)) return { totalQuestions: 0, questionsByRotation: {} as Record<string, number> };

  let totalQuestions = 0;
  const questionsByRotation: Record<string, number> = {};

  function loadJsonFiles(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        loadJsonFiles(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;

      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const questions = Array.isArray(raw) ? raw : [raw];

      for (const q of questions) {
        if (!q.id || !q.stem || !q.options) continue;
        totalQuestions++;
        const rot = q.rotation || 'unknown';
        questionsByRotation[rot] = (questionsByRotation[rot] || 0) + 1;
      }
    }
  }

  // First pass: count
  loadJsonFiles(bankDir);

  // Second pass: upsert
  async function upsertJsonFiles(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await upsertJsonFiles(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;

      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const questions = Array.isArray(raw) ? raw : [raw];
      const sourceFile = path.relative(process.cwd(), fullPath);

      for (const q of questions) {
        if (!q.id || !q.stem || !q.options) continue;

        await prisma.question.upsert({
          where: { id: q.id },
          update: {
            stem: q.stem,
            options: q.options,
            context: q.context ?? null,
            rotation: q.rotation,
            week: q.week ?? null,
            topics: q.topics ?? [],
            source: 'question-bank',
            sourceFile,
            questionType: q.questionType ?? 'diagnosis',
            difficulty: q.difficulty ?? 'medium',
          },
          create: {
            id: q.id,
            stem: q.stem,
            options: q.options,
            context: q.context ?? null,
            rotation: q.rotation,
            week: q.week ?? null,
            topics: q.topics ?? [],
            source: 'question-bank',
            sourceFile,
            questionType: q.questionType ?? 'diagnosis',
            difficulty: q.difficulty ?? 'medium',
          },
        });
      }
    }
  }

  await upsertJsonFiles(bankDir);
  return { totalQuestions, questionsByRotation };
}

// ─── Guest User ───────────────────────────────────────────────────

async function ensureGuestUser() {
  const existing = await prisma.user.findFirst({ where: { name: 'Guest' } });
  if (existing) {
    // Set default exam date if not already set
    if (!existing.examDate) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { examDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      });
    }
    return existing.id;
  }

  const user = await prisma.user.create({
    data: {
      name: 'Guest',
      examDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return user.id;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('Seeding MD3 Open database...\n');

  // 1. Cards from MDX
  console.log('Extracting cards from MDX content:');
  const { totalCards, upsertedCards } = await seedCards();
  console.log(`\n  Total: ${totalCards} cards extracted, ${upsertedCards} upserted\n`);

  // 2. Question bank
  console.log('Loading question bank:');
  const { totalQuestions, questionsByRotation } = await seedQuestions();
  console.log(`  Total: ${totalQuestions} questions upserted`);
  for (const [rotation, count] of Object.entries(questionsByRotation)) {
    console.log(`    ${rotation}: ${count} questions`);
  }
  console.log();

  // 3. Guest user
  const guestId = await ensureGuestUser();
  console.log(`Guest user: ${guestId}\n`);

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
