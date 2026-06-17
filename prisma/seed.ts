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
import { readLedgerLines, evidencePackToItems } from '../src/lib/authoring/grounding/le-to-cards';

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
      // Scope to MDX cards only — LocalEvidence cards (le: prefix) are swept
      // separately by seedLeCards(), so this must not retire them.
      stableId: { startsWith: 'mdx:', notIn: [...allCurrentStableIds] },
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

// ─── LocalEvidence Card Seeding ───────────────────────────────────
//
// Ingest grounded answers from a LocalEvidence ledger (answers.jsonl) as
// curriculum: each answered entry becomes a C1 cloze + a C2 MCQ via the
// authoring kit's le-to-cards transform. Gated on LE_LEDGER_PATH — unset or
// missing means this is a no-op, so the seed works fine without LocalEvidence.
//
// The default (passthrough) author yields PLACEHOLDER card text — enough to wire
// the pipeline end to end. For real cards, pre-author the ledger with a
// Claude-backed AuthorFn (see src/lib/authoring/grounding/author-claude.ts).

function complexityToDifficulty(complexity: number): string {
  return complexity <= 1 ? 'easy' : complexity >= 3 ? 'hard' : 'medium';
}

async function seedLeCards() {
  const ledgerPath = process.env.LE_LEDGER_PATH;
  if (!ledgerPath || !fs.existsSync(ledgerPath)) {
    console.log(
      ledgerPath
        ? `  LE ledger not found at ${ledgerPath} — skipping LocalEvidence cards.`
        : '  LE_LEDGER_PATH not set — skipping LocalEvidence cards.',
    );
    return { leCards: 0, leQuestions: 0 };
  }

  const rotation = process.env.LE_ROTATION || 'localevidence';
  const sourceFile = path.relative(process.cwd(), ledgerPath);
  const seenCardIds = new Set<string>();
  let leCards = 0;
  let leQuestions = 0;

  for (const { id, pack } of readLedgerLines(ledgerPath)) {
    for (const item of evidencePackToItems(pack, { id })) {
      if (item.cardType === 'cloze') {
        const stableId = item.stableId!;
        const context = item.cite
          ? `${item.context ?? ''}\n\nSource: ${item.cite}`.trim()
          : item.context;
        await prisma.card.upsert({
          where: { stableId },
          update: {
            front: item.front, back: item.back, backs: item.backs ?? undefined,
            context, topics: item.topics, complexity: item.complexity,
            sourceFile, sourceComponent: 'LocalEvidence', week: null,
          },
          create: {
            stableId, cardType: 'cloze', rotation, week: null,
            sourceFile, sourceComponent: 'LocalEvidence',
            front: item.front, back: item.back, backs: item.backs ?? undefined,
            context, topics: item.topics, complexity: item.complexity,
          },
        });
        seenCardIds.add(stableId);
        leCards++;
      } else {
        const qid = item.stableId!;
        // Normalise to plain JSON (strips any `undefined` so Prisma's Json field accepts it).
        const options = JSON.parse(JSON.stringify(item.options));
        await prisma.question.upsert({
          where: { id: qid },
          update: {
            stem: item.stem, options, context: item.explanation ?? null,
            rotation, week: null, topics: item.topics, source: 'localevidence',
            sourceFile, questionType: 'diagnosis',
            difficulty: complexityToDifficulty(item.complexity),
          },
          create: {
            id: qid, stem: item.stem, options, context: item.explanation ?? null,
            rotation, week: null, topics: item.topics, source: 'localevidence',
            sourceFile, questionType: 'diagnosis',
            difficulty: complexityToDifficulty(item.complexity),
          },
        });
        leQuestions++;
      }
    }
  }

  // Scoped soft-delete: retire LE cards (le: prefix) no longer in the ledger.
  if (seenCardIds.size > 0) {
    const retired = await prisma.card.updateMany({
      where: { stableId: { startsWith: 'le:', notIn: [...seenCardIds] }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (retired.count > 0) {
      console.log(`  Soft-deleted ${retired.count} LE cards no longer in the ledger`);
    }
  }

  return { leCards, leQuestions };
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

  // 2b. LocalEvidence grounded cards (optional — gated on LE_LEDGER_PATH)
  console.log('Loading LocalEvidence cards:');
  const { leCards, leQuestions } = await seedLeCards();
  if (leCards || leQuestions) {
    console.log(`  Total: ${leCards} LE cards, ${leQuestions} LE questions`);
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
