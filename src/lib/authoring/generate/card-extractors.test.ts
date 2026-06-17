/**
 * Tests for the card-extractors kit module (DB-free reference port).
 *
 * Ported/adapted from md3 production `card-extractors.test.ts`, rebound to the
 * kit's exports. Differences from production exercised here:
 *  - the kit's component extractors take `(content, headings)` (no rotation/week)
 *  - `extractCardsFromContent(content)` is the convenience all-component wrapper
 *  - cards are plain `AuthoringCard` (no imageUrl/imageCaption/week fields)
 */

import { describe, it, expect } from "vitest";
import {
  extractCardsFromContent,
  extractKeyPointCards,
  extractDangerCards,
  extractClinicalPearlCards,
  extractHeadings,
  parseQAPairs,
  stripMdxComponents,
  alignMultiBlankAnswers,
  isMissingContext,
  isStubContext,
  restatesAnswer,
} from "./card-extractors";

// ─── extractCardsFromContent (the requested entry point) ─────────────────────

describe("extractCardsFromContent", () => {
  it("extracts cloze cards from KeyPoint/Danger/ClinicalPearl Q&A in one MDX string", () => {
    const mdx = `
# Septic Shock

## Vasopressors

<KeyPoint>
**Q:** The first-line vasopressor in septic shock is [___]. **A:** Noradrenaline
</KeyPoint>

<Danger>
**Q:** Never give succinylcholine after [___] hours of spinal cord injury. **A:** 72
</Danger>

<ClinicalPearl>
**Q:** Troponin first rises [___] hours after MI onset. **A:** 3-4
</ClinicalPearl>
`;
    const cards = extractCardsFromContent(mdx);
    expect(cards).toHaveLength(3);
    // Order is KeyPoint, then Danger, then ClinicalPearl (wrapper order).
    expect(cards[0].back).toBe("Noradrenaline");
    expect(cards[1].back).toBe("72");
    expect(cards[2].back).toBe("3-4");
    for (const c of cards) {
      expect(c.cardType).toBe("cloze");
      expect(c.front).toContain("[___]");
    }
  });

  it("emits no cards from teaching-only components without Q&A (explicit-Q&A-only policy)", () => {
    const mdx = `
<KeyPoint>Target MAP in shock is **>=65 mmHg**.</KeyPoint>
<Danger>Never give **succinylcholine** to patients with **hyperkalaemia**.</Danger>
<ClinicalPearl>**Troponin** rises 3-4 hours after MI onset.</ClinicalPearl>
`;
    expect(extractCardsFromContent(mdx)).toHaveLength(0);
  });

  it("inherits topics from ancestor headings", () => {
    const mdx = `
# Sepsis Management

<KeyPoint>
**Q:** First-line vasopressor is [___]. **A:** Noradrenaline
</KeyPoint>
`;
    const cards = extractCardsFromContent(mdx);
    expect(cards).toHaveLength(1);
    expect(cards[0].topics).toContain("Sepsis");
  });
});

// ─── extractKeyPointCards / Danger / ClinicalPearl ───────────────────────────

describe("KeyPoint extraction", () => {
  it("extracts a Q&A card and normalises a non-cloze question into a trailing blank", () => {
    const content = `
<KeyPoint>
**Q:** What is the target MAP in septic shock? **A:** >=65 mmHg
</KeyPoint>
`;
    const cards = extractKeyPointCards(content, extractHeadings(content));
    expect(cards).toHaveLength(1);
    expect(cards[0].back).toBe(">=65 mmHg");
    expect(cards[0].front).toContain("[___]");
  });

  it("preserves an explicit context= attribute", () => {
    const content = `
# Top Level
<KeyPoint context="Noradrenaline wins per Surviving Sepsis 2021.">
**Q:** First-line vasopressor in septic shock is [___]. **A:** Noradrenaline
</KeyPoint>
`;
    const cards = extractKeyPointCards(content, extractHeadings(content));
    expect(cards).toHaveLength(1);
    expect(cards[0].context).toContain("Surviving Sepsis");
  });

  it("leaves context undefined when no context= attribute is supplied (no breadcrumb fallback)", () => {
    const content = `
# Top Level
## Sub Section
<KeyPoint>
**Q:** First-line vasopressor in septic shock is [___]. **A:** Noradrenaline
</KeyPoint>
`;
    const cards = extractKeyPointCards(content, extractHeadings(content));
    expect(cards).toHaveLength(1);
    expect(cards[0].context).toBeFalsy();
  });

  it("recognises MDX-escaped blanks and normalises to [___]", () => {
    const content = `
<KeyPoint>
**Q:** VBG pH is [\\_\\_\\_] lower than ABG. **A:** 0.02-0.04
</KeyPoint>
`;
    const cards = extractKeyPointCards(content, extractHeadings(content));
    expect(cards).toHaveLength(1);
    expect(cards[0].front).toContain("[___]");
    expect(cards[0].front).not.toContain("\\_");
    expect(cards[0].back).toBe("0.02-0.04");
  });

  it("honours complexity={1} override and defaults KeyPoint to C2", () => {
    const override = `
<KeyPoint complexity={1} context="Rate maps to underlying drive.">
**Q:** Pressured speech maps to [\\_\\_\\_] mood. **A:** elevated
</KeyPoint>
`;
    expect(extractKeyPointCards(override, extractHeadings(override))[0].complexity).toBe(1);

    const dflt = `
<KeyPoint>
**Q:** First-line vasopressor in septic shock is [\\_\\_\\_]. **A:** noradrenaline
</KeyPoint>
`;
    expect(extractKeyPointCards(dflt, extractHeadings(dflt))[0].complexity).toBe(2);
  });

  it("ignores out-of-range complexity values and falls back to the default", () => {
    const content = `
<KeyPoint complexity={5}>
**Q:** Out of range value should not stick [\\_\\_\\_]. **A:** here
</KeyPoint>
`;
    expect(extractKeyPointCards(content, extractHeadings(content))[0].complexity).toBe(2);
  });

  it("parses importance={3} and defaults to 1 when absent", () => {
    // NB kit difference from production: the contract requires a non-optional
    // `importance`, so buildCard fills `importance ?? 1`. Production left it
    // undefined; here an absent importance= attribute yields importance: 1.
    const withImp = `
<KeyPoint importance={3}>
**Q:** Normal arterial pH range is [___]. **A:** 7.35-7.45
</KeyPoint>
`;
    expect(extractKeyPointCards(withImp, extractHeadings(withImp))[0].importance).toBe(3);

    const noImp = `
<KeyPoint>
**Q:** Target MAP in septic shock is [___] mmHg. **A:** 65
</KeyPoint>
`;
    expect(extractKeyPointCards(noImp, extractHeadings(noImp))[0].importance).toBe(1);
  });

  it("generates separate cards for each Q&A pair and does not swallow trailing notes", () => {
    const content = `
<KeyPoint>
**Q:** The first-line vasopressor in septic shock is [___]. **A:** Noradrenaline

**Q:** Target MAP in septic shock is [___] mmHg. **A:** 65

Note: higher targets may be needed in chronic hypertension
</KeyPoint>
`;
    const cards = extractKeyPointCards(content, extractHeadings(content));
    expect(cards).toHaveLength(2);
    expect(cards[0].back).toBe("Noradrenaline");
    expect(cards[1].back).toBe("65");
  });

  it("strips emoji/label prefixes from the front", () => {
    const content = `
<KeyPoint>
**Q:** 🔑 KEY: When does troponin first rise? **A:** 3-4 hours
</KeyPoint>
`;
    const card = extractKeyPointCards(content, extractHeadings(content))[0];
    expect(card.front).not.toMatch(/🔑/);
    expect(card.front).not.toMatch(/KEY:/);
  });
});

describe("Danger / ClinicalPearl extraction", () => {
  it("extracts Q&A Danger cards", () => {
    const content = `
<Danger>
**Q:** Why is succinylcholine contraindicated in spinal cord injury >72h? **A:** Risk of fatal hyperkalaemia
</Danger>
`;
    const cards = extractDangerCards(content, extractHeadings(content));
    expect(cards).toHaveLength(1);
    expect(cards[0].back).toContain("hyperkalaemia");
  });

  it("extracts Q&A ClinicalPearl cards", () => {
    const content = `
<ClinicalPearl>
**Q:** When does troponin first rise after MI onset? **A:** 3-4 hours
</ClinicalPearl>
`;
    const cards = extractClinicalPearlCards(content, extractHeadings(content));
    expect(cards).toHaveLength(1);
    expect(cards[0].back).toBe("3-4 hours");
  });
});

// ─── multi-blank backs alignment (via extraction) ────────────────────────────

describe("multi-blank backs alignment", () => {
  it("truncates the backs array when more answer parts than blanks", () => {
    const content = `
<KeyPoint>
**Q:** The [___] and [___] are key.
**A:** Alpha; Beta; Gamma; Delta
</KeyPoint>
`;
    const card = extractKeyPointCards(content, extractHeadings(content))[0];
    expect(card.backs).toHaveLength(2);
    expect(card.backs).toEqual(["Alpha", "Beta"]);
    expect(card.back).toBe("Alpha");
  });

  it("falls back to a single answer when fewer parts than blanks", () => {
    const content = `
<KeyPoint>
**Q:** Give [___], [___], and [___] for this condition.
**A:** Fluids
</KeyPoint>
`;
    const card = extractKeyPointCards(content, extractHeadings(content))[0];
    expect(card.backs).toBeUndefined();
    expect(card.back).toBe("Fluids");
  });
});

// ─── alignMultiBlankAnswers (unit) ───────────────────────────────────────────

describe("alignMultiBlankAnswers", () => {
  it("returns a single answer for blankCount <= 1", () => {
    expect(alignMultiBlankAnswers("noradrenaline", 1)).toEqual({ back: "noradrenaline" });
  });

  it("splits and truncates to the blank count when parts >= blanks", () => {
    expect(alignMultiBlankAnswers("2; BiPAP; extra", 2)).toEqual({
      back: "2",
      backs: ["2", "BiPAP"],
    });
  });

  it("collapses to a single answer when parts < blanks (MDX needs fixing)", () => {
    expect(alignMultiBlankAnswers("Fluids", 3)).toEqual({ back: "Fluids" });
  });
});

// ─── extractHeadings topic extraction ────────────────────────────────────────

describe("extractHeadings", () => {
  it("strips MDX components before topic tokenisation (no phantom attribute tokens)", () => {
    const content = `\n# The Mental State Examination (<Term abbr="MSE" />)\n`;
    const headings = extractHeadings(content);
    expect(headings).toHaveLength(1);
    expect(headings[0].topics).not.toContain("Term");
    expect(headings[0].topics).not.toContain("abbr");
    expect(headings[0].topics).toContain("Mental");
    expect(headings[0].topics).toContain("MSE");
  });

  it("splits multi-topic chapter titles (comma + ampersand) into individual topics", () => {
    const content = `\n# Week 5: Cardiology, Developmental, Dermatology & Endocrinology\n`;
    const headings = extractHeadings(content);
    expect(headings[0].topics).toContain("Cardiology");
    expect(headings[0].topics).toContain("Endocrinology");
    expect(headings[0].topics).not.toContain(
      "Cardiology, Developmental, Dermatology & Endocrinology",
    );
  });

  it("picks up paren-delimited acronyms but not synthesised initials", () => {
    const synthesised = `\n## Borderline Personality Disorder in Detail\n`;
    const sTopics = extractHeadings(synthesised)[0].topics;
    expect(sTopics).not.toContain("BPDD");
    expect(sTopics).toContain("Borderline");

    const paren = `\n## Borderline Personality Disorder (BPD)\n`;
    expect(extractHeadings(paren)[0].topics).toContain("BPD");
  });
});

// ─── parseQAPairs ────────────────────────────────────────────────────────────

describe("parseQAPairs", () => {
  it("extracts a single Q&A pair", () => {
    const pairs = parseQAPairs("**Q:** What is X? **A:** Y");
    expect(pairs).toEqual([{ question: "What is X?", answer: "Y" }]);
  });

  it("extracts multiple Q&A pairs", () => {
    const pairs = parseQAPairs("**Q:** Q1 [___]. **A:** A1\n\n**Q:** Q2 [___]. **A:** A2");
    expect(pairs).toHaveLength(2);
    expect(pairs[0].answer).toBe("A1");
    expect(pairs[1].answer).toBe("A2");
  });

  it("trims the answer at trailing bullet teaching notes", () => {
    const pairs = parseQAPairs(
      "**Q:** What is naloxone titrated in? **A:** 100 microgram IV aliquots\n- Observe for renarcotisation",
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].answer).toBe("100 microgram IV aliquots");
  });

  it("returns an empty array when there is no Q&A", () => {
    expect(parseQAPairs("Just some bold **text** here.")).toHaveLength(0);
  });
});

// ─── stripMdxComponents (entity / escape decoding) ───────────────────────────

describe("stripMdxComponents", () => {
  it("decodes HTML entities", () => {
    expect(stripMdxComponents("BP &lt;90/60 &amp; HR &gt;100")).toBe("BP <90/60 & HR >100");
  });

  it("converts JSX expression escapes {'<'} / {'>'}", () => {
    expect(stripMdxComponents("Hb {'<'}70 g/L")).toBe("Hb <70 g/L");
  });

  it("converts backslash escapes \\< and \\>", () => {
    expect(stripMdxComponents("HR \\<100")).toBe("HR <100");
  });

  it("unwraps WikiLink display text", () => {
    expect(stripMdxComponents('<WikiLink slug="sepsis">Sepsis</WikiLink> management')).toBe(
      "Sepsis management",
    );
  });
});

// ─── context-quality helpers ─────────────────────────────────────────────────

describe("context-quality helpers", () => {
  it("isMissingContext treats null/undefined/blank as missing", () => {
    expect(isMissingContext(null)).toBe(true);
    expect(isMissingContext(undefined)).toBe(true);
    expect(isMissingContext("   ")).toBe(true);
    expect(isMissingContext("Pyloric stenosis traps gastric contents.")).toBe(false);
  });

  it("isStubContext flags acronym=expansion stubs and known placeholders", () => {
    expect(isStubContext("MCD = minimal change disease.")).toBe(true);
    expect(isStubContext("RSV stands for respiratory syncytial virus")).toBe(true);
    expect(isStubContext("See per-option explanations.")).toBe(true);
    expect(isStubContext("N/A")).toBe(true);
  });

  it("isStubContext does not flag real teaching contexts", () => {
    expect(
      isStubContext(
        "MAOI = monoamine oxidase inhibitor. The 'cheese reaction' occurs because MAOIs prevent tyramine breakdown.",
      ),
    ).toBe(false);
    expect(isStubContext("Treatment: trauma-focused CBT, EMDR, SSRIs.")).toBe(false);
    expect(isStubContext(null)).toBe(false);
  });

  it("restatesAnswer flags an echo and spares a real teaching context", () => {
    expect(restatesAnswer("Noradrenaline is the first-line vasopressor.", "noradrenaline")).toBe(
      true,
    );
    const teaching =
      "Noradrenaline is preferred because dopamine causes more arrhythmias and was downgraded by SSC 2021. Adrenaline is reserved for refractory shock.";
    expect(restatesAnswer(teaching, "noradrenaline")).toBe(false);
    expect(restatesAnswer("Raises MAP via alpha-1 agonism.", "noradrenaline")).toBe(false);
  });
});
