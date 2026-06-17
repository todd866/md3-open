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

## Build your own (LE + MD3 stack)

**Use [md3.info](https://md3.info) if you want.** It's the hosted convenience tier — log in, study, done. But it is *just* the convenience tier. The thing that actually matters is open and in this repo: the authoring stack that turns primary medical literature into graded, cited, spaced-repetition curriculum. The hosted site is the operational demo and the dogfood; this repo is the stack. You can run the whole thing yourself.

### Why this is designed to be rebuilt, not reused

The durable part of this kit is **not** the implementations — it's the data contracts in [`src/lib/authoring/contracts.ts`](src/lib/authoring/contracts.ts). Those types (`AuthoringCard`, `AuthoringQuestion`, `QualityIssue`, `QualityVerdict`, `EvidencePack`, `SourceRef`, `GroundingResult`, …) are the stable API. The code behind each pipeline stage is *reference code* — fork it, or hand it to Claude Code and have it rebuilt for your stack, in your language. The pipeline already spans Python tools (PaperLibrary, LocalEvidence, paperscope) and TypeScript libs; Claude Code is meant to stitch across that seam for you. Legibility over cleverness, intent docs over magic. That's the point.

### The authoring pipeline

```
SOURCE          GROUND               GENERATE        QUALITY-GATE        STRUCTURE          AUDIT
PaperLibrary    LocalEvidence        source→draft    length-bias /       complexity /       verify card
ImageLibrary →  retrieval +      →   cards       →   format-asymmetry →  C1-scaffold /   →  claims against
content_lake    paperscope                           guessability /      curriculum /       evidence
                validity                              cloze + distractor  citations
```

In this repo, the database-free, dependency-light core of the GENERATE / QUALITY-GATE / STRUCTURE stages lives under [`src/lib/authoring/`](src/lib/authoring/):

| Subdir | What it does |
|--------|--------------|
| `generate/` | Extract draft cards from MDX/source; split multi-blank cloze; MCQ→cloze conversion; card validators |
| `quality/` | The bias gates — length-bias, format-asymmetry, option guessability, cloze-span and distractor quality |
| `structure/` | Complexity/difficulty estimation, curriculum parsing, citation reference parsing |

The SOURCE / GROUND / AUDIT stages are where you bring your own corpus: [LocalEvidence](https://github.com/todd866/LocalEvidence) does grounded retrieval over your own PDF library, and the LE→card transform mints curriculum that is cited back to the passages it came from.

### Spool up your own (Claude-Code-orchestrated)

The fastest path is to let Claude Code drive it. Open this repo in Claude Code and follow `CLAUDE.md` — it's written as the orchestration runbook for standing the stack up and wiring LocalEvidence to the card transform. Manually, the steps are:

```bash
# 1. Clone and bring up the app + Postgres (see Quick Start above)
git clone https://github.com/todd866/md3-open
cd md3-open
createdb md3_open
cp .env.example .env
npm install
npx prisma db push
npm run dev            # app on http://localhost:3000

# 2. Run LocalEvidence alongside, on :8765
#    (separate repo — grounded retrieval over YOUR corpus)
#    LE exposes POST /api/ask and POST /api/verify-evidence
LOCALEVIDENCE_PASSAGES=~/Projects/LocalEvidence/data/passages \
  python3 -m localevidence serve     # listens on 127.0.0.1:8765

# 3. Warm a corpus — point LE at the PDFs you want graded curriculum from.
#    A warm corpus answers grounded questions in <5s.

# 4. Run the LE→card transform: ask LE clinical questions, take the
#    EvidencePack it returns (answer + cited passages), and run it through
#    the generate → quality-gate → structure stages in src/lib/authoring/.
#    The result is cards whose `cite` field points back at the evidence.
```

**Honest caveat about speed:** LocalEvidence is slow *only on a cold corpus* — the first time it sees a topic it may have to acquire and index PDFs, which can take a while. Once the corpus is warm, grounded answers come back in under five seconds, and curriculum generation is async anyway (you queue questions, cards land when they're ready). So the slowness is a one-time acquisition cost per topic, not a per-card cost. Warm the corpus for your rotation once, and the LE→card transform runs fast from then on.

### What "grounded" buys you

Every card minted through the GROUND stage carries a `cite` (see `AuthoringCard.cite` in the contracts) that traces back to a retrieved primary-literature passage, and the AUDIT stage can re-check a card's claim against that evidence (`GroundingResult`: `supported` / `contradicted` / `unsupported`, with a `gap` flag to distinguish a real defect from a corpus hole). That's the difference between "an LLM wrote some flashcards" and "curriculum you can trace to the literature it came from."

## License

MIT
