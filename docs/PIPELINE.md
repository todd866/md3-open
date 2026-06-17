# The Authoring Pipeline

This is the card-authoring stack: how a primary source becomes a grounded,
quality-checked study card. md3-open ships the **reference implementation** of
this pipeline. md3.info is the hosted convenience tier that runs the same
stages at scale.

The design goal is **rebuildability, not reuse**. The durable, stable thing is
the set of data contracts in [`src/lib/authoring/contracts.ts`](../src/lib/authoring/contracts.ts).
Everything behind each stage is reference code you are expected to fork and have
Claude Code rebuild for your own stack — possibly in another language. Depend on
the *shapes* (`AuthoringCard`, `EvidencePack`, `QualityVerdict`, …), not on any
one function name.

```
SOURCE ──▶ GROUND ──▶ GENERATE ──▶ QUALITY-GATE ──▶ STRUCTURE ──▶ AUDIT
(Python)  (Python)     (TS)           (TS)            (TS)      (Py + TS)
```

The pipeline deliberately **spans two languages**. The left half (source
acquisition and grounding) lives in Python services and tools — they do
retrieval, PDF/image handling, and validity scoring, which is where the Python
scientific ecosystem is strongest. The right half (generation, quality gating,
structuring) lives in this TypeScript kit, because that is where the cards are
shaped and where the app consumes them. **Claude Code is the stitch**: it reads
the contract types, calls the Python tools, hands their JSON to the TS libs, and
writes the result back. No single binary owns the whole pipeline; the contract
types are the lingua franca across the seam.

---

## Stage 1 — SOURCE

**What it does.** Pulls raw material to author from: published papers, images,
and pre-extracted teaching content.

**Tools (Python / external, not in this repo).**

| Tool | Role |
|------|------|
| **PaperLibrary** | Local catalog of published papers (DOI-keyed PDFs + plaintext). The corpus you author *from*. |
| **ImageLibrary** | Figures/tracings (ECGs, X-rays, scans) keyed for card-side embedding. |
| **content_lake** | Pre-authored MDX/markdown teaching notes (`<KeyPoint>`, `<Danger>`, `<ClinicalPearl>` blocks). |

**Inputs.** A topic, a DOI, a curriculum week, or an MDX file.
**Outputs.** Raw text/MDX strings + `SourceRef` stubs (`title`, `doi`, `tier`).

**Implemented here.** Nothing — these are external corpora. The kit consumes
their *output strings* downstream. The one in-repo helper that touches this
layer is citation resolution (see STRUCTURE → `cite.ts`).

---

## Stage 2 — GROUND

**What it does.** Turns a question into a *grounded answer*: retrieves the best
evidence from a warmed corpus, synthesises an answer, and attaches the passages
and their validity. This is the **curriculum seed** — the thing generation turns
into cards.

**Tool (Python service): LocalEvidence.** Runs alongside the app and exposes:

- `POST :8765/api/ask` — question in, grounded answer + ranked passages out.
- `POST :8765/api/verify-evidence` — claim in, supported/contradicted out (used by AUDIT).

LocalEvidence is slow only on a **cold** corpus (it is acquiring papers). Warm
corpus answers return in **<5 s**, and curriculum generation is async anyway, so
cold-start latency never sits on the authoring hot path.

**Tool (Python): paperscope validity.** Scores each retrieved source's
study design / trustworthiness, which populates `SourceRef.tier`
(`guideline` > `systematic_review` > `rct` > `cohort` > `review` > `other`).

**Contract.** The grounded answer is an [`EvidencePack`](../src/lib/authoring/contracts.ts):

```ts
interface EvidencePack {
  question: string;
  answer?: string | null;       // synthesised at ask-time
  reasoning?: string | null;
  confidence?: "high" | "moderate" | "low" | null;
  evidence: EvidencePassage[];  // ranked passages, each with a SourceRef + tier
  gaps?: SourceRef[];           // DOIs wanted but not in the corpus
}
```

`EvidencePack` is shaped to mirror a LocalEvidence ledger entry (its
`triage.json` / `passages.json` run artifacts) so the Python output drops
straight into the TS generator.

**Inputs.** A question string (often from a curriculum learning objective).
**Outputs.** One `EvidencePack`.

**Implemented here — [`src/lib/authoring/grounding/`](../src/lib/authoring/grounding/):**
The retrieval itself lives in the LocalEvidence service (a separate repo); the kit
defines the contract (`EvidencePack`, `EvidencePassage`, `SourceRef`,
`GroundingResult`) and three in-repo TS modules that talk to it and turn its output
into cards:

| Module | Key exports | What it does |
|--------|-------------|--------------|
| [`le-client.ts`](../src/lib/authoring/grounding/le-client.ts) | `ask`, `verifyEvidence`, `leEntryToEvidencePack`, `DEFAULT_LE_BASE_URL` | HTTP client to the LocalEvidence service (`/api/ask`, `/api/verify-evidence`). Fork this seam by reimplementing it against your own retriever and emitting `EvidencePack`. |
| [`le-to-cards.ts`](../src/lib/authoring/grounding/le-to-cards.ts) | `evidencePackToItems`, `readLedger`, `readLedgerLines`, `leStableId`, `topCite`, `deriveTopics`, `AuthorFn`, `AuthoredDrafts`, `passthroughAuthor` | The GROUND→GENERATE synthesis transform: one `EvidencePack` (or a bulk LE ledger) → authored items, with identity (`le:<id>`), citation, and complexity wired deterministically. The **`AuthorFn`** seam (intentionally synchronous) is where card *text* comes from; `passthroughAuthor` is the no-LLM placeholder. |
| [`author-claude.ts`](../src/lib/authoring/grounding/author-claude.ts) | `evidencePackToItemsWithClaude`, `draftCardsWithClaude`, `makeClaudeDrafter` | The reference Claude-backed author (adds `@anthropic-ai/sdk`; the one module NOT re-exported from `index.ts`). Awaits drafts from the model, then feeds them through the sync glue. |

Also the citation bridge in [`structure/cite.ts`](../src/lib/authoring/structure/cite.ts)
(`sourceDefinitionToRef` converts a corpus source definition into a contract `SourceRef`).

---

## Stage 3 — GENERATE

**What it does.** Turns source material (an `EvidencePack` answer, or an MDX
teaching block) into draft `AuthoringCard` / `AuthoringQuestion` objects.

**Inputs.** MDX content strings, or an `EvidencePack`.
**Outputs.** `AuthoredItem[]` (cloze cards + MCQs).

**Implemented here — [`src/lib/authoring/generate/`](../src/lib/authoring/generate/):**

| Module | Key exports | What it does |
|--------|-------------|--------------|
| [`card-extractors.ts`](../src/lib/authoring/generate/card-extractors.ts) | `extractCardsFromContent`, `extractKeyPointCards`, `extractDangerCards`, `extractClinicalPearlCards`, `parseQAPairs`, `extractHeadings`, `getExtractionStats` | Pull cloze cards out of MDX `<KeyPoint>`/`<Danger>`/`<ClinicalPearl>` blocks. **Explicit `**Q:**`/`**A:**` only** — no auto-blanking of bold terms. Derives `topics` from ancestor headings; reads `complexity`/`importance`/`cite`/`context` JSX attributes. |
| [`mcq-to-cloze.ts`](../src/lib/authoring/generate/mcq-to-cloze.ts) | `mcqToCloze`, `stemToClozeStatement`, `trimAnswerForCloze`, `shouldSkipClozeConversion`, `shouldOmitMcqCard` | Derive a recall (`cloze`) card from an `AuthoringQuestion`, reinforcing the same fact. Trims the answer to a 1–2 word blank; skips list/negative/"which of the following" stems. |
| [`split-cloze-variants.ts`](../src/lib/authoring/generate/split-cloze-variants.ts) | `splitClozeVariants` | Expand an N-blank cloze (`backs[]`) into N single-blank sibling cards (study one blank at a time). Returns variant linkage out-of-band + derived `stableId`s. |
| [`card-validators.ts`](../src/lib/authoring/generate/card-validators.ts) | `validateCard`, `validateAllCards`, `extractMCQOptions` | First-pass authoring-time validation: too-short answers, answer leaks into front, malformed blanks, "one-of-many" cards, missing context/citation. Returns `error`/`warning` findings; `validateAllCards` filters out hard errors. |

`card-validators` overlaps the quality gates intentionally: it is the cheap
local check at generation time; the QUALITY-GATE stage is the formal battery.

---

## Stage 4 — QUALITY-GATE

**What it does.** Runs each draft item through the bias/guessability battery and
folds the findings into a `QualityVerdict`. Catches the failure modes that make a
card answerable *without knowing the answer*.

**Contract.** Every gate implements
[`QualityGate`](../src/lib/authoring/contracts.ts) (`(item) => QualityIssue[]`)
and results fold into a `QualityVerdict` (`{ ok, issues }`; `ok` is false iff any
`block`-severity issue fired).

**Inputs.** A single `AuthoredItem`.
**Outputs.** `QualityIssue[]` per gate; `QualityVerdict` from the runner.

**Implemented here — [`src/lib/authoring/quality/`](../src/lib/authoring/quality/):**

| Module | Key exports | Checks |
|--------|-------------|--------|
| [`validate-mcq.ts`](../src/lib/authoring/quality/validate-mcq.ts) | `runMcqGates`, `MCQ_GATES`, `checkStructure`, `checkLengthBias`, `checkFormatAsymmetry`, `checkFormOpacity`, `checkOptionLetterRefs`, `checkNegativeStemType`, `checkMissingTerminalQuestion`, `checkExamStyleCalibration`, `checkTruncatedText`, `checkBareSubscripts` | The MCQ battery. Structure (block-level), length-bias, format-asymmetry, option-shape opacity, shuffled letter-refs, negative stems, exam-style calibration, truncation. `runMcqGates` returns the `QualityVerdict`. |
| [`option-guessability.ts`](../src/lib/authoring/quality/option-guessability.ts) | `checkGuessability`, `analyzeGuessability`, `validateAgainstCorrect`, `getGuessabilitySeverity` | Six test-wise tells (length / qualifier / absolute-term / specificity / parenthetical / sophistication asymmetry). **Escalates to `block`** when the tells point at the *actual* correct answer. |
| [`cloze-quality.ts`](../src/lib/authoring/quality/cloze-quality.ts) | `clozeQualityGate`, `detectBadClozeSpans` | Bad cloze blanking: partial numeric range, short-answer leak, single-letter term-fragment, decode-leak (answer spelled by adjacent acronym). |
| [`distractor-quality.ts`](../src/lib/authoring/quality/distractor-quality.ts) | `checkDistractorRoles`, `analyzeDistractorRoles`, `computeDistractorQuality` | Distractor role taxonomy (misconception / near-miss / opposite / filler / absolute / all-or-none). Flags hollow filler, near-duplicate pairs, and blocks with no teaching role. `computeDistractorQuality` folds in caller-supplied misconception-coverage / dead-distractor stats. |

DB-driven bank-level checks from production (duplicate-id scans, dead-distractor
*pick* counts, misconception-link counts) are dropped — they were queries. Where
those numbers add signal, they are *inputs* the caller supplies
(`DistractorQualityInput`), not queries this kit runs.

---

## Stage 5 — STRUCTURE

**What it does.** Assigns the metadata that makes a card schedulable and
traceable: complexity tier, topics, citation, and curriculum placement.

**Inputs.** An `AuthoredItem` (+ optionally a corpus of source definitions and
curriculum markdown).
**Outputs.** `Complexity` (1|2|3), resolved `SourceRef`, curriculum coordinates.

**Implemented here — [`src/lib/authoring/structure/`](../src/lib/authoring/structure/):**

| Module | Key exports | What it does |
|--------|-------------|--------------|
| [`difficulty.ts`](../src/lib/authoring/structure/difficulty.ts) | `estimateComplexity`, `estimateDifficulty`, `complexityFromScore` | Generation-time `Complexity` from content signals (declared tier + token-load + numeric-load). The empirical pass-rate and vector-uniqueness terms from production are dropped (runtime data). |
| [`cite.ts`](../src/lib/authoring/structure/cite.ts) | `parseCiteReference`, `isValidCite`, `buildSourceRegistry`, `resolveCiteToSourceRef`, `sourceDefinitionToRef` | Parse `cite` strings (`slug#section`, `slug:doc:ver#section`), and resolve them against a caller-supplied source corpus into a contract `SourceRef`. This is also the GROUND→contract citation bridge. |
| [`curriculum.ts`](../src/lib/authoring/structure/curriculum.ts) | `parseCurriculumDoc`, `loadCurriculumDir`, `getWeekTopics`, `extractLearningObjectives`, `parseTagToCurriculum`, `getCurriculumModuleNodes` | Load curriculum markdown (week topics + learning objectives) and map deck tags to module paths. Institution-specific calendar data from production is dropped; corpus is supplied by the caller. |

The C1-scaffold rule (a teaching card before the test card) is enforced at
*authoring* time, not by a function — see [AUTHORING.md](./AUTHORING.md).
`complexity={1}` marks a scaffold; `estimateComplexity` will otherwise default a
specific-recall card to C2.

---

## Stage 6 — AUDIT

**What it does.** Verifies that an authored card's *claim* actually holds against
the evidence — closing the loop back to GROUND. Distinguishes a real defect
(`contradicted`) from a mere corpus gap (`unsupported` + `gap: true`).

**Tool (Python service): LocalEvidence `/api/verify-evidence`.** Claim in,
status out.

**Contract.** [`GroundingResult`](../src/lib/authoring/contracts.ts):

```ts
interface GroundingResult {
  claim: string;
  status: "supported" | "contradicted" | "unsupported";
  passages: EvidencePassage[];
  confidence?: number;
  gap?: boolean;  // unsupported because the corpus lacks it, not because it's wrong
}
```

**Inputs.** A card's claim string + the corpus.
**Outputs.** One `GroundingResult` per claim.

**Implemented here.** No TS implementation — audit needs retrieval, so it is a
LocalEvidence call. The kit owns the *contract* (`GroundingResult`) so the
verdicts flow back into the same type system the rest of the pipeline uses.

---

## Spool up your own

1. `git clone` md3-open; bring up Postgres + the Next app (see the root [README](../README.md)).
2. Run **LocalEvidence** as a service alongside it (`/api/ask`, `/api/verify-evidence` on `:8765`).
3. **Warm a corpus** — point LocalEvidence at your PaperLibrary so retrieval is
   `<5 s`. Cold = acquisition; pay it once.
4. The GROUND→GENERATE transform mints grounded curriculum: ask LocalEvidence per
   learning objective → `EvidencePack` → `generate/` → `quality/` → `structure/`.
5. Fork any stage. The contracts in `contracts.ts` are the contract; the rest is
   reference code Claude Code can rebuild against those types.
