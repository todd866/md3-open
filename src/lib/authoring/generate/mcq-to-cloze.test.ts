/**
 * Tests for the mcq-to-cloze kit module.
 *
 * The kit reshapes production's `mcqToCloze(stem, answer): string | null` into
 * `mcqToCloze(q: AuthoringQuestion): AuthoringCard | null`. The stem→statement
 * logic is exposed separately as `stemToClozeStatement(stem)`, so production's
 * string-shape cases are ported against THAT, and the skip/omit gates are ported
 * against `shouldSkipClozeConversion` / `shouldOmitMcqCard`. Wrapper-level tests
 * exercise `mcqToCloze` on full `AuthoringQuestion`s (incl. a skip case).
 */

import { describe, it, expect } from "vitest";
import {
  mcqToCloze,
  shouldSkipClozeConversion,
  shouldOmitMcqCard,
  stemToClozeStatement,
  trimAnswerForCloze,
} from "./mcq-to-cloze";
import type { AuthoringQuestion, McqOption } from "../contracts";

// helper: build a minimal AuthoringQuestion with one correct option.
function mcq(
  stem: string,
  correctText: string,
  extra: Partial<AuthoringQuestion> = {},
): AuthoringQuestion {
  const options: McqOption[] = [
    { label: "A", text: correctText, isCorrect: true },
    { label: "B", text: "(distractor)", isCorrect: false },
  ];
  return {
    cardType: "mcq",
    stem,
    options,
    complexity: 2,
    importance: 1,
    topics: ["topic"],
    ...extra,
  };
}

// ─── stemToClozeStatement: the ported string-pattern cases ───────────────────

describe("stemToClozeStatement", () => {
  it('converts "What is the X for Y?" into a statement with a blank', () => {
    expect(stemToClozeStatement("What is the first-line treatment for anaphylaxis?")).toBe(
      "The first-line treatment for anaphylaxis is [___].",
    );
  });

  it("preserves a clinical scenario before the question, separated by a blank line", () => {
    const result = stemToClozeStatement(
      "A 60-year-old diabetic presents with chest pain. ECG shows ST elevation in leads II, III, and aVF. Which coronary artery is MOST likely occluded?",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("ST elevation in leads II, III, and aVF");
    expect(result).toContain("[___]");
    expect(result).toMatch(/\n\n/);
  });

  it('"What [noun] is characteristic of X?" → "The [noun] characteristic of X is [___]."', () => {
    expect(stemToClozeStatement("What ECG finding is typical of hyperkalaemia?")).toBe(
      "The ECG finding typical of hyperkalaemia is [___].",
    );
  });

  it('"What [noun] defines X?" → "The [noun] that defines X is [___]."', () => {
    expect(stemToClozeStatement("What P/F ratio defines moderate ARDS?")).toBe(
      "The P/F ratio that defines moderate ARDS is [___].",
    );
  });

  it('"How long before X should Y be stopped?" reorders correctly', () => {
    expect(
      stemToClozeStatement("How long before the procedure should rivaroxaban be stopped?"),
    ).toBe("Rivaroxaban should be stopped [___] before the procedure.");
  });

  it("\"Why can't X be Y?\" → \"X can't be Y because [___].\"", () => {
    expect(
      stemToClozeStatement(
        "Why can't paracetamol levels be interpreted before 4 hours post-ingestion?",
      ),
    ).toBe("Paracetamol levels can't be interpreted before 4 hours post-ingestion because [___].");
  });

  it('"When is X indicated in Y?" → "X is indicated in Y when [___]."', () => {
    expect(stemToClozeStatement("When is BiPAP indicated in COPD exacerbation?")).toBe(
      "BiPAP is indicated in COPD exacerbation when [___].",
    );
  });

  it('"What should you do FIRST?" → "The first step is [___]."', () => {
    expect(stemToClozeStatement("What should you do FIRST?")).toBe("The first step is [___].");
  });

  it('"What distinguishes X from Y?" reorders into the distinguishing-finding form', () => {
    expect(
      stemToClozeStatement("What distinguishes cardiogenic from hypovolaemic shock on examination?"),
    ).toBe(
      "The finding that distinguishes cardiogenic from hypovolaemic shock on examination is [___].",
    );
  });

  it('"What does X stand for in Y?" → "In Y, X stands for [___]."', () => {
    expect(stemToClozeStatement("What does AVPU stand for in rapid neurological assessment?")).toBe(
      "In rapid neurological assessment, AVPU stands for [___].",
    );
  });

  it('"Which is the best X for Y?" matches the What-is-the variant', () => {
    expect(stemToClozeStatement("Which is the best initial test for hypothyroidism?")).toBe(
      "The best initial test for hypothyroidism is [___].",
    );
  });

  it('"Which [noun] verb Y?" → "The [noun] that verb Y is [___]." (no "The is the" garbage)', () => {
    const result = stemToClozeStatement("Which ECG feature confirms STEMI?");
    expect(result).toBe("The ECG feature that confirms STEMI is [___].");
    expect(result).not.toMatch(/\bThe\s+is\s+the\b/);
  });

  it("returns null when the conversion still starts with a question word", () => {
    // No pattern matches; fallback yields a "What ..." statement → rejected.
    expect(
      stemToClozeStatement(
        "What immediate action is needed before placing her in the recovery position?",
      ),
    ).toBeNull();
  });

  it("returns null for a verbless colon fragment fallback", () => {
    expect(stemToClozeStatement("How is this condition managed.")).toBeNull();
  });

  it("converts a colon-ended declarative stem via the colon pattern", () => {
    expect(stemToClozeStatement("The treatment includes:")).toBe("The treatment includes [___].");
  });

  it("never duplicates the blank", () => {
    const result = stemToClozeStatement("What is the most likely diagnosis?");
    const blanks = (result!.match(/\[___\]/g) ?? []).length;
    expect(blanks).toBe(1);
  });
});

// ─── shouldSkipClozeConversion ───────────────────────────────────────────────

describe("shouldSkipClozeConversion", () => {
  it('skips "Which of the following" stems', () => {
    expect(
      shouldSkipClozeConversion("Which of the following rhythms requires defibrillation?", "VF"),
    ).toBe(true);
  });

  it('skips "Which set/combination" stems', () => {
    expect(
      shouldSkipClozeConversion(
        "Which set correctly lists the reversible causes of cardiac arrest?",
        "Hypoxia, Hypovolaemia, Hypothermia",
      ),
    ).toBe(true);
    expect(
      shouldSkipClozeConversion(
        "Which combination best describes the haemodynamic profile of septic shock?",
        "High CO, low SVR, low PCWP",
      ),
    ).toBe(true);
  });

  it("skips answers longer than two words; keeps 1-2 word answers", () => {
    expect(shouldSkipClozeConversion("What is the management?", "Give IV fluids")).toBe(true);
    expect(shouldSkipClozeConversion("What is the first-line treatment?", "IM adrenaline")).toBe(
      false,
    );
  });

  it("does NOT skip a normal single-fact MCQ stem", () => {
    expect(
      shouldSkipClozeConversion("What is the first-line vasopressor in septic shock?", "Noradrenaline"),
    ).toBe(false);
  });

  it("skips list-asking stems with comma/conjunction answers", () => {
    expect(
      shouldSkipClozeConversion(
        "What are the main risk factors for retinopathy of prematurity (ROP)?",
        "Low gestational age, low birth weight, and supplemental oxygen",
      ),
    ).toBe(true);
    expect(shouldSkipClozeConversion("List the components of the GCS.", "Eyes, Verbal, Motor")).toBe(
      true,
    );
  });

  it('skips "characteristic/common/recognised symptom/side-effect of" (one-of-many) stems', () => {
    expect(
      shouldSkipClozeConversion("What is a characteristic symptom of cholinergic toxicity?", "Salivation"),
    ).toBe(true);
    expect(shouldSkipClozeConversion("What is a common side effect of morphine?", "Nausea")).toBe(
      true,
    );
  });

  it('keeps "What is THE characteristic finding" (definite article = single answer)', () => {
    expect(
      shouldSkipClozeConversion(
        "What is the characteristic ECG finding of hyperkalaemia?",
        "Hyperkalaemia",
      ),
    ).toBe(false);
  });

  it("skips negative stems (NOT / EXCEPT / LEAST likely)", () => {
    expect(
      shouldSkipClozeConversion(
        "Which property is NOT a criterion for effective renal replacement therapy?",
        "High protein binding",
      ),
    ).toBe(true);
    expect(
      shouldSkipClozeConversion("All of the following are causes of metabolic acidosis EXCEPT?", "Vomiting"),
    ).toBe(true);
    expect(
      shouldSkipClozeConversion("Which diagnosis is LEAST likely in this patient?", "PE"),
    ).toBe(true);
  });

  it('does NOT treat "not" inside a word as a negative stem', () => {
    expect(shouldSkipClozeConversion("What is the notable finding on this ECG?", "ST elevation")).toBe(
      false,
    );
  });

  it("accepts vignette stems up to 500 chars and skips true walls of text", () => {
    const longStem =
      "A 68-year-old male fell 4 meters from a ladder. He has Type 2 Diabetes and takes insulin. Vital signs are: HR 115 bpm, BP 90/60 mmHg, Temp 35.1C, and BGL 3.2 mmol/L. His GCS is 13. What is the approach?";
    expect(shouldSkipClozeConversion(longStem, "Tourniquets")).toBe(false);

    const wall = "A ".padEnd(550, "long clinical narrative ") + "What is the diagnosis?";
    expect(shouldSkipClozeConversion(wall, "Sepsis")).toBe(true);
  });
});

// ─── shouldOmitMcqCard ───────────────────────────────────────────────────────

describe("shouldOmitMcqCard", () => {
  it("omits all/none-of-the-above answers", () => {
    expect(
      shouldOmitMcqCard(
        "Which finding is NOT a red flag in a dyspnoeic patient?",
        "All of the above are red flags of dyspnoea",
      ),
    ).toBe(true);
    expect(shouldOmitMcqCard("Which option is correct?", "None of the above")).toBe(true);
  });

  it("keeps a normal short-answer MCQ", () => {
    expect(shouldOmitMcqCard("Which ECG change occurs first in hyperkalemia?", "Peaked T waves")).toBe(
      false,
    );
  });
});

// ─── trimAnswerForCloze ──────────────────────────────────────────────────────

describe("trimAnswerForCloze", () => {
  it("drops a trailing parenthetical and leading article", () => {
    expect(trimAnswerForCloze("Right coronary artery (RCA)")).toBe("Right coronary artery");
    expect(trimAnswerForCloze("the kidneys")).toBe("kidneys");
  });

  it("returns null for empty or generic filler answers", () => {
    expect(trimAnswerForCloze("")).toBeNull();
    expect(trimAnswerForCloze("none of the above")).toBeNull();
    expect(trimAnswerForCloze("yes")).toBeNull();
  });
});

// ─── mcqToCloze: the AuthoringQuestion wrapper ───────────────────────────────

describe("mcqToCloze (AuthoringQuestion → AuthoringCard | null)", () => {
  it("derives a cloze card carrying over complexity/importance/topics/cite + a :cloze stableId", () => {
    const card = mcqToCloze(
      mcq("What is the first-line vasopressor in septic shock?", "Noradrenaline", {
        complexity: 3,
        importance: 2,
        topics: ["shock", "vasopressor"],
        cite: "doi:10.1000/x",
        stableId: "bank:42",
      }),
    );
    expect(card).not.toBeNull();
    expect(card!.cardType).toBe("cloze");
    expect(card!.front).toBe("The first-line vasopressor in septic shock is [___].");
    expect(card!.back).toBe("Noradrenaline");
    expect(card!.complexity).toBe(3);
    expect(card!.importance).toBe(2);
    expect(card!.topics).toEqual(["shock", "vasopressor"]);
    expect(card!.cite).toBe("doi:10.1000/x");
    expect(card!.stableId).toBe("bank:42:cloze");
  });

  it("uses the correct option's explanation as the post-miss context", () => {
    const q = mcq("What is the best initial test for hypothyroidism?", "TSH");
    q.options[0].explanation = "TSH is the most sensitive screen for primary hypothyroidism.";
    const card = mcqToCloze(q);
    expect(card!.context).toBe("TSH is the most sensitive screen for primary hypothyroidism.");
  });

  it("returns null when there is no correct option", () => {
    const q = mcq("What is X?", "answer");
    q.options = q.options.map((o) => ({ ...o, isCorrect: false }));
    expect(mcqToCloze(q)).toBeNull();
  });

  it("SKIP CASE: returns null for a 'Which of the following' stem (skip gate fires)", () => {
    expect(
      mcqToCloze(mcq("Which of the following rhythms requires defibrillation?", "Fine VF")),
    ).toBeNull();
  });

  it("SKIP CASE: returns null when the answer is too long for a cloze blank", () => {
    expect(
      mcqToCloze(mcq("What is the first-line treatment?", "IM adrenaline 0.5 mg stat")),
    ).toBeNull();
  });

  it("returns null when the answer is an all/none-of-the-above filler (omit gate)", () => {
    expect(mcqToCloze(mcq("Which option is correct?", "None of the above"))).toBeNull();
  });
});
