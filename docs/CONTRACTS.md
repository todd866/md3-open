# Authoring Contracts — the API you rebuild against

This is the prose companion to [`src/lib/authoring/contracts.ts`](../src/lib/authoring/contracts.ts).

The card-authoring kit is a pipeline of independent stages. The implementations
behind each stage — the cloze extractors, the MCQ quality gates, the difficulty
estimator, the LocalEvidence retrieval client — are **reference code**. You are
expected to fork them, and to have Claude Code rebuild whole stages for your own
stack, possibly in another language. (The pipeline already spans Python tools and
TypeScript libs; Claude Code stitches across that seam.)

What stays fixed across every rebuild is the **shape of the data** that crosses the
seams between stages. That data shape is `contracts.ts`. It imports nothing — no
database, no Next.js, no service client — precisely so it can be read, copied, and
re-implemented anywhere. **Depend on these types, not on any one function.**

```
source → ground → generate → quality-gate → structure → audit
         │         │          │              │           │
   EvidencePack    │     QualityGate     Complexity   GroundingResult
                AuthoringCard /          Importance
                AuthoringQuestion        SourceRef / cite
```

Every section below names what is **STABLE** (the contract — don't break it) and
what is **REBUILDABLE** (the implementation — fork it, rewrite it, port it).

---

## How to read each type

A contract is STABLE if downstream code reads its fields. It is REBUILDABLE if it is
produced by a function whose internals you are free to throw away. Most types here
are both: the field set is stable; the logic that fills them is yours to replace.

---

## Core authored units

These are the things the pipeline produces and the study app consumes. They are the
most stable types in the file — the database schema, the review UI, and the seed
scripts all read them.

### `Complexity` and `Importance`

```ts
export type Complexity = 1 | 2 | 3; // 1 = teaching/scaffold (C1), 2 = standard, 3 = hard
export type Importance = 1 | 2 | 3; // 1 = normal, 2 = important, 3 = foundational
```

- **Stage:** assigned in **structure**, read everywhere downstream (scheduler,
  curriculum, review UI).
- **STABLE:** the `1 | 2 | 3` ordinal scale and its meaning. The scheduler and
  curriculum builder branch on these literals.
- **REBUILDABLE:** *how* you derive a tier. The reference `estimateComplexity` in
  `structure/difficulty.ts` scores signals (length, clause count, list-ness) and
  bins the score. Replace the scorer freely; just emit `1 | 2 | 3`.
- **Example:** `2` (a standard test card) · `3` (a foundational fact).

### `CardType`

```ts
export type CardType = "cloze" | "mcq";
```

- The discriminant for `AuthoredItem`. STABLE — every consumer narrows on it.
- **Example:** `"cloze"`.

### `AuthoringCard` (a cloze / fill-in-the-blank card)

```ts
export interface AuthoringCard {
  cardType: "cloze";
  front: string;
  back: string;
  backs?: string[];
  context?: string;
  complexity: Complexity;
  importance: Importance;
  topics: string[];
  cite?: string;
  stableId?: string;
}
```

- **Stage:** the primary output of **generate**, refined in **structure**, consumed
  by the study app.
- **STABLE:** the field set. `front` carries the blanked statement; `back` is the
  deleted span (house rule: keep it 1–2 words); `backs` holds multi-blank answers
  when one card was split from a list; `context` is the teaching note shown after a
  miss; `cite` is provenance; `stableId` is the content-hash identity used for
  idempotent upsert (`"le:42"`, `"mdx:..."`, `"bank:..."`).
- **REBUILDABLE:** every producer. The reference extractors live in
  `generate/card-extractors.ts` (`extractCardsFromContent`,
  `extractKeyPointCards`, …) and the MCQ→cloze transform in
  `generate/mcq-to-cloze.ts`. Write your own extractor in any language — as long as
  it emits objects of this shape, the rest of the pipeline does not care.
- **Example:**
  ```ts
  {
    cardType: "cloze",
    front: "First-line antibiotic for community-acquired pneumonia is [___].",
    back: "amoxicillin",
    complexity: 2,
    importance: 3,
    topics: ["respiratory", "antibiotics"],
    cite: "doi:10.1007/s00431-022-04458-z",
    stableId: "le:42",
  }
  ```

### `McqOption` and `AuthoringQuestion` (a multiple-choice question)

```ts
export interface McqOption {
  label: string; // "A" | "B" | ...
  text: string;
  isCorrect: boolean;
  explanation?: string;
}

export interface AuthoringQuestion {
  cardType: "mcq";
  stem: string;
  options: McqOption[];
  explanation?: string;
  complexity: Complexity;
  importance: Importance;
  topics: string[];
  cite?: string;
  stableId?: string;
}
```

- **Stage:** output of **generate** (or imported question banks), scrutinised by
  **quality-gate**, consumed by the review UI.
- **STABLE:** the field set, and the invariant that exactly one option has
  `isCorrect: true`. The whole quality-gate stage reads `stem` and `options`.
- **REBUILDABLE:** generation, and per-option `explanation` authoring. The reference
  validators and converters are in `generate/card-validators.ts` and
  `generate/mcq-to-cloze.ts`.
- **Example:**
  ```ts
  {
    cardType: "mcq",
    stem: "Which electrolyte abnormality is most associated with loop diuretics?",
    options: [
      { label: "A", text: "Hypokalaemia", isCorrect: true },
      { label: "B", text: "Hyperkalaemia", isCorrect: false },
      { label: "C", text: "Hypernatraemia", isCorrect: false },
      { label: "D", text: "Hypercalcaemia", isCorrect: false },
    ],
    complexity: 2,
    importance: 2,
    topics: ["pharmacology", "electrolytes"],
  }
  ```

### `AuthoredItem`

```ts
export type AuthoredItem = AuthoringCard | AuthoringQuestion;
```

- The discriminated union flowing through the pipeline. STABLE — narrow on
  `cardType`. Difficulty estimation and bulk validation both accept `AuthoredItem`.
- **Example:** any `AuthoringCard` or `AuthoringQuestion` above.

---

## Sources & grounding — the LocalEvidence seam

This is where the kit meets a retrieval service. The reference setup runs
[LocalEvidence](https://github.com/todd866) as a sidecar exposing `/api/ask` and
`/api/verify-evidence` on `:8765`, over a warmed corpus (PaperLibrary). These types
are the **schema of what crosses that wire** — so you can swap LocalEvidence for any
retriever that produces the same shape.

### `EvidenceTier`

```ts
export type EvidenceTier =
  | "guideline" | "systematic_review" | "rct"
  | "cohort" | "review" | "other";
```

- **STABLE:** the closed set of tiers. Citation and audit logic rank by it.
- **REBUILDABLE:** how you classify a source into a tier (paperscope validity, journal
  heuristics, a manual map).
- **Example:** `"systematic_review"`.

### `SourceRef`

```ts
export interface SourceRef {
  slug?: string;
  doi?: string;
  title: string;
  tier: EvidenceTier;
  year?: string;
  journal?: string;
}
```

- **Stage:** produced by **ground**, threaded through **structure** (citations) and
  **audit**.
- **STABLE:** the field set. Only `title` and `tier` are required; `slug`/`doi`
  identify the source; the rest is display metadata.
- **REBUILDABLE:** where the metadata comes from. The reference `cite.ts` builds and
  resolves these from a `SourceRegistry` and from `cite` strings
  (`sourceDefinitionToRef`, `resolveCiteToSourceRef`).
- **Example:**
  ```ts
  {
    doi: "10.1056/NEJMoa2034577",
    title: "Dexamethasone in Hospitalized Patients with Covid-19",
    tier: "rct",
    year: "2021",
    journal: "N Engl J Med",
  }
  ```

### `EvidencePassage`

```ts
export interface EvidencePassage {
  text: string;
  source: SourceRef;
  score?: number; // fused retrieval score, if available
}
```

- **Stage:** the unit of retrieved evidence (a chunk + its provenance). Produced in
  **ground**, consumed in **audit**.
- **STABLE:** `text` + `source`. `score` is advisory.
- **REBUILDABLE:** the retriever, the chunking, and the fusion that fills `score`.
- **Example:**
  ```ts
  {
    text: "Dexamethasone reduced 28-day mortality among patients receiving...",
    source: { doi: "10.1056/NEJMoa2034577", title: "Dexamethasone...", tier: "rct" },
    score: 0.81,
  }
  ```

### `EvidencePack` — the curriculum seed

```ts
export interface EvidencePack {
  question: string;
  answer?: string | null;
  reasoning?: string | null;
  confidence?: "high" | "moderate" | "low" | null;
  evidence: EvidencePassage[];
  gaps?: SourceRef[];
}
```

- **Stage:** the **ground → generate** handoff. A simplified LocalEvidence ledger
  entry: a question, its grounded answer (may be `null` on a freshly retrieved entry,
  before synthesis), and the passages it stands on. The generation stage turns one
  `EvidencePack` into one-or-more cards.
- **STABLE:** the field set, and the nullability of `answer`/`reasoning`/`confidence`
  (retrieval and synthesis are separate steps; consumers must tolerate `null`).
  `gaps` lists DOIs that were wanted but not retrieved — the corpus hole, which the
  audit stage uses to distinguish a real defect from a missing source.
- **REBUILDABLE:** everything that fills it — the `/api/ask` call, the synthesiser,
  the confidence model.
- **Example:**
  ```ts
  {
    question: "What is the first-line treatment for status epilepticus?",
    answer: "A benzodiazepine (IV lorazepam or IM midazolam) is first-line.",
    reasoning: "Guideline consensus across three sources...",
    confidence: "high",
    evidence: [/* EvidencePassage[] */],
    gaps: [{ doi: "10.1111/epi.16443", title: "ILAE guideline 2023", tier: "guideline" }],
  }
  ```

---

## Quality-gate seam

The quality stage runs an authored item through a battery of pure checks (length
bias, format asymmetry, guessability, cloze-span and distractor checks). Each check
is a **function from item to issues** — that uniform signature is the whole contract,
and it is what lets you add, drop, or reorder checks without touching the harness.

### `IssueSeverity`

```ts
export type IssueSeverity = "block" | "warn" | "info";
```

- **STABLE:** the three levels. `block` is the only one that fails an item (it sets
  `QualityVerdict.ok = false`); `warn`/`info` are advisory.
- **Example:** `"block"`.

### `QualityIssue`

```ts
export interface QualityIssue {
  check: string;   // e.g. "length-bias" | "format-asymmetry" | "guessable"
  severity: IssueSeverity;
  message: string;
}
```

- **Stage:** the output unit of **quality-gate**.
- **STABLE:** the field set. `check` is a free-string tag (a stable identifier for the
  rule that fired, used for grouping/suppression); `message` is human-facing.
- **REBUILDABLE:** every gate that emits these. The reference gates are in
  `quality/` (`clozeQualityGate`, `checkGuessability`, `checkLengthBias`,
  `checkFormatAsymmetry`, `checkDistractorRoles`, and the `MCQ_GATES` battery).
- **Example:**
  ```ts
  { check: "length-bias", severity: "warn", message: "Correct option is 2.3× longer than the mean distractor." }
  ```

### `QualityVerdict`

```ts
export interface QualityVerdict {
  ok: boolean; // false if any `block` issue present
  issues: QualityIssue[];
}
```

- **Stage:** the aggregated result of running all gates on one item.
- **STABLE:** `ok` is derived — `ok === issues.every(i => i.severity !== "block")`.
  The CI/seed path keys off `ok`.
- **REBUILDABLE:** which gates run and in what order. The reference aggregator is
  `runMcqGates` in `quality/validate-mcq.ts`.
- **Example:**
  ```ts
  { ok: false, issues: [{ check: "guessable", severity: "block", message: "Longest option is always correct across 3 sibling items." }] }
  ```

### `QualityGate<T>` — the gate signature

```ts
export type QualityGate<T extends AuthoredItem = AuthoredItem> = (item: T) => QualityIssue[];
```

- **This is the most important contract in the quality stage.** A gate is a pure
  function: item in, issues out (empty array = passed). It does no IO. To add a
  check, write a function of this type; to remove one, drop it from the battery
  array. The harness composes them by concatenating their outputs and deriving `ok`.
- **STABLE:** the signature. Generic `T` lets a gate narrow to
  `AuthoringQuestion` (most MCQ gates) or accept any `AuthoredItem`.
- **REBUILDABLE:** the body of every gate — that's the entire point.
- **Example:**
  ```ts
  const noEmptyStem: QualityGate<AuthoringQuestion> = (q) =>
    q.stem.trim() ? [] : [{ check: "empty-stem", severity: "block", message: "Stem is empty." }];
  ```

---

## Grounding / audit seam — verify a claim against evidence

The final stage takes a claim lifted from an authored card and checks it against
retrieved passages. The contract is the **verdict shape**, so you can back the audit
with any verifier — an LLM judge over LocalEvidence, an entailment model, a human.

### `GroundingStatus`

```ts
export type GroundingStatus = "supported" | "contradicted" | "unsupported";
```

- **STABLE:** the three outcomes. `contradicted` is a hard defect; `unsupported`
  needs the `gap` flag to decide whether it's a defect or just a missing source.
- **Example:** `"supported"`.

### `GroundingResult`

```ts
export interface GroundingResult {
  claim: string;
  status: GroundingStatus;
  passages: EvidencePassage[];
  confidence?: number;
  gap?: boolean;
}
```

- **Stage:** the output of **audit** — one result per checked claim.
- **STABLE:** the field set. `claim` is the asserted text; `status` is the verdict;
  `passages` are the supporting/contradicting evidence (so a human can adjudicate);
  `confidence` is `0..1`; `gap` is meaningful only when `status === "unsupported"` —
  `true` means "the corpus didn't have it" (fix the corpus), `false` means "the
  corpus had relevant material and the claim still didn't land" (fix the card).
- **REBUILDABLE:** the verifier that produces it. Feed it the `EvidencePack.gaps`
  from the ground stage to set `gap` correctly.
- **Example:**
  ```ts
  {
    claim: "Amoxicillin is first-line for community-acquired pneumonia.",
    status: "supported",
    passages: [/* EvidencePassage[] */],
    confidence: 0.92,
  }
  ```

---

## The one rule

When you fork this kit and rebuild a stage, the test of whether you did it right is
not "does my code look like the reference code" — it almost certainly won't, and
shouldn't. The test is: **does the data crossing the seam still match `contracts.ts`?**
If your new Python extractor emits `AuthoringCard`-shaped objects, your TypeScript
quality gates will run on them unchanged. That interoperability — not the
implementations — is the durable product.
