/**
 * Generation-time complexity estimation (heuristic, DB-free).
 *
 * Ported from md3's manifold/difficulty.ts. The production version mixed in an
 * empirical `facilityIndex` (observed pass-rate from the DB) and a manifold
 * `similarityAvgTopK` (vector-store uniqueness). Both are DROPPED here — they
 * require runtime data this kit deliberately does not carry. What remains is the
 * pure content heuristic available at authoring time: a base from the declared
 * complexity tier, plus token-load and numeric-load signals read off the text.
 *
 * The public entry point is `estimateComplexity(item)`, which returns a
 * `Complexity` tier (1|2|3) per the authoring contracts. The intermediate
 * 0–1 score and signals are also exported for callers that want the detail.
 */

import type { AuthoredItem, Complexity } from "@/lib/authoring/contracts";

export type DifficultySignals = {
  base: number;
  tokenLoad: number;
  numericLoad: number;
};

export type DifficultyEstimate = {
  /** Continuous 0–1 difficulty score. */
  score: number;
  /** Discretised complexity tier (1|2|3). */
  complexity: Complexity;
  signals: DifficultySignals;
};

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeLinear(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  if (high <= low) return value >= high ? 1 : 0;
  return clamp01((value - low) / (high - low));
}

function countNumbers(text: string): number {
  const matches = text.match(/[-+]?\d+(?:\.\d+)?/g);
  return matches?.length ?? 0;
}

function countUnits(text: string): number {
  const matches = text.match(
    /\b(mg|mcg|g|mL|L|mmol|mmhg|bpm|°c|%|kg|cm|mm|hours?|mins?|minutes?|days?|weeks?)\b/gi,
  );
  return matches?.length ?? 0;
}

/** Map a 0–1 difficulty score to a complexity tier. */
export function complexityFromScore(score: number): Complexity {
  if (score >= 0.65) return 3;
  if (score >= 0.4) return 2;
  return 1;
}

/** Heuristic difficulty for a cloze card (text + numeric signals). */
function estimateCardDifficulty(card: {
  complexity: Complexity;
  front: string;
  back: string;
  context?: string | null;
}): DifficultyEstimate {
  const baseByComplexity: Record<Complexity, number> = { 1: 0.22, 2: 0.5, 3: 0.82 };
  const base = baseByComplexity[card.complexity] ?? 0.5;

  const fullText = [card.front, card.back, card.context ?? ""].filter(Boolean).join("\n\n");
  const tokenLoad = normalizeLinear(estimateTokens(fullText), 15, 140);
  const numericLoad = clamp01(
    0.7 * normalizeLinear(countNumbers(fullText), 0, 6) +
      0.3 * normalizeLinear(countUnits(fullText), 0, 6),
  );

  const signals: DifficultySignals = { base, tokenLoad, numericLoad };

  // Weighted mix (content-first). The manifold uniqueness term is dropped.
  const score = clamp01(0.6 * base + 0.25 * tokenLoad + 0.15 * numericLoad);

  return { score, complexity: complexityFromScore(score), signals };
}

/** Heuristic difficulty for an MCQ (stem + options + numeric signals). */
function estimateQuestionDifficulty(question: {
  complexity: Complexity;
  stem: string;
  options: Array<{ text: string }>;
  context?: string | null;
  topics?: string[] | null;
}): DifficultyEstimate {
  const baseByComplexity: Record<Complexity, number> = { 1: 0.4, 2: 0.55, 3: 0.78 };
  const declaredBase = baseByComplexity[question.complexity] ?? 0.55;

  const optionsText = question.options.map((o) => o.text).join("\n");
  const fullText = [question.stem, optionsText, question.context ?? ""]
    .filter(Boolean)
    .join("\n\n");

  const tokenLoad = normalizeLinear(estimateTokens(fullText), 25, 180);
  const numericLoad = clamp01(
    0.7 * normalizeLinear(countNumbers(fullText), 0, 10) +
      0.3 * normalizeLinear(countUnits(fullText), 0, 10),
  );

  // Topic breadth is a weak proxy for concept count.
  const topicBreadth = normalizeLinear(question.topics?.length ?? 0, 0, 6);
  const base = clamp01(declaredBase + 0.08 * (topicBreadth - 0.5));

  const signals: DifficultySignals = { base, tokenLoad, numericLoad };

  const score = clamp01(0.55 * base + 0.3 * tokenLoad + 0.15 * numericLoad);

  return { score, complexity: complexityFromScore(score), signals };
}

/**
 * Full heuristic estimate for any authored item, including the 0–1 score and
 * the contributing signals.
 */
export function estimateDifficulty(item: AuthoredItem): DifficultyEstimate {
  if (item.cardType === "mcq") {
    return estimateQuestionDifficulty({
      complexity: item.complexity,
      stem: item.stem,
      options: item.options,
      context: item.explanation,
      topics: item.topics,
    });
  }
  return estimateCardDifficulty({
    complexity: item.complexity,
    front: item.front,
    back: item.back,
    context: item.context,
  });
}

/**
 * Estimate the complexity tier (1|2|3) of an authored item from its content.
 * This is the generation-time heuristic — it does not consult any observed
 * pass-rate or vector store.
 */
export function estimateComplexity(item: AuthoredItem): Complexity {
  return estimateDifficulty(item).complexity;
}
