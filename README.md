# MD3 Open

[![CI](https://github.com/todd866/md3-open/actions/workflows/ci.yml/badge.svg)](https://github.com/todd866/md3-open/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftodd866%2Fmd3-open&env=DATABASE_URL&envDescription=Postgres%20connection%20string%20(e.g.%20Neon%20free%20tier))

A simplified, MIT-licensed reference implementation of the spaced-repetition core that powers [md3.info](https://md3.info) — a personalised study tool used daily by a handful of medical students at the University of Sydney.

> Companion to a [write-up](paper/md3-paper.md) on the system's design, AI-assisted development process, and what six weeks of dogfooded iteration looks like. The original April version (prepared for the Macquarie AI in Medicine Symposium) is preserved at [paper/archive/](paper/archive/). The full production system is private; this repo extracts the architecture and core algorithms into a form that's readable and runnable for personal use.

## What this is (and isn't)

**Is:** the spaced-repetition scheduler, MDX content pipeline, cloze-card extractor, MCQ component, review session UI, and the evidence-grounded card-authoring kit ([`src/lib/authoring/`](src/lib/authoring/)) — enough to demonstrate the approach and to fork as a starting point for similar tools.

**Isn't:**
- The production system. Auth, error handling, error tracking, scheduler complexity, and test coverage are all intentionally trimmed.
- Up to date with `md3.info`. The scheduler / content / review core is the April 2026 skeleton; the card-authoring kit (`src/lib/authoring/`) was open-sourced later (June 2026) as the standalone authoring stack. Production has since grown an embedding-aware manifold scheduler, a deliberate-teaching layer, empirical-difficulty calibration, ~9 daily audit pipelines, and roughly 4× the test coverage — none of which is needed to demonstrate the core idea (see "What's in production but not here" below).
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
- **Prisma 7** + PostgreSQL
- **Tailwind CSS 4**
- **Zod** for runtime validation
- **Vitest** for tests (the scheduler/daily-target core plus the authoring-kit suites under `src/lib/authoring/`)

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
# 1. Bring up the app + Postgres. Either:
#
#  (a) Docker — one command, no local Postgres needed:
git clone https://github.com/todd866/md3-open
cd md3-open
docker compose up --build                    # app on http://localhost:3000
docker compose run --rm app npm run seed     # load example content (once)
#
#  (b) Native — bring your own Postgres:
#   createdb md3_open && cp .env.example .env && npm install
#   npx prisma db push && npm run seed && npm run dev

# 2. Run LocalEvidence alongside, on :8765
#    (separate repo — grounded retrieval over YOUR corpus)
#    LE exposes POST /api/ask and POST /api/verify-evidence
LOCALEVIDENCE_PASSAGES=~/Projects/LocalEvidence/data/passages \
  python3 -m localevidence serve     # listens on 127.0.0.1:8765
#    (docker-compose.yml has a commented `localevidence` service block to run
#     it on the same compose network instead.)

# 3. Warm a corpus — point LE at the PDFs you want graded curriculum from.
#    A warm corpus answers grounded questions in <5s.

# 4. Run the LE→card transform: ask LE clinical questions, take the
#    EvidencePack it returns (answer + cited passages), and run it through
#    the generate → quality-gate → structure stages in src/lib/authoring/.
#    The result is cards whose `cite` field points back at the evidence.

# 5. Bulk-seed from an LE ledger: point the seed at a LocalEvidence
#    ledger/answers.jsonl and grounded cards land in the DB on the next seed.
LE_LEDGER_PATH=~/Projects/LocalEvidence/ledger/answers.jsonl npm run seed
#    LE cards land under the `localevidence` rotation by default; set
#    LE_ROTATION=<your-rotation> to tag them for an existing rotation/UI.
#    The card TEXT comes from an AuthorFn. The default is a deterministic
#    placeholder (wiring/tests only); for real cards supply one — e.g. the
#    reference Claude author in src/lib/authoring/grounding/author-claude.ts
#    (`evidencePackToItemsWithClaude`, needs ANTHROPIC_API_KEY), or have your
#    Claude Code orchestrator phrase the drafts directly.
```

**Honest caveat about speed:** LocalEvidence is slow *only on a cold corpus* — the first time it sees a topic it may have to acquire and index PDFs, which can take a while. Once the corpus is warm, grounded answers come back in under five seconds, and curriculum generation is async anyway (you queue questions, cards land when they're ready). So the slowness is a one-time acquisition cost per topic, not a per-card cost. Warm the corpus for your rotation once, and the LE→card transform runs fast from then on.

### What "grounded" buys you

Every card minted through the GROUND stage carries a `cite` (see `AuthoringCard.cite` in the contracts) that traces back to a retrieved primary-literature passage, and the AUDIT stage can re-check a card's claim against that evidence (`GroundingResult`: `supported` / `contradicted` / `unsupported`, with a `gap` flag to distinguish a real defect from a corpus hole). That's the difference between "an LLM wrote some flashcards" and "curriculum you can trace to the literature it came from."

## License

MIT. Content in `content/` is original example material written for this demo — not derived from third-party clinical sources. The production `md3.info` content (lectures, textbook summaries) is intentionally not included since it isn't ours to redistribute.

## Contact

Ian Todd — Year 3 MD student, USyd. Open to questions about the design via GitHub Issues.
