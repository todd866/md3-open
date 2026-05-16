# MD3 (revised): six weeks of dogfooded scheduler + audit work

**Ian Todd**
Year 3 Medical Student, Sydney Medical School, University of Sydney
*2026-05-16. Revises `archive/2026-05-md3-paper.md` (2026-04-05).*

---

## Abstract

The original MD3 paper (April 2026) described a spaced-repetition platform built by one medical student using AI coding tools. Six weeks of continued dogfooding has produced three substantive additions worth documenting: (a) an embedding-aware manifold scheduler that incorporates per-concept teaching states into ranking, (b) a layer of daily audit infrastructure that surfaces silent failures the user-facing app can't, and (c) a "morning check" agent-maintenance loop that turned AI-assisted iteration into a forcing function. This revision adds those layers, the bugs that motivated them, and a critical look at the limits of the build process. The open-source companion repo (`md3-open`) remains a simplified snapshot of the original April architecture; production additions are described here but intentionally not folded back.

---

## 1. What this revision covers

The April paper described a working system: stability-based scheduler, MDX content pipeline, ~10 weeks of build time, two clinical rotations completed. It implicitly framed the platform as approaching steady state.

Six weeks of further use (May 2 to mid-May, spanning a Block 2 exam and the start of a research-block study window for Blocks 3 + 4) made clear that the harder problem wasn't "build the platform" — it was "trust that the platform is doing what we think." Three layers of work followed:

1. **A genuine scheduler.** The April version sorted by stability decay. The May version walks an embedding manifold, with a per-concept teaching-state classifier governing how each concept gets treated this session.
2. **Audit infrastructure.** Roughly nine distinct daily diagnostics that read the production database and report what the deployed scheduler is actually doing — vs. what we'd hope it's doing. Most of the bugs found in May were silent until the audits flagged them.
3. **A morning-check loop.** Contractual instructions in `CLAUDE.md` that make AI-assisted daily maintenance a forcing function. Each session must close at least one diagnostic-surfaced gap; runs are logged to `audit/morning-check/runs.jsonl` so the loop's own behaviour is queryable.

Sections 2–4 below describe what changed. Section 5 covers what broke (and how the audits caught it). Section 6 is an honest reckoning with the build process.

---

## 2. Manifold-aware scheduler

### 2.1 Why "manifold-aware" matters

The April scheduler ordered cards by `stability × decay × confidence`. Items with similar decay scores were effectively interchangeable; the scheduler picked one and moved on.

This misses the structural point of clinical content: cards aren't independent. A question about septic-shock vasopressors and a card on noradrenaline mechanism are *closely related* in concept space; serving them adjacent reinforces; serving them weeks apart wastes the connection. Conversely, two cards on unrelated rare conditions look identical to a decay scheduler but should not be adjacent.

The fix is to embed every card, question, and concept in a shared 3072-dimensional vector space (Gemini Embedding II, halfvec stored via pgvector), then compute a "gap direction" per session:

```
gapDirection = examTargetCentroid − userKnowledgeVector
```

The exam-target centroid is the weighted mean of embeddings for items likely to appear on the upcoming exam (anchored to past KAT papers, exam-blueprint material, and recently-flagged concepts). The user knowledge vector is the weighted mean of items they've recently demonstrated retention on. The gap direction points from "what they know" toward "what they need to know."

A concept's priority then includes a `gapAlignmentBoost` term:

```
boost = max(0, cosineSimilarity(conceptEmbedding, gapDirection)) × (0.15 + examPressure × 0.15)
```

Concepts aligned with the gap get up to a 30% priority lift; orthogonal ones get nothing. The Math.max(0, ...) clamp ensures anti-aligned concepts don't *negatively* affect priority — they just don't get the boost.

### 2.2 Teaching-state classifier

Per-concept teaching state is derived from `(exposureCount, recallOnExamDay, confidence)`:

| State | Trigger | Treatment |
|---|---|---|
| `naive` | `exposureCount === 0` | Pre-teach: inject a complexity-1 scaffold *before* any test pressure (no cold-test on first encounter) |
| `learning` | seen but `recallOnExamDay < 0.5` | Bridge card + multi-format probing; failed-concept escalation boosts priority for the next batch |
| `consolidating` | mid-band recall | Cross-format probing — different question shapes for the same concept |
| `mastered` | high recall AND high confidence | One maintenance touch per session, then move on |

The "fragile mastery" guard matters: a concept with `recall = 0.92` but `confidence = 0.4` (small sample, recent volatility) stays in `consolidating`, not `mastered`. The classifier exists at `src/lib/scheduler/concept-teaching-state.ts`; it's a pure function tested in isolation.

The integration into the scheduler enforces per-concept item caps:
- `mastered` concepts cap at 1 item per session
- `naive` at 2 (the pre-teach + one gentle probe)
- `learning` and `consolidating` at 3

Before this, the scheduler treated all weak concepts uniformly with a single `HARD_MAX_CARDS_PER_CONCEPT = 3` ceiling. Mastered concepts ate slots they didn't need; learning concepts went under-served when many were active. Per-state caps redistribute the budget.

### 2.3 Failure escalation

A separate concern: when the user fails a card or MCQ (quality < 3, or `isCorrect = false`), the *next* batch fetch should surface the same concept again for remediation. The April scheduler had no such mechanism — failures just lowered the concept's recall, which slowly shifted its priority over many subsequent sessions.

The current version queries `CardProgress` and `QuestionResponse` for failures within the last 2 hours, builds a `recentFailureConceptIds` set, and adds `+0.25` to the priority sum for concepts in it. This shows up as a re-surfacing pattern: fail item N, next batch leads with the same concept's scaffolding.

### 2.4 Strong-but-pristine un-starve

A subtler failure mode: a concept with `recall ≥ 0.8` (deemed strong) might still have hundreds of cards the user has never seen. The April scheduler filtered such concepts out of the round-robin; coverage-lane reservation only allocated ~2 slots per session. Over a 7-week rotation this meant 600+ pristine cards on a "strong" concept stayed unreachable.

The fix extends the filter: concepts that are strong-by-recall but pristine-by-content (some unseen items exist) re-enter the weak-set, with their priority naturally damped by the existing `recallSoftPenalty`. They surface at low rates that compound over the rotation rather than getting indefinitely deferred.

---

## 3. Audit infrastructure

The April paper mentioned "QA scripts" briefly. The May system has nine distinct daily diagnostics that read production state and report on it:

| Script | What it answers |
|---|---|
| `audit:walk` | For each session, did the manifold walk produce a coherent path? Pathology flags: coherence, diversity, calibration, recovery |
| `audit:systemic` | What's the open content-issue queue, and is it draining or growing? |
| `qa:compare` | Predicted-vs-actual flag agreement. Predicts which cards Ian will flag; reports hit/false-positive/false-negative |
| `audit:pipeline-preview` | What's the user about to be served, and is any of it flagged? Pre-emptive content fix-list |
| `audit:scheduler-health` | Per-user: distribution of `interventionReason`, `predictedRecall`, `priority`; manifold-walk share of decisions |
| `audit:complexity-calibration` | Per-card: does the author-assigned C1/C2/C3 label match empirical accuracy? |
| `audit:embedding-coverage` | Per-rotation: what fraction of cards/questions actually have embeddings? |
| `audit:embedding-consumption` | Are embeddings being *used*, not just present? Distribution of `priority` values, `conceptId` hit rate |
| `snapshot:facility` | Daily per-card facility snapshot for trajectory tracking |

Each writes a `.md` for human reading and appends a `.jsonl` snapshot for trend analysis. The daily snapshot files are append-only, version-controlled in `audit/`, and queryable with `jq`.

The audit infrastructure is larger than the user-facing app. Most days it surfaces 1–3 actionable items; the morning-check loop (Section 4) makes those items the day's work.

### 3.1 What audits caught that nothing else would

A representative sample from the past six weeks:

- **The PAAM complexity-calibration anomaly.** 730 cards had author-label/empirical mismatch; 655 were in PAAM, 608 were C1 cards empirically testing as C2 or harder. Root cause: the seed-time complexity heuristic defaulted short-answer KeyPoints to C1 ("trivial recall"), but psychiatry content has lots of short-answer cards that test specific clinical facts (definitions, thresholds, agent names) — exactly the C2 band. A bulk re-label brought actionable mismatches to zero.

- **The ServeDecision.conceptId hydration bug.** 0 of 1,554 ServeDecision rows over a week had `conceptId` populated. The scheduler picked items by concept; the hydration step that turned scheduler shapes into UI shapes dropped the field; downstream analytics that grouped by concept all returned empty. A one-line fix in three places. The audit was the only signal.

- **The embedding-coverage drift.** The last full embedding run was 2026-04-18. By 2026-05-16 we'd added several thousand cards (PWH at 3% coverage, CAH at 16%, year3-common at 6%). The scheduler's similarity-driven walk operates on the embedding manifold; cards without embeddings are *invisible* to it. A backfill restored coverage above 99% across the board.

- **The interventionReason analytics-lying bug.** Per-item `interventionReason` (e.g., `pre_teach_naive`, `weak_recall`) was being dropped in the ServeDecision write path; the row stored the pathway name (`manifold-walk`) instead. Scheduler-health analytics showed 100% `manifold-walk` even though the deliberate-teaching layer was firing. One line in `serve-decision-write.ts`: prefer `item.interventionReason` over `ctx.queueReason`.

Each bug was silent. None showed up in user-facing behaviour (the items being served were still reasonable). Each was caught the morning after by an audit script comparing what should be present against what was.

---

## 4. Morning-check loop

The interaction model has crystallized around a daily ritual that runs through 13 steps:

1. Site health (200 OK)
2. Usage stats
3. Scaffold gaps
4. Walk audit (today, Ian's own session)
5. Walk audit (weekly, Mondays only — all users)
6. Systemic flag queue
7. QA prediction loop
8. Pipeline preview — what's about to be served
9. Scheduler health
10. Complexity calibration
11. Embedding coverage + consumption
12. Daily snapshots
13. Canvas + report

The contract in `CLAUDE.md` is explicit:

> Morning check is not complete until you have made at least one of:
> - A commit fixing content surfaced by any diagnostic
> - A commit tightening a flag-detector that produced false positives
> - A DB operation correcting stale user state
> - A documented finding ("nothing actionable — here's why") with cited diagnostic output

The completion rule converted what had been a narration habit into a fix-the-thing habit. Without it, agent runs reliably produced "everything looks fine" summaries while the snapshot files showed the same deferrals accumulating across days.

The loop has its own metadata: `audit/morning-check/runs.jsonl` logs each run's signals, actions, deferrals, and preflight gate results. Auto-derived fields (commit SHAs, snapshot deltas, the CLAUDE.md SHA at run-time) reduce the surface for skipped steps. The corpus is small enough (one row per day) that pattern recognition is straightforward at maybe 5–10 entries.

### 4.1 What the loop produces

A sample week of changes driven by morning checks:

- 706 cards bulk-relabeled to match empirical complexity (one structural fix replacing what would have been ~500 hand edits)
- A regex tightening in `scaffold-needs` that eliminated 1,689 false-positive scaffold gaps from auto-generated tag noise
- A `qa:predict` scoping change that dropped false-positives from 50 → 8 across two iterations
- A bug fix in `sync-actual-flags` that stopped counting flags on deleted cards (FN 28 → 7)
- An embedding pipeline cost guardrail (after a $47 video-embedding bill made the asymmetry visible)

Each was the result of a morning-check session where the contractual rule converted a noticed problem into a shipped fix within that session.

---

## 5. What this revision is honest about

The April paper's tone was confident. Six more weeks of dogfooding produced a sharper sense of what's actually true:

### 5.1 The build process is opinionated, not magical

The April paper's framing of "AI-assisted development" implied a smooth productivity multiplier. In practice the multiplier is high but conditional. The conditions:

- **Tight dogfooding.** Without using the platform every day, no amount of AI-generated code produces good software. The bug-discovery rate is proportional to the user-time, not the development-time.
- **Audit-loop discipline.** AI agents will cheerfully ship plausible-looking changes that don't quite work. The audit infrastructure was built specifically to prevent this — every "is X working?" question must have a script that answers it from data, not from confidence.
- **The contractual rule.** Without `CLAUDE.md`'s "morning check is not complete without an action" clause, agents reliably default to narration. The rule was added after several runs produced beautifully-formatted reports and zero commits.

The point isn't that AI is unreliable — it's that the *interaction shape* matters enormously. A loose loop produces loose work. A tight loop with forcing functions produces real iteration.

### 5.2 The N is still tiny

The April paper reported 68 active users / 8,483 review interactions. Six weeks later, the platform has roughly five daily-active users on a normal day. The acquisition story hasn't moved meaningfully; the development story has.

This bounds what can be claimed. Effects on exam performance can't be measured at this scale — Ian has one full data point (CC Block 1, 64%) and Sia has one (68%). The `ExamResult` table now exists for when N grows; for now the only outcome signal is "does the platform feel like it's helping its primary user" — answered by Ian's own use, not by data.

### 5.3 The economics still don't work

Niche audience (USyd-MD students, ~300 across all years), competing in the long shadow of UWorld and AMBOSS who own institutional content moats. Even at 100 paying users × $20/month, after Vercel + Neon + Gemini costs, the net would be hobby income.

The thing the AI tooling has actually changed is the threshold for "thing that exists at all." Most thoughtful software doesn't get built because it can't justify the team. With the audit infrastructure as the scaffolding, this can be built and maintained by one person who has other full-time obligations. The class of newly-possible projects is real even if the business class is not.

### 5.4 The complexity ladder is a load-bearing assumption

Several of the May fixes (the PAAM calibration, the empirical-difficulty pipeline, the naive-concept pre-teach) depend on author-assigned C1/C2/C3 labels being roughly accurate. They aren't. The audit catches the worst offenders (~150 C1 cards labeled scaffold but empirically tier-3), but the harder cases — cards where the *label is right* but the *item doesn't do what the label promises* — remain unflagged. A C1 that everyone gets right but only because the format leaks the answer is a different bug than a mislabel; nothing currently surfaces it.

---

## 6. What's next

Three threads from the morning-check backlog that aren't yet shipped:

1. **Exam-correlation analysis.** The `ExamResult` table exists; the correlation script does not. At N ≥ 4 results across users (likely by November after Block 3 + 4 exams) we can begin to ask which pre-exam study patterns predicted higher scores.
2. **Per-batch embedding cron is text-only.** The Vercel cron handles cards + questions; videos and concepts stay manual because they're cost-sensitive or require longer-running compute. A bounded nightly batch for those would close the only remaining drift surface.
3. **The "rewrite" complexity-calibration tier is the new frontier.** After the bulk relabel zeroed the actionable mismatches, the remaining gap is cards whose label is right but the item under-delivers. Detecting this requires per-item discrimination signal that the current 2-user sample sizes can't reliably support. With more cross-user activity the signal sharpens.

---

## 7. Acknowledgments

Sia Vardakas (USyd Year 3) for being the second user — her flagging caught a meaningful share of the content bugs that the audit infrastructure now codifies. The remaining users (Isaac, Xiaojing, Xinyi, Jen) whose paths through the platform surfaced the queue-staleness and rotation-scoping bugs.

Anthropic's Claude (the model) for the engineering loop; the structure-of-work decisions throughout (architecture, audit design, what to commit, what to skip) are Ian's.

---

## Appendix A: deltas from April paper

| | April 3 | May 16 |
|---|---|---|
| Cards (active rotations) | 9,541 | 7,979 (cuts + cleanup) |
| MCQs | 1,272 | 9,413 (question-bank consolidation) |
| Active users (DAU) | "68 active over time" | ~5 daily |
| Test suite | 2,100+ | 4,074 |
| Audit scripts | 1–2 | 9 |
| Embedding-aware scheduler | no | yes (Gemini II 3072D) |
| Per-concept teaching state | no | yes (4-state classifier) |
| Failure-escalation queue | no | yes (2h window) |
| Empirical difficulty | no | nightly + bulk-relabel |
| Morning-check contract | informal | `CLAUDE.md`-enforced |
| Run-log corpus | none | `audit/morning-check/runs.jsonl` |

## Appendix B: reading the codebase

- `src/lib/knowledge/unified-scheduler.ts` — the main scheduler (2000+ lines, the priority computation around lines 600–700 is the most-edited region of the codebase)
- `src/lib/scheduler/concept-teaching-state.ts` — teaching-state classifier + arcs
- `src/lib/scheduler/naive-pre-teach.ts` — pre-teach hook (commit history shows the cost-of-not-having-it)
- `src/lib/manifold/scoring.ts` — pgvector similarity queries
- `scripts/audit/*.ts` — the diagnostic layer
- `docs/AGENT_DATA_GUIDE.md` — what's queryable + how to query it
- `CLAUDE.md` — the morning-check playbook
- `audit/morning-check/runs.jsonl` — the per-run agent-behaviour log

The `md3-open` repo this paper sits in is a deliberate snapshot of the April architecture — the simpler version is easier to understand. The production system is not open source.
