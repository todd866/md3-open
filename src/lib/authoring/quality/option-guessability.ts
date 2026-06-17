/**
 * Option guessability — detects patterns that let a test-wise student pick the
 * correct MCQ answer without domain knowledge.
 *
 * Ported verbatim-in-logic from md3 production (`manifold/option-guessability.ts`).
 * No DB or services: pure analysis over the option block. The signals are:
 *   1. length asymmetry      — correct is much longer/shorter
 *   2. qualifier asymmetry    — only one option hedges ("usually", "typically")
 *   3. absolute-term trap      — distractors over-use "always/never" (classic trap)
 *   4. specificity asymmetry  — one option carries all the numbers/doses/timeframes
 *   5. parenthetical tell      — only one option has "(e.g., …)"
 *   6. sophistication asymmetry — terminology density varies sharply
 *
 * Operates on `McqOption` (the contract type) directly; `analyzeGuessability`
 * accepts a raw option list and `runGuessabilityGate` adapts an `AuthoringQuestion`.
 */

import type { AuthoringQuestion, McqOption, QualityGate, QualityIssue } from '@/lib/authoring/contracts';

export interface GuessabilityProfile {
  /** Overall guessability (0–1, higher = more guessable). */
  score: number;
  signals: {
    lengthAsymmetry: number;
    qualifierAsymmetry: number;
    absoluteTermTrap: number;
    specificityAsymmetry: number;
    parentheticalTell: number;
    sophisticationAsymmetry: number;
  };
  issues: string[];
  /** Which option label the tells flag as correct, if a consensus exists. */
  likelyCorrectByTell: string | null;
}

/** Minimal option shape the analyzer needs (a structural subset of `McqOption`). */
type Option = Pick<McqOption, 'label' | 'text'> & { isCorrect?: boolean };

// Hedging/qualifier patterns (suggest the careful, accurate answer).
const QUALIFIER_PATTERNS = [
  /\b(usually|typically|often|generally|commonly|frequently)\b/gi,
  /\b(in most cases|most likely|most commonly)\b/gi,
  /\b(may|might|can|could)\b/gi,
  /\b(tends to|is likely to)\b/gi,
  /\b(approximately|about|around)\b/gi,
];

// Absolute terms (often mark wrong answers — "too absolute to be true").
const ABSOLUTE_PATTERNS = [
  /\b(always|never|only|all|none|every|no)\b/gi,
  /\b(must|cannot|will not|definitely)\b/gi,
  /\b(exclusively|invariably|absolutely)\b/gi,
];

const PARENTHETICAL_PATTERN = /\([^)]+\)/g;

const SPECIFICITY_PATTERNS = [
  /\d+\s*(?:mg|mcg|g|mL|L|mmol|mEq|units?|IU)/gi, // dosages
  /\d+\s*(?:hours?|days?|weeks?|months?|years?)/gi, // timeframes
  /\d+(?:\.\d+)?%/g, // percentages
  /\d+-\d+/g, // ranges
];

const MEDICAL_TERM_PATTERNS = [
  /\b\w+(?:itis|osis|emia|uria|pathy|trophy|plasia|ectomy|otomy|plasty)\b/gi,
  /\b(?:hyper|hypo|anti|pre|post|peri|intra|extra)\w+/gi,
  /\b[A-Z]{2,5}\b/g, // acronyms like ECG, CT, MRI
];

function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    count += matches?.length || 0;
  }
  return count;
}

function analyzeLengthAsymmetry(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const lengths = options.map((o) => ({ label: o.label, len: o.text.length }));
  const mean = lengths.reduce((s, o) => s + o.len, 0) / lengths.length;
  const variance = lengths.reduce((s, o) => s + Math.pow(o.len - mean, 2), 0) / lengths.length;
  const stddev = Math.sqrt(variance);
  const cv = mean > 0 ? stddev / mean : 0;

  const sorted = [...lengths].sort((a, b) => a.len - b.len);
  const shortest = sorted[0];
  const longest = sorted[sorted.length - 1];

  const shortestZScore = mean > 0 ? (shortest.len - mean) / (stddev || 1) : 0;
  const longestZScore = mean > 0 ? (longest.len - mean) / (stddev || 1) : 0;

  let issue: string | null = null;
  let likelyCorrect: string | null = null;

  if (cv > 0.4) {
    if (Math.abs(shortestZScore) > 1.5) {
      issue = `Option ${shortest.label} is much shorter than others`;
      likelyCorrect = shortest.label;
    } else if (Math.abs(longestZScore) > 1.5) {
      issue = `Option ${longest.label} is much longer than others`;
      likelyCorrect = longest.label;
    } else {
      issue = 'High length variance across options';
    }
  }

  return { score: Math.min(1, cv), issue, likelyCorrect };
}

function analyzeQualifierAsymmetry(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({ label: o.label, count: countMatches(o.text, QUALIFIER_PATTERNS) }));
  const total = counts.reduce((s, o) => s + o.count, 0);
  if (total === 0) return { score: 0, issue: null, likelyCorrect: null };

  const sorted = [...counts].sort((a, b) => b.count - a.count);
  const highest = sorted[0];
  const secondHighest = sorted[1];

  if (highest.count > 0 && secondHighest.count === 0) {
    return { score: 0.8, issue: `Only option ${highest.label} uses hedging language`, likelyCorrect: highest.label };
  }
  if (highest.count >= 3 && highest.count > secondHighest.count * 2) {
    return { score: 0.6, issue: `Option ${highest.label} hedges much more than others`, likelyCorrect: highest.label };
  }
  return { score: 0, issue: null, likelyCorrect: null };
}

function analyzeAbsoluteTerms(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({ label: o.label, count: countMatches(o.text, ABSOLUTE_PATTERNS) }));
  const withAbsolutes = counts.filter((c) => c.count > 0);
  const withoutAbsolutes = counts.filter((c) => c.count === 0);

  if (withoutAbsolutes.length === 1 && withAbsolutes.length >= 2) {
    return {
      score: 0.7,
      issue: `Most options use absolute terms except ${withoutAbsolutes[0].label}`,
      likelyCorrect: withoutAbsolutes[0].label,
    };
  }

  const maxAbsolutes = Math.max(...counts.map((c) => c.count));
  if (maxAbsolutes >= 2) {
    const withMost = counts.find((c) => c.count === maxAbsolutes);
    return {
      score: 0.4,
      issue: `Option ${withMost?.label} uses multiple absolute terms`,
      likelyCorrect: null,
    };
  }

  return { score: 0, issue: null, likelyCorrect: null };
}

function analyzeParentheticals(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({ label: o.label, count: (o.text.match(PARENTHETICAL_PATTERN) || []).length }));
  const withParens = counts.filter((c) => c.count > 0);
  const withoutParens = counts.filter((c) => c.count === 0);

  if (withParens.length === 1 && withoutParens.length >= 2) {
    return {
      score: 0.7,
      issue: `Only option ${withParens[0].label} has parenthetical explanation`,
      likelyCorrect: withParens[0].label,
    };
  }
  return { score: 0, issue: null, likelyCorrect: null };
}

function analyzeSpecificity(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const counts = options.map((o) => ({ label: o.label, count: countMatches(o.text, SPECIFICITY_PATTERNS) }));
  const maxSpec = Math.max(...counts.map((c) => c.count));
  const minSpec = Math.min(...counts.map((c) => c.count));
  if (maxSpec === 0) return { score: 0, issue: null, likelyCorrect: null };

  const mostSpecific = counts.filter((c) => c.count === maxSpec);
  if (mostSpecific.length === 1 && maxSpec >= 2 && minSpec === 0) {
    return {
      score: 0.6,
      issue: `Option ${mostSpecific[0].label} is much more specific than others`,
      likelyCorrect: mostSpecific[0].label,
    };
  }
  return { score: 0, issue: null, likelyCorrect: null };
}

function analyzeSophistication(options: Option[]): {
  score: number;
  issue: string | null;
  likelyCorrect: string | null;
} {
  const densities = options.map((o) => {
    const termCount = countMatches(o.text, MEDICAL_TERM_PATTERNS);
    const wordCount = o.text.split(/\s+/).length;
    return { label: o.label, density: wordCount > 0 ? termCount / wordCount : 0 };
  });

  const maxDensity = Math.max(...densities.map((d) => d.density));
  const minDensity = Math.min(...densities.map((d) => d.density));
  if (maxDensity - minDensity < 0.1) return { score: 0, issue: null, likelyCorrect: null };

  const mostSophisticated = densities.find((d) => d.density === maxDensity);
  if (maxDensity > minDensity * 2 && maxDensity > 0.2) {
    return {
      score: 0.5,
      issue: `Option ${mostSophisticated?.label} uses more medical terminology`,
      likelyCorrect: mostSophisticated?.label || null,
    };
  }
  return { score: 0, issue: null, likelyCorrect: null };
}

/**
 * Analyze all guessability signals for an option list. Higher score = more
 * detectable by a test-taking strategy that ignores content.
 */
export function analyzeGuessability(options: Option[]): GuessabilityProfile {
  if (options.length < 2) {
    return {
      score: 0,
      signals: {
        lengthAsymmetry: 0,
        qualifierAsymmetry: 0,
        absoluteTermTrap: 0,
        specificityAsymmetry: 0,
        parentheticalTell: 0,
        sophisticationAsymmetry: 0,
      },
      issues: [],
      likelyCorrectByTell: null,
    };
  }

  const length = analyzeLengthAsymmetry(options);
  const qualifier = analyzeQualifierAsymmetry(options);
  const absolute = analyzeAbsoluteTerms(options);
  const parenthetical = analyzeParentheticals(options);
  const specificity = analyzeSpecificity(options);
  const sophistication = analyzeSophistication(options);

  const issues: string[] = [];
  if (length.issue) issues.push(length.issue);
  if (qualifier.issue) issues.push(qualifier.issue);
  if (absolute.issue) issues.push(absolute.issue);
  if (parenthetical.issue) issues.push(parenthetical.issue);
  if (specificity.issue) issues.push(specificity.issue);
  if (sophistication.issue) issues.push(sophistication.issue);

  const candidates = [
    length.likelyCorrect,
    qualifier.likelyCorrect,
    absolute.likelyCorrect,
    parenthetical.likelyCorrect,
    specificity.likelyCorrect,
    sophistication.likelyCorrect,
  ].filter(Boolean) as string[];

  const candidateCounts: Record<string, number> = {};
  for (const c of candidates) candidateCounts[c] = (candidateCounts[c] || 0) + 1;
  const sortedCandidates = Object.entries(candidateCounts).sort((a, b) => b[1] - a[1]);
  const likelyCorrectByTell =
    sortedCandidates.length > 0 && sortedCandidates[0][1] >= 2 ? sortedCandidates[0][0] : null;

  const score =
    length.score * 0.25 +
    qualifier.score * 0.2 +
    absolute.score * 0.15 +
    parenthetical.score * 0.15 +
    specificity.score * 0.15 +
    sophistication.score * 0.1;

  return {
    score: Math.min(1, score),
    signals: {
      lengthAsymmetry: length.score,
      qualifierAsymmetry: qualifier.score,
      absoluteTermTrap: absolute.score,
      specificityAsymmetry: specificity.score,
      parentheticalTell: parenthetical.score,
      sophisticationAsymmetry: sophistication.score,
    },
    issues,
    likelyCorrectByTell,
  };
}

/**
 * Whether the tells point at the *actual* correct answer — the key exploitability
 * signal. If the tells predict the correct option, the item is gameable.
 */
export function validateAgainstCorrect(
  options: Option[],
  profile: GuessabilityProfile,
): { tellsMatchCorrect: boolean; actualCorrectLabel: string | null; confidence: number } {
  const correctOption = options.find((o) => o.isCorrect);
  const actualCorrectLabel = correctOption?.label || null;

  if (!actualCorrectLabel || !profile.likelyCorrectByTell) {
    return { tellsMatchCorrect: false, actualCorrectLabel, confidence: 0 };
  }
  return {
    tellsMatchCorrect: profile.likelyCorrectByTell === actualCorrectLabel,
    actualCorrectLabel,
    confidence: profile.score,
  };
}

export type GuessabilitySeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** Map a guessability score to a coarse severity band for reporting. */
export function getGuessabilitySeverity(score: number): GuessabilitySeverity {
  if (score < 0.1) return 'none';
  if (score < 0.25) return 'low';
  if (score < 0.45) return 'medium';
  if (score < 0.65) return 'high';
  return 'critical';
}

/**
 * Quality gate: run guessability over a question and emit issues. The gate
 * escalates to `block` when the tells correctly predict the real answer (the item
 * is genuinely exploitable), otherwise warns/infos by severity band.
 */
export const checkGuessability: QualityGate<AuthoringQuestion> = (q) => {
  const profile = analyzeGuessability(q.options);
  const severity = getGuessabilitySeverity(profile.score);
  if (severity === 'none') return [];

  const { tellsMatchCorrect } = validateAgainstCorrect(q.options, profile);
  const issues: QualityIssue[] = [];

  if (tellsMatchCorrect) {
    issues.push({
      check: 'guessable',
      severity: 'block',
      message: `test-taking tells point at the correct answer (score ${profile.score.toFixed(2)}, ${severity}): ${profile.issues.join('; ')}`,
    });
    return issues;
  }

  issues.push({
    check: 'guessable',
    severity: severity === 'critical' || severity === 'high' ? 'warn' : 'info',
    message: `guessability ${severity} (score ${profile.score.toFixed(2)}): ${profile.issues.join('; ') || 'option-shape asymmetry'}`,
  });
  return issues;
};
