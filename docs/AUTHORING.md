# How to Author a Good Card

This is the practical guide. For the stages and modules behind it, see
[PIPELINE.md](./PIPELINE.md). The types referenced here all come from
[`src/lib/authoring/contracts.ts`](../src/lib/authoring/contracts.ts) — import
them from `@/lib/authoring/contracts`.

A good card is one a student **cannot answer without knowing the answer**, that
**teaches when they miss**, and that you can **trace to a source**. The rules
below are the cheapest way to hit all three.

---

## The six rules

### 1. Scaffold before you test (the C1 rule)

Don't make a fact's *first* appearance a recall test. Teach it once, then test
it. In this kit that is the **complexity tier**:

- `complexity: 1` — **C1 scaffold.** A teaching card. Introduces the fact in a
  low-stakes, near-given form. Author-tagged; the generator never invents these.
- `complexity: 2` — **standard test.** A specific fact the student must *know*
  (a dose, a cutoff, a defining feature). Default for `<KeyPoint>` recall.
- `complexity: 3` — **hard / reasoning.** Multi-step or discriminating items.

If you only ship the C2 test, the first miss teaches nothing. Pair it with a C1
scaffold of the same fact. `complexity={1}` in MDX forces the scaffold tier;
otherwise `estimateComplexity()` defaults specific-recall cards to C2.

### 2. Keep cloze answers 1–2 words

The deleted span (`back`) is what the student must *produce*. One or two words.
Long blanks become "guess the phrasing", not "know the fact". `mcqToCloze`
enforces this (`trimAnswerForCloze` drops trailing parentheticals, em-dash
elaboration, and comma-lists, then refuses answers >2 words); `validateCard`
flags answers that are too short (1 char) or too long (>100 chars).

Blank the **whole semantic unit**, never a fragment. `[___] weeks` → `2-4`, not
`[___]-4 weeks` → `2`. `detectBadClozeSpans` will flag the fragment.

### 3. Run the quality gates

Before a card ships, run it through the battery. Treat any `block` issue as a
hard stop; treat `warn`/`info` as a review prompt.

```ts
import { runMcqGates } from "@/lib/authoring/quality/validate-mcq";
import { checkGuessability } from "@/lib/authoring/quality/option-guessability";
import { checkDistractorRoles } from "@/lib/authoring/quality/distractor-quality";
import { clozeQualityGate } from "@/lib/authoring/quality/cloze-quality";
import type { AuthoringQuestion, QualityVerdict } from "@/lib/authoring/contracts";

function gateMcq(q: AuthoringQuestion): QualityVerdict {
  const issues = [
    ...runMcqGates(q).issues,        // structure, length-bias, format-asymmetry, …
    ...checkGuessability(q),         // test-wise tells → block if they pick the right answer
    ...checkDistractorRoles(q),      // filler / near-duplicate / no-teaching-role distractors
  ];
  return { ok: !issues.some((i) => i.severity === "block"), issues };
}
```

For cloze cards, run `clozeQualityGate(card)`. The gate to fear most is
**guessability**: if the tells (length, hedging, specificity) point at the
*actual* correct option, `checkGuessability` returns a `block`. Fix it by making
distractors match the correct option's length and register.

### 4. Cite with a DOI

Every card carries a `cite`. Prefer a DOI — it survives renames and is
machine-resolvable:

```ts
cite: "doi:10.1007/s00431-022-04458-z"
```

A source-slug + section also works (`"nice-fever-u5:1.2.3"`); resolve it with
`resolveCiteToSourceRef` against your source corpus. `validateCard` warns on any
card with no `cite` ("source not traceable"). An uncited card cannot be audited.

### 5. Set complexity / importance / topics

- `complexity` — see rule 1 (1|2|3).
- `importance: 1 | 2 | 3` — `1` normal, `2` important, `3` foundational. Drives
  scheduling priority; default `1`.
- `topics: string[]` — the index. The MDX extractor derives these from ancestor
  headings; set them explicitly when authoring by hand. Topics are how the card
  is found and how curriculum coverage is measured.

### 6. Write a context that teaches, not echoes

`context` is shown **after a miss**. It must add *why/when/trap*, not restate the
answer. `restatesAnswer()` flags a context that just contains the answer; a bare
acronym expansion ("MCD = minimal change disease.") is a `stubContext` — that
belongs in hover UX, not the teaching slot.

---

## A worked example

Start from a grounded fact (e.g. the answer of an `EvidencePack` from
LocalEvidence): *"In a febrile infant under 28 days old, a full septic screen
including lumbar puncture is mandatory regardless of how well the infant
appears."*

**Bad card** — blank too long, answer leaks, no teaching, uncited:

```ts
const bad: AuthoringCard = {
  cardType: "cloze",
  front: "In a febrile infant under 28 days old, a [___] is mandatory.",
  back: "full septic screen including lumbar puncture",  // ❌ >2 words; "the phrasing" not "the fact"
  complexity: 2,
  importance: 1,
  topics: [],                                            // ❌ unindexed
};
// validateCard: "Answer unusually long"; no cite; no context.
```

**Good pair** — a C1 scaffold, then a C2 test with a tight blank, a teaching
context, topics, and a DOI:

```ts
import type { AuthoringCard } from "@/lib/authoring/contracts";

// C1 — scaffold: introduce the age threshold in near-given form.
const scaffold: AuthoringCard = {
  cardType: "cloze",
  front: "A febrile infant under [___] days old needs a full septic screen with LP, regardless of how well they appear.",
  back: "28",
  context: "The neonatal period is the high-risk window: appearance is unreliable, so investigation is mandatory rather than clinician-judged.",
  complexity: 1,          // scaffold tier — author-tagged
  importance: 3,          // foundational
  topics: ["febrile infant", "sepsis", "neonatal"],
  cite: "doi:10.1136/archdischild-2021-322426",
};

// C2 — test: tight blank on the discriminating fact.
const test: AuthoringCard = {
  cardType: "cloze",
  front: "In a febrile neonate, lumbar puncture is [___] even if the infant appears well.",
  back: "mandatory",      // 1 word
  context: "Well-appearance does not exclude serious bacterial infection in neonates — the screen is not optional below 28 days.",
  complexity: 2,
  importance: 3,
  topics: ["febrile infant", "lumbar puncture", "neonatal"],
  cite: "doi:10.1136/archdischild-2021-322426",
};
```

Run both through `clozeQualityGate` and `validateCard`: the blanks are 1–2 words,
the context teaches rather than echoes, both are cited, and the scaffold precedes
the test. That is a shippable pair.

---

## Quick checklist

- [ ] Is there a C1 scaffold before the first C2 test of this fact?
- [ ] Is every cloze `back` 1–2 words, blanking a whole semantic unit?
- [ ] Does `runMcqGates` / `clozeQualityGate` return **no `block` issues**?
- [ ] Does `checkGuessability` *not* point at the correct option?
- [ ] Is there a `cite` (ideally a DOI)?
- [ ] Are `complexity`, `importance`, and `topics` all set?
- [ ] Does `context` teach (why/when/trap), not restate the answer?
