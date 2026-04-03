# MD3 Open

Open-source medical education platform with spaced repetition scheduling, interactive cloze-deletion cards, and MCQ assessment.

> **Note**: This is a simplified, open-source companion to [md3.info](https://md3.info), released alongside a [conference paper](paper/md3-paper.md) presented at the Macquarie University AI in Medicine Symposium (May 2026). It demonstrates the architecture and core algorithms of the production system in a form that's readable and runnable for personal use. It is not the production codebase — authentication, error handling, and test coverage are intentionally simplified. Each visitor gets their own cookie-based guest account with isolated progress.

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL (local or remote)

### Setup

```bash
# 1. Create the database
createdb md3_open

# 2. Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL if not using defaults

# 3. Install dependencies
npm install

# 4. Push schema to database
npx prisma db push

# 5. Seed with example content
npm run seed

# 6. Start development server
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

## Architecture

### Content Pipeline

```
MDX files (content/)          Question bank JSON (question-bank/)
        |                                |
    card-generator.ts               seed.ts
        |                                |
        v                                v
   Card table  ←──── PostgreSQL ────→  Question table
        |                                |
        └──── Review Session API ────────┘
                      |
              Spaced Repetition
              (scheduler.ts)
```

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/scheduler.ts` | 4 pure functions: decay, stability, strength, next-due (~164 lines) |
| `src/lib/mastery.ts` | Card mastery detection and graduation |
| `src/lib/card-generator.ts` | MDX parsing and cloze card extraction |
| `src/lib/study/daily-target.ts` | Exam-aware daily study target calculation |
| `src/lib/review/record-card-review.ts` | Core review recording with atomic progress update |
| `src/components/content/MCQ.tsx` | Interactive MCQ with shuffling and per-option explanations |
| `src/components/content/InlineCloze.tsx` | Tappable cloze blanks in content |
| `src/app/review/page.tsx` | Full review session UI with progress drawer and flagging |
| `src/app/content/page.tsx` | Content browser with coverage stats |
| `src/app/profile/page.tsx` | Study stats, streak, activity chart, exam date config |
| `prisma/schema.prisma` | Database schema (User, Card, CardProgress, Question, etc.) |

### Scheduling Model

The scheduler uses **stability-based** spaced repetition with power-law memory decay:

```
R(t) = R₀ × (1 + t/S)^(-0.5)
```

Where:
- `R(t)` = retrieval probability at time `t`
- `R₀` = strength immediately after review
- `S` = stability (days — the memory half-life)
- A card becomes "due" when `R(t)` drops below threshold (0.4)

Four pure functions in `scheduler.ts`:
1. **calculateDecayedStrength** — current recall probability
2. **updateStabilityDays** — grow/shrink memory half-life after review
3. **updateRetrievalStrength** — EMA blend of prior + review outcome
4. **computeNextDueAt** — solve decay equation for due date

### MDX Components

Content is authored in MDX with these custom components:

- `<KeyPoint>` — Key facts with optional cloze cards (`**Q:**` / `**A:**`)
- `<Mnemonic>` — Memory aids with bold-term extraction
- `<ClinicalPearl>` — Clinical wisdom
- `<Danger>` — Safety-critical warnings
- `<MCQ>` — Multiple choice questions with per-option explanations

Cloze cards use `[___]` blanks paired with `**bold answers**` that become interactive tap-to-reveal elements.

### Stack

- **Next.js 16** — App Router with MDX support
- **Prisma** — Type-safe database client
- **PostgreSQL** — Relational database
- **Tailwind CSS 4** — Styling with MD3 design tokens
- **Zod** — Runtime validation

### Pages

| Route | What it does |
|-------|--------------|
| `/` | Welcome page with architecture overview |
| `/content` | Week grid with card counts and coverage stats |
| `/review` | Review session with cards, MCQs, progress drawer, flagging |
| `/profile` | Study stats, streak, 7-day activity chart, exam date setting |
| `/example-rotation/week/[n]` | MDX content pages (browsable) |

## Scripts

```bash
npm run dev        # Development server
npm run build      # Production build
npm run seed       # Seed database from content
npm run test:run   # Run tests (34 tests)
```

## License

MIT
