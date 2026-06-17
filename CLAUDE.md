# md3-open — intent & orchestration

This is the doc a fresh Claude Code instance should read first. It explains what
this repo *is*, how the card-authoring pipeline fits together, where the durable
seams are, and how to rebuild any stage for your own stack.

The product is the **intent**, not the implementation. Read this top-to-bottom
before changing anything; then treat the contracts as fixed and the code behind
them as reference you are free to fork, swap, or rewrite (even in another
language).

---

## 1. What md3-open is

md3-open is three things in one repo:

1. **An open study app.** A runnable Next.js + Postgres spaced-repetition app
   with cloze cards and MCQs, organised by clinical rotation and week. Clone it,
   bring up Postgres, seed the example content, and study. See `README.md` for
   the app tour (scheduler, MDX components, pages, API routes).
2. **A card-authoring kit.** A set of pure, dependency-light TypeScript modules
   under `src/lib/authoring/` that turn source material into high-quality study
   cards: generation, quality-gating, structuring, and grounding/audit. This is
   the part most worth forking.
3. **A rebuildable blueprint.** The repo is designed so that *you* can fork it
   and have Claude Code rebuild large parts for your own exam, corpus, or stack.
   The bet is legibility over cleverness: clear seams, intent docs, and pure
   functions you can read, copy, and re-implement.

### Relationship to md3.info

- **md3.info** is the hosted convenience tier: an operational demo, a dogfood
  instance, and the production codebase (auth, hardening, real corpora, real
  users). The conference paper in `paper/md3-paper.md` describes that system.
- **md3-open** is the *open companion*. It ports the LOGIC of the production
  authoring stack into DB-free, service-free reference modules and ships a
  simplified app to run them in. It is deliberately *not* the production
  codebase. Things you should expect to be simplified or absent here: real
  authentication, error handling, observability, and the institution-specific
  data (curricula, source registries, corpora) that production carries.

The whole point: anyone can fork md3-open and stand up their own stack.

---

## 2. The authoring pipeline

The pipeline is a linear flow with six stages. Source material becomes grounded,
quality-gated, structured cards.

```
SOURCE ──► GROUND ──► GENERATE ──► QUALITY-GATE ──► STRUCTURE ──► AUDIT
```

| Stage | What it does | Where it lives |
|-------|--------------|----------------|
| **SOURCE** | Pull raw material: PaperLibrary / ImageLibrary / a content lake / MDX files. | App-side / your data layer. MDX path: `src/lib/card-generator.ts`, `content/`. |
| **GROUND** | Retrieve supporting evidence (LocalEvidence retrieval) + validity signal (paperscope). Produces an `EvidencePack` — the curriculum seed. | `src/lib/authoring/grounding/` (the LE HTTP seam) |
| **GENERATE** | Turn a source/`EvidencePack` into draft cards: extract cloze cards, derive cloze from MCQs, split multi-blank cards, validate shape. | `src/lib/authoring/generate/` |
| **QUALITY-GATE** | Reject test-wise giveaways: length-bias, format-asymmetry, option guessability, cloze span defects, distractor quality. | `src/lib/authoring/quality/` |
| **STRUCTURE** | Estimate complexity (C1 scaffold vs hard), attach curriculum/topic structure, resolve citations. | `src/lib/authoring/structure/` |
| **AUDIT** | Verify each authored claim against retrieved evidence: supported / contradicted / unsupported (and is "unsupported" a defect or a corpus gap?). | `src/lib/authoring/grounding/` (verify seam) + `quality/` |

### What's in each authoring subdir

- **`generate/`** — `card-extractors.ts` (Q&A → cloze from MDX components),
  `mcq-to-cloze.ts` (derive a cloze reinforcement card from an MCQ),
  `split-cloze-variants.ts` (one-blank-at-a-time expansion),
  `card-validators.ts` (catch malformed/leaky/guessable cards before they ship).
- **`quality/`** — `validate-mcq.ts` (the MCQ gate battery: structure, length
  bias, format asymmetry, form opacity, letter-refs, calibration),
  `cloze-quality.ts` (bad-blank detection), `option-guessability.ts` (test-wise
  tells), `distractor-quality.ts` (distractor scoring + role taxonomy).
- **`structure/`** — `difficulty.ts` (heuristic complexity tier),
  `curriculum.ts` (load week topics / learning objectives from markdown),
  `cite.ts` (parse cite refs + resolve against a caller-supplied source registry).
- **`grounding/`** — the LocalEvidence seam: a thin HTTP client to LE's
  `/api/ask` (retrieve + synthesize an `EvidencePack`) and `/api/verify-evidence`
  (check a claim → `GroundingResult`). LE's corpus, vectors, and acquisition tier
  stay entirely on the LE side; only claim/answer TEXT crosses the boundary.

---

## 3. The seam contracts — the durable API

**`src/lib/authoring/contracts.ts` is the one stable thing in this repo. Read it
first and conform to it.**

Everything behind a stage is reference code meant to be forked and rebuilt. The
contracts are what stay constant across those rebuilds, so depend on the *shapes*,
not on any one function. The file imports nothing — no DB, no Next.js, no
service — so it can be read, copied, and re-implemented anywhere (including in
another language).

The contract types and the seam each one guards:

| Type | Seam |
|------|------|
| `AuthoringCard`, `AuthoringQuestion`, `AuthoredItem` | the authored unit every stage passes around |
| `Complexity`, `Importance` | structuring tiers (C1 scaffold = 1) |
| `SourceRef`, `EvidencePassage`, `EvidencePack`, `EvidenceTier` | the GROUND seam (LocalEvidence output / curriculum seed) |
| `QualityIssue`, `QualityVerdict`, `QualityGate<T>` | the QUALITY-GATE seam (every gate is `(item) => QualityIssue[]`) |
| `GroundingResult`, `GroundingStatus` | the AUDIT seam (one claim checked against evidence) |

Two consequences worth internalising:

- A quality gate is **always** `QualityGate<T> = (item: T) => QualityIssue[]`.
  Add a check by writing another function of that shape and folding its issues
  into a `QualityVerdict` (`ok = false` iff any `block` issue is present). You do
  not need to touch the runner to add a gate.
- The GROUND and AUDIT stages exchange `EvidencePack` / `GroundingResult`. As
  long as your grounding implementation produces those shapes, the rest of the
  pipeline does not care whether the evidence came from LocalEvidence, a vector
  DB, a remote API, or a flat file.

**Do not edit `contracts.ts` or `index.ts` to make your code fit. Change your
code to fit them.** If a contract genuinely cannot express what you need, that is
a design conversation, not a quiet edit.

---

## 4. Rebuilding a stage with Claude Code

This is the intended workflow, not an afterthought. The repo exists so you can
do this. The rule is simple: **preserve the contracts, change everything else.**

The recipe for any rebuild:

1. Read `contracts.ts`. Identify the types your stage consumes and produces.
2. Read the current reference implementation in the relevant `authoring/`
   subdir to understand the *intent* (the file headers state what was kept and
   what was dropped from production, and why).
3. Rebuild the implementation however you like — different language, different
   model, different heuristics — as long as the inputs/outputs still match the
   contract types.
4. Verify the seam, not the internals: feed contract-shaped inputs, assert
   contract-shaped outputs.

Worked examples:

- **"Rebuild the scheduler for my exam."** The scheduler (`src/lib/scheduler.ts`)
  is four pure functions over numbers and dates — it is not part of the authoring
  contracts, so it is yours to replace wholesale (FSRS, SM-2, your own decay
  model). Authoring does not depend on it; cards flow into whatever scheduler the
  app uses.
- **"Swap the embedding / retrieval model."** Retrieval lives entirely behind the
  GROUND seam (LocalEvidence, in `grounding/`). Point the HTTP client at a
  different LE instance, or replace the client with your own retriever — as long
  as it returns an `EvidencePack`, GENERATE and AUDIT are unaffected. No
  embeddings code ships in this kit on purpose: it sits on the LE side of the
  seam.
- **"Re-implement the LE grounding step in my stack."** Keep the `EvidencePack`
  (GROUND output) and `GroundingResult` (AUDIT output) shapes. Everything between
  — corpus, vector space, acquisition, synthesis prompt — is free to change. You
  could implement grounding in Python and call it over HTTP, exactly as the
  reference does.
- **"Add a new quality check."** Write a `QualityGate<AuthoringQuestion>` (or
  `<AuthoringCard>`), add it to the gate battery, done. The verdict folding is
  generic.

What is **free to change**: heuristics, thresholds, language, models, the
scheduler, the app UI, the database, the source layer, prompts, retrieval.

What you **preserve**: the types in `contracts.ts` and the stage boundaries they
define.

---

## 5. Spool up the full LE + MD3 stack locally

The hosted product mints grounded curriculum by running LocalEvidence alongside
the app and transforming LE answers into cards. You can reproduce that locally.

### a. Bring up Postgres + the Next app

Follow `README.md`:

```bash
createdb md3_open
cp .env.example .env          # set DATABASE_URL if not using defaults
npm install
npx prisma db push
npm run seed                  # seed example rotation content
npm run dev                   # http://localhost:3000
```

### b. Run LocalEvidence as a service on :8765

LocalEvidence is a separate project (Ian's open-source evidence-retrieval engine).
Run it alongside the app:

```bash
# in the LocalEvidence checkout
python3 -m localevidence serve        # serves http://127.0.0.1:8765
```

It exposes two endpoints the authoring kit talks to:

- `POST /api/ask` — a clinical question in, a synthesized grounded answer +
  retrieved passages out (the raw material for an `EvidencePack`).
- `POST /api/verify-evidence` — a claim's text in, retrieved primary-literature
  evidence + a citation-provenance check out (the raw material for a
  `GroundingResult`).

The HTTP boundary is deliberate: LE's corpus, vector space, and acquisition tier
stay on the LE side, and nothing md3-specific crosses it. If LE is down, callers
should degrade gracefully rather than fail the build.

### c. Warm a corpus, then transform

- **Warm the corpus.** LocalEvidence is slow only on a **cold** corpus, because a
  miss triggers on-demand acquisition (fetch + index primary literature). Warm it
  by asking the questions for your curriculum once. After that, **warm-corpus
  answers return in under ~5 s**, and curriculum generation is async anyway.
- **Run the LE → card transform.** Point the GROUND stage at `:8765`, ask LE the
  curriculum questions to get `EvidencePack`s, run those through GENERATE →
  QUALITY-GATE → STRUCTURE, and AUDIT the drafts back through
  `/api/verify-evidence`. The result is grounded, gated, structured curriculum
  ready to upsert into the app's `Card` / `Question` tables.

The takeaway for "spool up your own": clone md3-open, run Postgres + the Next
app, run LocalEvidence next to it, warm a corpus for your exam, and the
LE → card transform mints grounded curriculum.

---

## 6. Conventions

- **TypeScript, path alias `@/` → `src/`.** Import contracts as
  `import type { ... } from "@/lib/authoring/contracts";`.
- **Pure and dependency-light.** Authoring modules operate on contract types and
  plain strings. No Prisma/Postgres, no Next.js, no embeddings/vector code, no
  cron, no auth, no network inside the pure modules (the one networked seam is
  `grounding/`, and that is an explicit HTTP client). Each file compiles as
  standalone TS with no unresolved imports. Prefer zero new npm deps.
- **Intentionally simplified posture.** This is a reference companion, not the
  production system. Auth, hardening, real corpora, observability, and
  institution-specific data are out of scope here — do not expect them, and do
  not add them speculatively. Each guest gets a cookie-based isolated account.
- **Read the file headers.** Every ported authoring module documents what it kept
  from production and what it dropped (and why) — that header is the rebuild
  brief for that stage.
- **Don't touch the assembly seams.** `src/lib/authoring/index.ts`,
  `src/lib/authoring/contracts.ts`, and `package.json` are assembled/owned
  centrally. Add stage implementations, not edits to those.

---

### One-line orientation for a fresh agent

> Read `src/lib/authoring/contracts.ts`. Treat it as fixed. The pipeline is
> SOURCE → GROUND → GENERATE → QUALITY-GATE → STRUCTURE → AUDIT, living under
> `src/lib/authoring/{grounding,generate,quality,structure}`. Rebuild any stage
> you like; just keep the contract shapes at its edges.
