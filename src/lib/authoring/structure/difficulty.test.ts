/**
 * Tests for the structure/difficulty kit module.
 *
 * Adapted from md3 production `manifold/difficulty.test.ts`. The kit drops the
 * empirical/manifold terms and exposes `estimateComplexity(item)` (1|2|3) plus
 * `estimateDifficulty(item)` (score + signals) over the AuthoredItem contract,
 * and `complexityFromScore(score)`. Inputs here are built as contract
 * AuthoringCard / AuthoringQuestion values.
 */

import { describe, it, expect } from "vitest";
import {
  estimateComplexity,
  estimateDifficulty,
  complexityFromScore,
} from "./difficulty";
import type { AuthoringCard, AuthoringQuestion } from "../contracts";

describe("complexityFromScore", () => {
  it("maps scores into 1|2|3 tiers at the 0.4 / 0.65 thresholds", () => {
    expect(complexityFromScore(0)).toBe(1);
    expect(complexityFromScore(0.39)).toBe(1);
    expect(complexityFromScore(0.4)).toBe(2);
    expect(complexityFromScore(0.64)).toBe(2);
    expect(complexityFromScore(0.65)).toBe(3);
    expect(complexityFromScore(1)).toBe(3);
  });
});

describe("estimateDifficulty / estimateComplexity", () => {
  it("scores a long numeric MCQ harder than a trivial scaffold cloze", () => {
    const trivial: AuthoringCard = {
      cardType: "cloze",
      complexity: 1,
      front: 'COACHED: "A" stands for [___]',
      back: "Airway",
      topics: ["acls"],
      importance: 1,
    };
    const numericMcq: AuthoringQuestion = {
      cardType: "mcq",
      complexity: 3,
      stem: "A 38-year-old man with significant alcohol intake presents with hematemesis. Vitals: HR 110 bpm, BP 100/55 mmHg, RR 15/min. Labs: Hgb 8.1 g/dL, INR 1.4, bilirubin 2.2 mg/dL, albumin 3.0 g/dL. Which transfusion threshold is correct?",
      options: [
        { label: "A", text: "Transfuse if Hgb < 7 g/dL", isCorrect: true },
        { label: "B", text: "Transfuse if Hgb < 9 g/dL", isCorrect: false },
        { label: "C", text: "Always activate massive transfusion protocol", isCorrect: false },
        { label: "D", text: "Never transfuse above 7 g/dL", isCorrect: false },
      ],
      explanation: "Use restrictive thresholds unless specific indications.",
      topics: ["gi bleed", "transfusion"],
      importance: 2,
    };

    const trivialEst = estimateDifficulty(trivial);
    const mcqEst = estimateDifficulty(numericMcq);

    expect(trivialEst.score).toBeLessThan(mcqEst.score);
    expect(estimateComplexity(trivial)).toBe(1);
    expect(estimateComplexity(numericMcq)).toBe(3);
  });

  it("scores a numeric-heavy question above a short recall question", () => {
    const recall: AuthoringQuestion = {
      cardType: "mcq",
      complexity: 2,
      stem: "What is the first-line treatment for anaphylaxis?",
      options: [
        { label: "A", text: "IM adrenaline", isCorrect: true },
        { label: "B", text: "IV hydrocortisone", isCorrect: false },
        { label: "C", text: "Oral antihistamine", isCorrect: false },
      ],
      topics: ["anaphylaxis"],
      importance: 1,
    };
    const numeric: AuthoringQuestion = {
      cardType: "mcq",
      complexity: 2,
      stem: "Hgb 8.1 g/dL, INR 1.4, bilirubin 2.2 mg/dL, albumin 3.0 g/dL, HR 110 bpm, BP 100/55 mmHg over 15 min. Which value crosses the restrictive transfusion threshold of 7 g/dL at 6 mL/kg?",
      options: [
        { label: "A", text: "Hgb 8.1 g/dL", isCorrect: true },
        { label: "B", text: "INR 1.4", isCorrect: false },
        { label: "C", text: "Albumin 3.0 g/dL", isCorrect: false },
      ],
      topics: ["transfusion"],
      importance: 1,
    };

    expect(estimateDifficulty(recall).score).toBeLessThan(estimateDifficulty(numeric).score);
  });

  it("exposes the contributing signals and a clamped 0–1 score", () => {
    const card: AuthoringCard = {
      cardType: "cloze",
      complexity: 2,
      front: "Target MAP in septic shock is [___] mmHg.",
      back: "65",
      topics: ["shock"],
      importance: 1,
    };
    const est = estimateDifficulty(card);
    expect(est.score).toBeGreaterThanOrEqual(0);
    expect(est.score).toBeLessThanOrEqual(1);
    expect(est.signals.base).toBeCloseTo(0.5, 5); // C2 base for a cloze
    expect(est.signals.tokenLoad).toBeGreaterThanOrEqual(0);
    expect(est.signals.numericLoad).toBeGreaterThan(0); // has a number + a unit
    expect(est.complexity).toBe(complexityFromScore(est.score));
  });
});
