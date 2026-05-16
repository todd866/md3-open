# MD3 Open

[![CI](https://github.com/todd866/md3-open/actions/workflows/ci.yml/badge.svg)](https://github.com/todd866/md3-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftodd866%2Fmd3-open&env=DATABASE_URL&envDescription=Postgres%20connection%20string%20(e.g.%20Neon%20free%20tier))

A simplified, MIT-licensed reference implementation of the spaced-repetition core that powers [md3.info](https://md3.info) — a personalised study tool used daily by a handful of medical students at the University of Sydney.

> Companion to a [write-up](paper/md3-paper.md) on the system's design, AI-assisted development process, and what six weeks of dogfooded iteration looks like. The original April version (prepared for the Macquarie AI in Medicine Symposium) is preserved at [paper/archive/](paper/archive/). The full production system is private; this repo extracts the architecture and core algorithms into a form that's readable and runnable for personal use.

## What this is (and isn't)

**Is:** the spaced-repetition scheduler, MDX content pipeline, cloze-card extractor, MCQ component, and review session UI — enough to demonstrate the approach and to fork as a starting point for similar tools.

**Isn't:**
- The production system. Auth, error handling, error tracking, scheduler complexity, and test coverage are all intentionally trimmed.
- Up to date with `md3.info`. This snapshot is from April 2026; the production codebase has since added an embedding-aware manifold scheduler, a deliberate-teaching layer, empirical-difficulty calibration, ~9 daily audit pipelines, and roughly 4× the test coverage. None of that complexity is needed to demonstrate the core idea.
- A general-purpose framework. Built for one curriculum (USyd Year 3 clinical rotations), one user, one set of design constraints.

## Quick start

```bash
git clone https://github.com/todd866/md3-open.git
cd md3-open
createdb md3_open
cp .env.example .env                 # default DATABASE_URL works for local
npm install
npx prisma db push
npm run seed                         # one example rotation, 3 MDX files
npm run dev
```

Visit `http://localhost:3000`. Each browser session gets its own cookie-based guest account with isolated progress.

## Architecture

```
MDX files (content/)              Question bank JSON (question-bank/)
        ↓                                       ↓
   card-generator.ts                       seed.ts
        ↓                                       ↓
   Card table  ←──────── PostgreSQL ────→  Question table
        |                                       |
        └─────── Review Session API ────────────┘
                        ↓
              Spaced Repetition
                (scheduler.ts)
```

## Scheduling

Stability-based spaced repetition with power-law memory decay:

```
R(t) = R₀ × (1 + t/S)^(-0.5)
```

- `R(t)` = retrieval probability at time `t` (days since last review)
- `R₀` = retrieval strength immediately after review (0..1)
- `S` = stability (days — the memory half-life)
- A card becomes "due" when `R(t)` drops below threshold (default 0.4)

Four pure functions in `src/lib/scheduler.ts` (~164 lines):

| Function | Role |
|---|---|
| `calculateDecayedStrength` | Compute current recall probability from `(R₀, S, days_elapsed)` |
| `updateStabilityDays` | Grow/shrink memory half-life after a review outcome |
| `updateRetrievalStrength` | EMA blend of prior strength and review outcome |
| `computeNextDueAt` | Solve the decay equation for the next due date |

Daily-target calculation (`src/lib/study/daily-target.ts`) takes `unseenItems`, `daysToExam`, and the user's recent pace; returns `max(coverageNeed, paceFloor)` — a target that rises when curriculum demands more than current pace, falls when ahead.

## Key files

| File | Purpose |
|---|---|
| `src/lib/scheduler.ts` | The four pure-function scheduler primitives |
| `src/lib/mastery.ts` | Card mastery detection + graduation |
| `src/lib/card-generator.ts` | MDX parsing → cloze card extraction |
| `src/lib/study/daily-target.ts` | Exam-aware daily target |
| `src/lib/review/record-card-review.ts` | Atomic progress update on review |
| `src/components/content/MCQ.tsx` | MCQ with option shuffling + per-option explanations |
| `src/components/content/InlineCloze.tsx` | Tappable cloze blanks in MDX content |
| `src/app/review/page.tsx` | Full review session with progress drawer + flagging |
| `prisma/schema.prisma` | User / Card / CardProgress / Question / Response |

## MDX components

Content authored in MDX with custom components:

| Component | Generates |
|---|---|
| `<KeyPoint>` | Cloze card (`**Q:** ... [___] ... **A:** answer`) with optional `context` teaching text shown after review |
| `<Mnemonic>` | Memory aid; bold-term extraction generates additional cloze cards |
| `<ClinicalPearl>` | Teaching content rendered inline + scaffolding cards |
| `<Danger>` | Safety-critical warnings rendered with emphasis |
| `<MCQ>` | Interactive multi-option question with per-option explanations |

Cloze cards use `[___]` blanks paired with bold answers — see `content/example-rotation/week-1.mdx`.

## Stack

- **Next.js 16** (App Router) + MDX
- **Prisma 6** + PostgreSQL
- **Tailwind CSS 4**
- **Zod** for runtime validation
- **Vitest** for tests (34 tests across `scheduler.test.ts` + `daily-target.test.ts`)

## Pages

| Route | What it does |
|---|---|
| `/` | Welcome + architecture overview |
| `/content` | Week grid with card counts and coverage stats |
| `/review` | Review session with cards, MCQs, progress drawer, flagging |
| `/profile` | Stats, streak, 7-day activity, exam date config |
| `/example-rotation/week/[n]` | MDX content pages |

## What's in production but not here

The live `md3.info` adds substantial layers that aren't useful for understanding the core idea:

| Layer | Approximate scope |
|---|---|
| Embedding-aware manifold scheduler | Every card/question/concept embedded via Gemini II 3072D; priority = `gapScore + confidenceBoost + staleBoost + gapAlignmentBoost + likedBoost + recentFailureBoost` weighted by exam pressure |
| Deliberate teaching layer | Naive concepts get scaffold-before-test; failed concepts get +25% priority boost on next batch; strong-but-pristine concepts get un-starved from the weak-concept filter |
| Empirical difficulty calibration | Nightly cron computes `Card.facilityIndex` from cross-user grades; bulk-relabel script re-tiers complexity when label disagrees with empirical |
| Audit infrastructure | ~9 distinct daily diagnostics (pipeline-preview, scheduler-health, complexity-calibration, embedding-coverage, embedding-consumption, qa-comparison, systemic-flag drain, etc.) — bigger codebase than the user-facing app |
| Morning-check loop | Contractual `CLAUDE.md` playbook turns AI-agent maintenance into a forcing function — diagnostic → fix → commit → verify, with per-run logs in `audit/morning-check/runs.jsonl` |

These accreted over months of dogfooding. The skeleton here is what was true and useful at the start.

## License

MIT. Content in `content/` is original example material written for this demo — not derived from third-party clinical sources. The production `md3.info` content (lectures, textbook summaries) is intentionally not included since it isn't ours to redistribute.

## Contact

Ian Todd — Year 3 MD student, USyd. Open to questions about the design via GitHub Issues.
